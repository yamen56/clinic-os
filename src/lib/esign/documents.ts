import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { logDocEvent } from "./events";
import {
  buildSnapshot,
  documentHash,
  renderTokens,
  sanitizeHtml,
  type MergeValue,
} from "./render";
import {
  loadFieldDefinitions,
  loadMergeSources,
  resolveFields,
  tokensUsed,
  type ResolvedField,
} from "./fields";
import { AGE_OF_MAJORITY, STAFF_ROLE_KEYS, TERMINAL_STATUSES, type DocumentStatus } from "./constants";

/**
 * The document lifecycle.
 *
 * A document is mutable exactly once — while it is a draft. From the moment it
 * is sent or handed to a patient on a tablet, its content, its hash and every
 * merged value are frozen, and the only writes left are signatures, events, and
 * the terminal transitions (completed, declined, expired, voided).
 */

export type DocumentRow = {
  id: string;
  clinic_id: string;
  patient_id: string | null;
  template_id: string | null;
  template_version: number | null;
  source: "template" | "upload";
  title: string;
  language: "ar" | "en";
  status: DocumentStatus;
  signing_mode: "sequential" | "parallel";
  content_snapshot: string | null;
  source_pdf_path: string | null;
  final_pdf_path: string | null;
  content_hash: string | null;
  appointment_id: string | null;
  service_id: string | null;
  created_by: string | null;
  sent_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  declined_at: string | null;
  void_reason: string | null;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
};

export type SignerRow = {
  id: string;
  clinic_id: string;
  document_id: string;
  role_key: string;
  signing_order: number;
  is_required: boolean;
  display_name: string;
  phone_e164: string | null;
  user_id: string | null;
  relationship: string | null;
  status: "pending" | "viewed" | "signed" | "declined";
  link_opened_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  signature_svg_path: string | null;
  signature_png_path: string | null;
  typed_name: string | null;
  consent_confirmed: boolean;
  decline_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
  /** Only set when the clinic turned on the optional WhatsApp code. */
  otp_verified_at: string | null;
  signed_in_person: boolean;
  witnessed_by_user_id: string | null;
  field_answers: Record<string, unknown>;
};

export type SignerInput = {
  roleKey: string;
  order?: number;
  required?: boolean;
  displayName?: string;
  phone?: string | null;
  userId?: string | null;
  relationship?: string | null;
};

/** An in-person session holds the document; a forgotten tablet must not wedge it. */
export const LOCK_TIMEOUT_MINUTES = 30;

/**
 * Reserved `document_field_values` key holding a per-document rewrite of the
 * body. It lives in that table rather than in its own column because it is
 * exactly the same kind of thing as a merge override — a value that applies to
 * one document and never touches the template.
 */
export const BODY_OVERRIDE_KEY = "__body__";

export function isEditable(doc: { status: DocumentStatus }): boolean {
  return doc.status === "draft";
}

export function isTerminal(doc: { status: DocumentStatus }): boolean {
  return TERMINAL_STATUSES.has(doc.status);
}

/** True while a patient is holding a tablet on this document. */
export function isLocked(doc: DocumentRow, byUserId?: string | null): boolean {
  if (!doc.locked_by || !doc.locked_at) return false;
  const age = DateTime.now().diff(DateTime.fromJSDate(new Date(doc.locked_at)), "minutes").minutes;
  if (age > LOCK_TIMEOUT_MINUTES) return false;
  return byUserId ? doc.locked_by !== byUserId : true;
}

// ---------------------------------------------------------------- age & roles

export function isMinor(birthDate: string | Date | null | undefined): boolean {
  if (!birthDate) return false;
  const dob = DateTime.fromJSDate(new Date(birthDate));
  if (!dob.isValid) return false;
  return DateTime.now().diff(dob, "years").years < AGE_OF_MAJORITY;
}

/**
 * The signers a document starts with.
 *
 * Two things are decided here rather than left to the caller. A patient under
 * 18 always gains a guardian, because a clinic should not be able to forget it.
 * And staff roles are pre-resolved to a real person — the doctor on the
 * appointment, the clinic's owner — so the common case needs no picking at all.
 */
