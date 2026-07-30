import type { PoolClient } from "pg";
import { saveFile } from "../storage";
import { notifyClinicStaff, notifyUser } from "../notify";
import { logDocEvent } from "./events";
import {
  isSignerDue,
  isTerminal,
  loadSigners,
  refreshDocumentStatus,
  verifyHash,
  type DocumentRow,
  type SignerRow,
} from "./documents";

/**
 * Recording a signature.
 *
 * Every path into this module — the tablet in the clinic, a link on a phone, a
 * doctor countersigning from the workspace — lands on `recordSignature`, so the
 * integrity check, the audit event and the status transition cannot be skipped
 * by adding a new entry point later.
 */

export type SignatureInput = {
  /** PNG data URL of the drawn or typed signature. Required. */
  pngDataUrl: string;
  /** SVG path data, when the pad produced it. Stored alongside for re-rendering at any size. */
  svg?: string | null;
  /** Set when the signer chose to type their name rather than draw it. */
  typedName?: string | null;
  consentConfirmed: boolean;
  fieldAnswers?: Record<string, unknown>;
};

const MAX_SIGNATURE_BYTES = 1_500_000;

export function decodeSignaturePng(dataUrl: string): Buffer | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl ?? "");
  if (!m) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.length > MAX_SIGNATURE_BYTES) return null;
  // PNG magic number: anything else is not the file it claims to be.
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return buf;
}

export type SignResult =
  | { ok: true; documentStatus: string; completed: boolean }
  | {
      ok: false;
      error:
        | "not_found"
        | "terminal"
        | "not_your_turn"
        | "already_signed"
        | "consent_required"
        | "bad_signature"
        | "hash_mismatch"
        | "missing_fields";
      detail?: string;
    };

/**
 * Refuses the signature and raises the alarm.
 *
 * A hash mismatch means the frozen document is not the document that was
 * frozen. There is no safe way to continue, and there is no one for whom this
 * is routine — the clinic owner and the agency both hear about it.
 */
async function alertHashMismatch(
  c: PoolClient,
  doc: DocumentRow,
  signer: SignerRow
): Promise<void> {
  await logDocEvent(c, {
    clinicId: doc.clinic_id,
    documentId: doc.id,
    signerId: signer.id,
    type: "hash_mismatch",
    actorKind: "system",
    metadata: { storedHash: doc.content_hash, signer: signer.display_name },
  });
  await notifyClinicStaff(c, doc.clinic_id, {
    kind: "document_integrity",
    title: "Document integrity check failed",
    body: `"${doc.title}" could not be signed: its stored content no longer matches the copy that was frozen. The signature was refused.`,
    url: `/c/_/documents/${doc.id}`,
    roles: ["owner"],
  });
  const admins = await c.query(`select id from users where is_super_admin`);
  for (const a of admins.rows) {
    await notifyUser(c, a.id, {
      clinicId: doc.clinic_id,
      kind: "document_integrity",
      title: "Document integrity check failed",
      body: `Document ${doc.id} in clinic ${doc.clinic_id} failed its hash check.`,
    });
  }
}

export async function recordSignature(
  c: PoolClient,
  args: {
    clinicId: string;
    documentId: string;
    signerId: string;
    input: SignatureInput;
    ip?: string | null;
    userAgent?: string | null;
    inPerson?: boolean;
    witnessUserId?: string | null;
    /** Staff signing from the workspace; recorded as the actor on the event. */
    actorUserId?: string | null;
  }
): Promise<SignResult> {
  const doc = (
    await c.query(`select * from documents where id = $1 and clinic_id = $2 for update`, [
      args.documentId,
      args.clinicId,
    ])
  ).rows[0] as DocumentRow | undefined;
  if (!doc) return { ok: false, error: "not_found" };
  if (isTerminal(doc)) return { ok: false, error: "terminal", detail: doc.status };

  const signers = await loadSigners(c, args.documentId, args.clinicId);
  const signer = signers.find((s) => s.id === args.signerId);
  if (!signer) return { ok: false, error: "not_found" };
  if (signer.status === "signed") return { ok: false, error: "already_signed" };
  if (!isSignerDue(signers, signer.id, doc.signing_mode)) {
    return { ok: false, error: "not_your_turn" };
  }
  if (!args.input.consentConfirmed) return { ok: false, error: "consent_required" };

  if (!verifyHash(doc)) {
    await alertHashMismatch(c, doc, signer);
    return { ok: false, error: "hash_mismatch" };
  }

  const png = decodeSignaturePng(args.input.pngDataUrl);
  if (!png) return { ok: false, error: "bad_signature" };

  // Required inputs the template asks each signer for.
  const template = doc.template_id
    ? (await c.query(`select fields_schema from document_templates where id = $1`, [doc.template_id]))
        .rows[0]
    : null;
  const schema = (template?.fields_schema ?? []) as {
    key: string;
    required?: boolean;
    roles?: string[];
  }[];
  const answers = args.input.fieldAnswers ?? {};
  const missing = schema
    .filter((f) => f.required && (!f.roles?.length || f.roles.includes(signer.role_key)))
    .filter((f) => {
      const v = answers[f.key];
      return v === undefined || v === null || String(v).trim() === "";
    });
  if (missing.length) {
    return { ok: false, error: "missing_fields", detail: missing.map((m) => m.key).join(",") };
  }

  const saved = await saveFile(
    args.clinicId,
    "signatures",
    `${args.signerId}.png`,
    png
  );
  let svgPath: string | null = null;
  if (args.input.svg && args.input.svg.length < 400_000) {
    const svg = await saveFile(
      args.clinicId,
      "signatures",
      `${args.signerId}.svg`,
      Buffer.from(args.input.svg, "utf8")
    );
    svgPath = svg.storagePath;
  }

  await c.query(
    `update document_signers
        set status = 'signed', signed_at = now(),
            signature_png_path = $3, signature_svg_path = $4, typed_name = $5,
            consent_confirmed = true, ip_address = $6, user_agent = $7,
            signed_in_person = $8, witnessed_by_user_id = $9, field_answers = $10
      where id = $1 and clinic_id = $2`,
    [
      args.signerId,
      args.clinicId,
      saved.storagePath,
      svgPath,
      args.input.typedName?.slice(0, 120) ?? null,
      args.ip ?? null,
      args.userAgent?.slice(0, 400) ?? null,
      !!args.inPerson,
      args.witnessUserId ?? null,
      JSON.stringify(answers),
    ]
  );

  await logDocEvent(c, {
    clinicId: args.clinicId,
    documentId: args.documentId,
    signerId: args.signerId,
    type: "signed",
    actorUserId: args.actorUserId ?? null,
    actorKind: args.actorUserId ? "staff" : "signer",
    ip: args.ip,
    userAgent: args.userAgent,
    metadata: {
      role: signer.role_key,
      method: args.inPerson ? "in_clinic" : "remote",
      typed: !!args.input.typedName,
    },
  });

  // Answers are part of the record, not just of the signature.
  for (const [key, value] of Object.entries(answers)) {
    await logDocEvent(c, {
      clinicId: args.clinicId,
      documentId: args.documentId,
      signerId: args.signerId,
      type: "field_completed",
      actorKind: "signer",
      metadata: { key, value: String(value).slice(0, 200) },
    });
  }

  await c.query(`delete from signing_sessions where signer_id = $1`, [args.signerId]);

  const status = await refreshDocumentStatus(c, args.clinicId, args.documentId);
  return { ok: true, documentStatus: status, completed: status === "completed" };
}