export async function buildDefaultSigners(
  c: PoolClient,
  args: {
    clinicId: string;
    signerConfig: { mode?: string; signers?: { role_key: string; required?: boolean; order?: number }[] };
    patient: { id: string; full_name: string; phone_e164: string | null; birth_date: string | null } | null;
    appointmentId?: string | null;
  }
): Promise<SignerInput[]> {
  const configured = args.signerConfig?.signers?.length
    ? args.signerConfig.signers
    : [{ role_key: "patient", required: true, order: 0 }];

  const owner = (
    await c.query(
      `select cm.user_id, u.full_name, u.phone_e164 from clinic_members cm
       join users u on u.id = cm.user_id
       where cm.clinic_id = $1 and cm.role = 'owner' and cm.active
       order by cm.created_at limit 1`,
      [args.clinicId]
    )
  ).rows[0];

  let apptDoctor: { user_id: string; full_name: string; phone_e164: string | null } | undefined;
  if (args.appointmentId) {
    apptDoctor = (
      await c.query(
        `select cm.user_id, u.full_name, u.phone_e164 from appointments a
         join clinic_members cm on cm.id = a.doctor_member_id
         join users u on u.id = cm.user_id
         where a.id = $1 and a.clinic_id = $2`,
        [args.appointmentId, args.clinicId]
      )
    ).rows[0];
  }

  const out: SignerInput[] = [];
  configured
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .forEach((s, i) => {
      const base: SignerInput = {
        roleKey: s.role_key,
        order: s.order ?? i,
        required: s.required !== false,
      };
      if (s.role_key === "patient" && args.patient) {
        out.push({
          ...base,
          displayName: args.patient.full_name,
          phone: args.patient.phone_e164,
        });
        return;
      }
      if (s.role_key === "doctor" && apptDoctor) {
        out.push({ ...base, displayName: apptDoctor.full_name, userId: apptDoctor.user_id });
        return;
      }
      if (s.role_key === "clinic_owner" && owner) {
        out.push({ ...base, displayName: owner.full_name, userId: owner.user_id });
        return;
      }
      out.push(base);
    });

  // A minor's guardian is not optional, and not something staff should have to
  // remember to add.
  if (
    args.patient &&
    isMinor(args.patient.birth_date) &&
    !out.some((s) => s.roleKey === "guardian")
  ) {
    const maxOrder = out.reduce((m, s) => Math.max(m, s.order ?? 0), 0);
    out.push({ roleKey: "guardian", order: maxOrder + 1, required: true });
  }

  return out;
}

// ---------------------------------------------------------------- merge table

export type MergeTable = {
  fields: ResolvedField[];
  /** Keys the body actually references. */
  used: string[];
  /** Referenced keys with no value and no override. Sending is blocked on these. */
  missing: ResolvedField[];
};

/**
 * Builds the merge table for a draft: every visible definition resolved, plus
 * the per-document overrides and one-off fields already saved on it.
 */
export async function buildMergeTable(
  c: PoolClient,
  args: {
    clinicId: string;
    documentId?: string | null;
    body: string;
    locale: "ar" | "en";
    patientId?: string | null;
    appointmentId?: string | null;
    serviceId?: string | null;
  }
): Promise<MergeTable> {
  // Sequential: these share one connection, so node-pg would serialise them
  // regardless, and overlapping queries on one client are deprecated in pg 8.22.
  const defs = await loadFieldDefinitions(c, args.clinicId);
  const sources = await loadMergeSources(c, args.clinicId, {
    patientId: args.patientId,
    appointmentId: args.appointmentId,
    serviceId: args.serviceId,
  });

  const resolved = resolveFields(defs, sources, args.locale);
  const byKey = new Map(resolved.map((f) => [f.key, f]));

  if (args.documentId) {
    const saved = await c.query(
      `select field_key, label, label_ar, value, is_override, is_one_off, sort
       from document_field_values where document_id = $1 and field_key <> $2 order by sort`,
      [args.documentId, BODY_OVERRIDE_KEY]
    );
    for (const row of saved.rows) {
      const existing = byKey.get(row.field_key);
      byKey.set(row.field_key, {
        key: row.field_key,
        label: row.label || existing?.label || row.field_key,
        labelAr: row.label_ar || existing?.labelAr || row.label || row.field_key,
        value: row.value ?? "",
        isOverride: row.is_override,
        isOneOff: row.is_one_off,
        scope: existing?.scope ?? "patient",
        fixHint: row.value ? null : (existing?.fixHint ?? "patient"),
      });
    }
  }

  const fields = [...byKey.values()];
  const used = tokensUsed(args.body);
  const missing = used
    .map((k) => byKey.get(k))
    .filter((f): f is ResolvedField => !!f && !f.value);

  // A token nobody defined is also a blocker — it would render as a gap.
  for (const k of used) {
    if (!byKey.has(k)) {
      missing.push({
        key: k,
        label: k,
        labelAr: k,
        value: "",
        isOverride: false,
        isOneOff: false,
        scope: "patient",
        fixHint: null,
      });
    }
  }

  return { fields, used, missing };
}

// ------------------------------------------------------------------- creation

export async function createDocument(
  c: PoolClient,
  args: {
    clinicId: string;
    /** Null only when an automation raised the document and the clinic has no owner. */
    userId: string | null;
    patientId?: string | null;
    templateId?: string | null;
    title: string;
    language: "ar" | "en";
    source?: "template" | "upload";
    sourcePdfPath?: string | null;
    signingMode?: "sequential" | "parallel";
    appointmentId?: string | null;
    serviceId?: string | null;
    signers: SignerInput[];
    supersedesDocumentId?: string | null;
  }
): Promise<string> {
  const template = args.templateId
    ? (
        await c.query(`select id, version from document_templates where id = $1 and clinic_id = $2`, [
          args.templateId,
          args.clinicId,
        ])
      ).rows[0]
    : null;

  const doc = await c.query(
    `insert into documents
       (clinic_id, patient_id, template_id, template_version, source, title, language,
        signing_mode, appointment_id, service_id, created_by, supersedes_document_id, source_pdf_path)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id`,
    [
      args.clinicId,
      args.patientId ?? null,
      template?.id ?? null,
      template?.version ?? null,
      args.source ?? "template",
      args.title.slice(0, 200),
      args.language,
      args.signingMode ?? "sequential",
      args.appointmentId ?? null,
      args.serviceId ?? null,
      args.userId ?? null,
      args.supersedesDocumentId ?? null,
      args.sourcePdfPath ?? null,
    ]
  );
  const documentId = doc.rows[0].id as string;

  await replaceSigners(c, args.clinicId, documentId, args.signers);

  // An uploaded template carries its field placement; copy it onto the document
  // so later edits to the template never move boxes on a document in flight.
  if (args.templateId && (args.source ?? "template") === "upload") {
    await c.query(
      `insert into document_fields
         (clinic_id, document_id, page_number, x, y, width, height, field_type,
          assigned_role_key, is_required, label, prefilled_value, sort)
       select clinic_id, $2, page_number, x, y, width, height, field_type,
              assigned_role_key, is_required, label, prefilled_value, sort
       from document_fields where template_id = $1`,
      [args.templateId, documentId]
    );
  }

  await logDocEvent(c, {
    clinicId: args.clinicId,
    documentId,
    type: "created",
    actorUserId: args.userId,
    actorKind: "staff",
    metadata: { title: args.title, templateId: args.templateId ?? null },
  });

  if (args.supersedesDocumentId) {
    await logDocEvent(c, {
      clinicId: args.clinicId,
      documentId: args.supersedesDocumentId,
      type: "superseded",
      actorUserId: args.userId,
      actorKind: "staff",
      metadata: { by: documentId },
    });
  }

  return documentId;
}