export async function declineDocument(
  c: PoolClient,
  args: {
    clinicId: string;
    documentId: string;
    signerId: string;
    reason?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    actorUserId?: string | null;
  }
): Promise<{ ok: boolean; error?: string }> {
  const doc = (
    await c.query(`select * from documents where id = $1 and clinic_id = $2 for update`, [
      args.documentId,
      args.clinicId,
    ])
  ).rows[0] as DocumentRow | undefined;
  if (!doc) return { ok: false, error: "not_found" };
  if (isTerminal(doc)) return { ok: false, error: "terminal" };

  const r = await c.query(
    `update document_signers
        set status = 'declined', decline_reason = $3, ip_address = $4, user_agent = $5
      where id = $1 and clinic_id = $2 and status <> 'signed'`,
    [
      args.signerId,
      args.clinicId,
      args.reason?.slice(0, 500) ?? null,
      args.ip ?? null,
      args.userAgent?.slice(0, 400) ?? null,
    ]
  );
  if (!r.rowCount) return { ok: false, error: "not_found" };

  await logDocEvent(c, {
    clinicId: args.clinicId,
    documentId: args.documentId,
    signerId: args.signerId,
    type: "declined",
    actorUserId: args.actorUserId ?? null,
    actorKind: args.actorUserId ? "staff" : "signer",
    ip: args.ip,
    userAgent: args.userAgent,
    metadata: { reason: args.reason?.slice(0, 500) ?? "" },
  });
  await c.query(
    `update signing_tokens set revoked_at = coalesce(revoked_at, now()) where document_id = $1`,
    [args.documentId]
  );
  await refreshDocumentStatus(c, args.clinicId, args.documentId);
  return { ok: true };
}

/** Marks that the signer opened the document. Idempotent; the first time is what matters. */
export async function markViewed(
  c: PoolClient,
  args: {
    clinicId: string;
    documentId: string;
    signerId: string;
    ip?: string | null;
    userAgent?: string | null;
    opened?: boolean;
  }
): Promise<void> {
  const r = await c.query(
    `update document_signers
        set status = case when status = 'pending' then 'viewed' else status end,
            viewed_at = coalesce(viewed_at, now()),
            link_opened_at = case when $3 then coalesce(link_opened_at, now()) else link_opened_at end
      where id = $1 and clinic_id = $2 and viewed_at is null
      returning id`,
    [args.signerId, args.clinicId, !!args.opened]
  );
  if (!r.rowCount) return;
  if (args.opened) {
    await logDocEvent(c, {
      clinicId: args.clinicId,
      documentId: args.documentId,
      signerId: args.signerId,
      type: "link_opened",
      actorKind: "signer",
      ip: args.ip,
      userAgent: args.userAgent,
    });
  }
  await logDocEvent(c, {
    clinicId: args.clinicId,
    documentId: args.documentId,
    signerId: args.signerId,
    type: "viewed",
    actorKind: "signer",
    ip: args.ip,
    userAgent: args.userAgent,
  });
}

/** A staff member's saved signature, drawn once and reused. */
export async function saveStaffSignature(
  c: PoolClient,
  args: { clinicId: string; userId: string; pngDataUrl: string; svg?: string | null }
): Promise<{ ok: boolean; error?: string }> {
  const png = decodeSignaturePng(args.pngDataUrl);
  if (!png) return { ok: false, error: "bad_signature" };
  const saved = await saveFile(args.clinicId, "signatures/staff", `${args.userId}.png`, png);
  let svgPath: string | null = null;
  if (args.svg && args.svg.length < 400_000) {
    const s = await saveFile(
      args.clinicId,
      "signatures/staff",
      `${args.userId}.svg`,
      Buffer.from(args.svg, "utf8")
    );
    svgPath = s.storagePath;
  }
  await c.query(
    `update users set signature_png_path = $2, signature_svg_path = coalesce($3, signature_svg_path)
     where id = $1`,
    [args.userId, saved.storagePath, svgPath]
  );
  return { ok: true };
}