export async function replaceSigners(
  c: PoolClient,
  clinicId: string,
  documentId: string,
  signers: SignerInput[]
): Promise<void> {
  await c.query(`delete from document_signers where document_id = $1 and clinic_id = $2`, [
    documentId,
    clinicId,
  ]);
  let i = 0;
  for (const s of signers) {
    // A staff signer's name comes from their account, not from a text box —
    // nobody may sign on behalf of another.
    let displayName = s.displayName ?? "";
    if (s.userId) {
      const u = (await c.query(`select full_name from users where id = $1`, [s.userId])).rows[0];
      if (u) displayName = u.full_name;
    }
    await c.query(
      `insert into document_signers
         (clinic_id, document_id, role_key, signing_order, is_required, display_name,
          phone_e164, user_id, relationship)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        clinicId,
        documentId,
        s.roleKey,
        s.order ?? i,
        s.required !== false,
        displayName.slice(0, 120),
        s.phone ?? null,
        s.userId ?? null,
        s.relationship ? s.relationship.slice(0, 60) : null,
      ]
    );
    i++;
  }
}

// -------------------------------------------------------------------- freezing

/**
 * Freezes the document: renders the merged body, stores it, hashes it.
 *
 * Everything after this point reads `content_snapshot`. The template can be
 * rewritten, the patient's phone corrected, a field renamed — none of it
 * reaches a document that has already been frozen.
 */
export async function freezeDocument(
  c: PoolClient,
  clinicId: string,
  documentId: string
): Promise<{ snapshot: string; hash: string } | { error: string; missing?: string[] }> {
  const doc = (
    await c.query(`select * from documents where id = $1 and clinic_id = $2 for update`, [
      documentId,
      clinicId,
    ])
  ).rows[0] as DocumentRow | undefined;
  if (!doc) return { error: "not_found" };
  if (doc.content_snapshot && doc.content_hash) {
    return { snapshot: doc.content_snapshot, hash: doc.content_hash };
  }

  // Uploaded documents are frozen as the file itself; there is nothing to render.
  if (doc.source === "upload") {
    if (!doc.source_pdf_path) return { error: "no_source_pdf" };
    const hash = documentHash(`upload:${doc.source_pdf_path}:${doc.id}`);
    await c.query(`update documents set content_hash = $2 where id = $1`, [documentId, hash]);
    return { snapshot: "", hash };
  }

  const template = doc.template_id
    ? (
        await c.query(`select body, body_ar from document_templates where id = $1`, [doc.template_id])
      ).rows[0]
    : null;

  // Staff may rewrite the copy for one instance. That override, when present,
  // replaces the template body entirely — it is what they previewed and what
  // they intend to send.
  const bodyOverride = (
    await c.query(
      `select value from document_field_values where document_id = $1 and field_key = $2`,
      [documentId, BODY_OVERRIDE_KEY]
    )
  ).rows[0]?.value as string | undefined;

  const rawBody =
    bodyOverride?.trim() ||
    (doc.language === "ar"
      ? template?.body_ar || template?.body || ""
      : template?.body || template?.body_ar || "");
  if (!rawBody.trim()) return { error: "empty_body" };

  const table = await buildMergeTable(c, {
    clinicId,
    documentId,
    body: rawBody,
    locale: doc.language,
    patientId: doc.patient_id,
    appointmentId: doc.appointment_id,
    serviceId: doc.service_id,
  });
  if (table.missing.length) {
    return { error: "missing_fields", missing: table.missing.map((m) => m.key) };
  }

  const values = new Map<string, MergeValue>(
    table.fields.map((f) => [f.key, { value: f.value, isOverride: f.isOverride }])
  );

  // Persist every value the body used, so the document carries its own copy and
  // a field renamed tomorrow keeps the label it was signed under.
  let sort = 0;
  for (const key of table.used) {
    const f = table.fields.find((x) => x.key === key);
    if (!f) continue;
    await c.query(
      `insert into document_field_values
         (clinic_id, document_id, field_key, label, label_ar, value, is_override, is_one_off, sort)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (document_id, field_key) do update
         set label = excluded.label, label_ar = excluded.label_ar, value = excluded.value`,
      [clinicId, documentId, f.key, f.label, f.labelAr, f.value, f.isOverride, f.isOneOff, sort++]
    );
  }

  const clinic = (
    await c.query(
      `select name, name_ar, address, address_ar, phone_e164 from clinics where id = $1`,
      [clinicId]
    )
  ).rows[0];

  const bodyHtml = renderTokens(sanitizeHtml(rawBody), values, { markOverrides: false });
  const oneOffs = table.fields.filter((f) => f.isOneOff && !table.used.includes(f.key));

  const snapshot = buildSnapshot({
    title: doc.title,
    bodyHtml,
    clinicName: (doc.language === "ar" ? clinic.name_ar : null) || clinic.name,
    clinicAddress: (doc.language === "ar" ? clinic.address_ar : null) || clinic.address,
    clinicPhone: clinic.phone_e164,
    locale: doc.language,
    extraFields: oneOffs.map((f) => ({
      label: doc.language === "ar" ? f.labelAr : f.label,
      value: f.value,
    })),
  });
  const hash = documentHash(snapshot);

  await c.query(`update documents set content_snapshot = $2, content_hash = $3 where id = $1`, [
    documentId,
    snapshot,
    hash,
  ]);
  return { snapshot, hash };
}

/**
 * Recomputes the frozen content's hash and compares it to what was stored.
 *
 * Called before every signature. A mismatch means the stored document changed
 * after it was frozen, which is the one failure this whole module exists to
 * make impossible — so it refuses the signature and says so loudly.
 */
export function verifyHash(doc: Pick<DocumentRow, "content_snapshot" | "content_hash" | "source">): boolean {
  if (!doc.content_hash) return false;
  if (doc.source === "upload") return true; // the file is the document; see stampPdf
  if (!doc.content_snapshot) return false;
  return documentHash(doc.content_snapshot) === doc.content_hash;
}

// ------------------------------------------------------------------ signing turn

/**
 * Whose turn it is.
 *
 * Sequential means one at a time in `signing_order`; parallel means everyone at
 * once. Optional signers never hold the queue up — a witness who has not signed
 * must not stop a doctor being asked to countersign.
 */
export function signersDueNow(
  signers: SignerRow[],
  mode: "sequential" | "parallel"
): SignerRow[] {
  const pending = signers.filter((s) => s.status === "pending" || s.status === "viewed");
  if (!pending.length) return [];
  if (mode === "parallel") return pending;

  const ordered = [...pending].sort((a, b) => a.signing_order - b.signing_order);
  const firstOrder = ordered[0].signing_order;
  // Everyone sharing the lowest outstanding order goes at once — that is what
  // makes "both parents sign together" expressible inside a sequential flow.
  return ordered.filter((s) => s.signing_order === firstOrder);
}

export function isSignerDue(
  signers: SignerRow[],
  signerId: string,
  mode: "sequential" | "parallel"
): boolean {
  return signersDueNow(signers, mode).some((s) => s.id === signerId);
}

export async function loadSigners(
  c: PoolClient,
  documentId: string,
  clinicId: string
): Promise<SignerRow[]> {
  const r = await c.query(
    `select * from document_signers where document_id = $1 and clinic_id = $2
     order by signing_order, created_at`,
    [documentId, clinicId]
  );
  return r.rows as SignerRow[];
}

/** All required signers done. Optional ones may still be outstanding. */
export function allRequiredSigned(signers: SignerRow[]): boolean {
  const required = signers.filter((s) => s.is_required);
  return required.length > 0 && required.every((s) => s.status === "signed");
}

export function isStaffRole(roleKey: string, roles?: { key: string; is_staff: boolean }[]): boolean {
  const custom = roles?.find((r) => r.key === roleKey);
  if (custom) return custom.is_staff;
  return STAFF_ROLE_KEYS.has(roleKey);
}

// ------------------------------------------------------------------ transitions

export async function markSent(
  c: PoolClient,
  clinicId: string,
  documentId: string,
  expiresDays: number
): Promise<void> {
  await c.query(
    `update documents
        set status = case when status = 'draft' then 'sent' else status end,
            sent_at = coalesce(sent_at, now()),
            expires_at = coalesce(expires_at, now() + ($3 * interval '1 day'))
      where id = $1 and clinic_id = $2`,
    [documentId, clinicId, Math.min(90, Math.max(1, expiresDays))]
  );
}

/**
 * Recomputes status from the signers and returns the new one.
 *
 * Status is derived, never set by hand: a document is completed because every
 * required signer signed, not because some code path thought it should be.
 */
export async function refreshDocumentStatus(
  c: PoolClient,
  clinicId: string,
  documentId: string
): Promise<DocumentStatus> {
  const doc = (
    await c.query(`select * from documents where id = $1 and clinic_id = $2 for update`, [
      documentId,
      clinicId,
    ])
  ).rows[0] as DocumentRow;
  if (!doc || isTerminal(doc)) return doc?.status ?? "draft";

  const signers = await loadSigners(c, documentId, clinicId);

  if (signers.some((s) => s.status === "declined")) {
    await c.query(
      `update documents set status = 'declined', declined_at = coalesce(declined_at, now())
       where id = $1`,
      [documentId]
    );
    return "declined";
  }

  if (allRequiredSigned(signers)) {
    await c.query(
      `update documents set status = 'completed', completed_at = coalesce(completed_at, now())
       where id = $1`,
      [documentId]
    );
    await logDocEvent(c, { clinicId, documentId, type: "completed", actorKind: "system" });
    return "completed";
  }

  if (signers.some((s) => s.status === "signed")) {
    await c.query(`update documents set status = 'partially_signed' where id = $1`, [documentId]);
    return "partially_signed";
  }

  return doc.status;
}

export async function voidDocument(
  c: PoolClient,
  args: { clinicId: string; documentId: string; userId: string; reason: string }
): Promise<{ error?: string }> {
  const doc = (
    await c.query(`select status from documents where id = $1 and clinic_id = $2 for update`, [
      args.documentId,
      args.clinicId,
    ])
  ).rows[0];
  if (!doc) return { error: "not_found" };
  if (doc.status === "voided") return { error: "already_void" };
  if (!args.reason.trim()) return { error: "reason_required" };

  await c.query(
    `update documents set status = 'voided', void_reason = $3, voided_by = $4, voided_at = now()
     where id = $1 and clinic_id = $2`,
    [args.documentId, args.clinicId, args.reason.trim().slice(0, 500), args.userId]
  );
  await c.query(
    `update signing_tokens set revoked_at = coalesce(revoked_at, now()) where document_id = $1`,
    [args.documentId]
  );
  await logDocEvent(c, {
    clinicId: args.clinicId,
    documentId: args.documentId,
    type: "voided",
    actorUserId: args.userId,
    actorKind: "staff",
    metadata: { reason: args.reason.trim().slice(0, 500) },
  });
  return {};
}

// ----------------------------------------------------------------- in-person lock

export async function acquireLock(
  c: PoolClient,
  clinicId: string,
  documentId: string,
  userId: string
): Promise<{ ok: true } | { ok: false; heldBy: string }> {
  const doc = (
    await c.query(
      `select locked_by, locked_at, u.full_name as holder
       from documents d left join users u on u.id = d.locked_by
       where d.id = $1 and d.clinic_id = $2 for update of d`,
      [documentId, clinicId]
    )
  ).rows[0];
  if (!doc) return { ok: false, heldBy: "" };

  const stale =
    !doc.locked_at ||
    DateTime.now().diff(DateTime.fromJSDate(new Date(doc.locked_at)), "minutes").minutes >
      LOCK_TIMEOUT_MINUTES;

  if (doc.locked_by && doc.locked_by !== userId && !stale) {
    return { ok: false, heldBy: doc.holder ?? "" };
  }
  await c.query(`update documents set locked_by = $3, locked_at = now() where id = $1 and clinic_id = $2`, [
    documentId,
    clinicId,
    userId,
  ]);
  await logDocEvent(c, {
    clinicId,
    documentId,
    type: "locked",
    actorUserId: userId,
    actorKind: "staff",
  });
  return { ok: true };
}

export async function releaseLock(
  c: PoolClient,
  clinicId: string,
  documentId: string,
  userId: string
): Promise<void> {
  const r = await c.query(
    `update documents set locked_by = null, locked_at = null
     where id = $1 and clinic_id = $2 and (locked_by = $3 or locked_by is null)`,
    [documentId, clinicId, userId]
  );
  if (r.rowCount) {
    await logDocEvent(c, {
      clinicId,
      documentId,
      type: "unlocked",
      actorUserId: userId,
      actorKind: "staff",
    });
  }
}
