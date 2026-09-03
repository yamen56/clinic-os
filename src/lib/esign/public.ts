import type { PoolClient } from "pg";
import { withSystem } from "../db";
import { lookupToken, type TokenRow } from "./tokens";
import { isSignerDue, loadSigners, isTerminal, type DocumentRow, type SignerRow } from "./documents";

/**
 * The public signing page's view of the world.
 *
 * Everything here runs in the system context, because the visitor has no
 * session — the token is the authorisation. That makes the shape of what is
 * returned a security decision, not just an ergonomic one: it carries one
 * document, one signer, and the clinic's branding. No patient list, no other
 * documents, nothing about the clinic beyond what a letterhead would show.
 */

export type SignState =
  | "ready"
  | "needs_code"
  | "already_signed"
  | "declined"
  | "expired"
  | "revoked"
  | "used"
  | "voided"
  | "not_found"
  | "throttled"
  | "not_your_turn";

export type PublicSigningView = {
  state: SignState;
  /** Present for every state except not_found, so even a dead end can be branded. */
  clinic: {
    name: string;
    slug: string;
    logoPath: string | null;
    brandColor: string;
    phone: string | null;
    /*
      Carried so the signing screen says what the signature actually means. A
      clinic signing with Clinicti is agreeing to a commercial contract, and the
      consent-to-treatment wording would be actively misleading about that — see
      `sign.consentLabel` in i18n/vocab.ts, an override written for this screen
      that until now never reached it.
    */
    vocabulary: "medical" | "agency";
  } | null;
  document: {
    id: string;
    title: string;
    language: "ar" | "en";
    snapshot: string;
    source: "template" | "upload";
    /** Only set for uploaded documents; the page renders it as a PDF. */
    pdfUrl: string | null;
    status: string;
    expiresAt: string | null;
  } | null;
  signer: {
    id: string;
    displayName: string;
    roleKey: string;
    status: string;
  } | null;
  /** Where they got to last time, so an abandoned link resumes in place. */
  session: {
    lastStep: number;
    scrolledToEnd: boolean;
    consentConfirmed: boolean;
    partialSignature: unknown;
    fieldAnswers: Record<string, unknown>;
  } | null;
  extraQuestions: {
    key: string;
    label: string;
    label_ar: string;
    type: string;
    required: boolean;
    options: string[];
    roles: string[];
  }[];
  /** Named when someone else has to sign first, so the page can say so. */
  waitingOn: string | null;
  /** The next signer, for the confirmation screen. */
  nextSignerName: string | null;
  tokenId: string | null;
};

const EMPTY: PublicSigningView = {
  state: "not_found",
  clinic: null,
  document: null,
  signer: null,
  session: null,
  extraQuestions: [],
  waitingOn: null,
  nextSignerName: null,
  tokenId: null,
};

/**
 * Resolves a token to everything the page needs.
 *
 * `countAttempt` exists because the same resolution runs on a GET (the patient
 * opening the page) and inside the POST that records a signature. Counting the
 * POST as an attempt would punish a normal signature, so only the page view
 * increments.
 */
export async function loadSigningView(
  token: string,
  opts: { countAttempt?: boolean } = {}
): Promise<PublicSigningView> {
  return withSystem(async (c) => resolveIn(c, token, opts));
}

export async function resolveIn(
  c: PoolClient,
  token: string,
  opts: { countAttempt?: boolean } = {}
): Promise<PublicSigningView> {
  const lookup = opts.countAttempt === false
    ? await lookupWithoutCounting(c, token)
    : await lookupToken(c, token);

  // A dead token still resolves its document, so the page it lands on can carry
  // the clinic's branding and a working next action instead of a bare error.
  if (!lookup.row) return EMPTY;
  const base = await loadContextFor(c, lookup.row);
  if (!base) return EMPTY;
  if (lookup.ok) return base.view;

  const map: Record<string, SignState> = {
    expired: "expired",
    revoked: "revoked",
    used: "used",
    throttled: "throttled",
    not_found: "not_found",
  };
  /*
    A used token whose signer did sign gets the friendly message rather than
    "invalid link" — and that is the common case, because people reopen the
    WhatsApp message afterwards to check it worked.
  */
  const state =
    lookup.reason === "used" && base.signer.status === "signed"
      ? "already_signed"
      : (map[lookup.reason] ?? "not_found");
  return { ...base.view, state };
}

async function lookupWithoutCounting(
  c: PoolClient,
  token: string
): Promise<
  | { ok: true; row: TokenRow }
  | { ok: false; reason: "not_found" | "expired" | "revoked" | "used" | "throttled"; row?: TokenRow }
> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(token).digest("hex");
  const r = await c.query(
    `select id, clinic_id, document_id, signer_id, expires_at, used_at, revoked_at, attempt_count
     from signing_tokens where token_hash = $1`,
    [hash]
  );
  const row = r.rows[0] as TokenRow | undefined;
  if (!row) return { ok: false, reason: "not_found" };
  if (row.revoked_at) return { ok: false, reason: "revoked", row };
  if (row.used_at) return { ok: false, reason: "used", row };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: "expired", row };
  return { ok: true, row };
}

async function loadContextFor(
  c: PoolClient,
  row: TokenRow
): Promise<{ view: PublicSigningView; doc: DocumentRow; signer: SignerRow } | null> {
  const doc = (
    await c.query(
      `select d.*, cl.name, cl.name_ar, cl.slug, cl.logo_path, cl.brand_color,
              cl.vocabulary, cl.phone_e164 as clinic_phone, t.fields_schema
       from documents d
       join clinics cl on cl.id = d.clinic_id
       left join document_templates t on t.id = d.template_id
       where d.id = $1`,
      [row.document_id]
    )
  ).rows[0];
  if (!doc) return null;

  const signers = await loadSigners(c, doc.id, doc.clinic_id);
  const signer = signers.find((s) => s.id === row.signer_id);
  if (!signer) return null;

  const session = (
    await c.query(
      `select last_step, scrolled_to_end, consent_confirmed, partial_signature, field_answers
       from signing_sessions where signer_id = $1`,
      [signer.id]
    )
  ).rows[0];

  const isAr = doc.language === "ar";
  const due = isSignerDue(signers, signer.id, doc.signing_mode);
  const outstandingBefore = signers
    .filter(
      (s) =>
        s.status !== "signed" &&
        s.is_required &&
        s.id !== signer.id &&
        (doc.signing_mode === "sequential" ? s.signing_order < signer.signing_order : false)
    )
    .sort((a, b) => a.signing_order - b.signing_order)[0];

  const nextAfterMe = signers
    .filter((s) => s.status !== "signed" && s.is_required && s.id !== signer.id)
    .sort((a, b) => a.signing_order - b.signing_order)[0];

  let state: SignState = "ready";
  if (doc.status === "voided") state = "voided";
  else if (signer.status === "signed") state = "already_signed";
  else if (signer.status === "declined") state = "declined";
  else if (doc.status === "declined") state = "declined";
  else if (doc.status === "expired") state = "expired";
  else if (isTerminal(doc)) state = "already_signed";
  else if (!due) state = "not_your_turn";

  const clinicRow = (
    await c.query(`select esign_require_code from clinics where id = $1`, [doc.clinic_id])
  ).rows[0];
  // The code path is off by default; when a clinic turns it on, a signer who has
  // not verified yet is stopped here rather than at submit time.
  if (state === "ready" && clinicRow?.esign_require_code && !signer.otp_verified_at) {
    state = "needs_code";
  }

  return {
    doc: doc as DocumentRow,
    signer,
    view: {
      state,
      clinic: {
        name: (isAr ? doc.name_ar : null) || doc.name,
        slug: doc.slug,
        logoPath: doc.logo_path,
        brandColor: doc.brand_color,
        vocabulary: doc.vocabulary === "agency" ? "agency" : "medical",
        phone: doc.clinic_phone,
      },
      document: {
        id: doc.id,
        title: doc.title,
        language: doc.language,
        snapshot: doc.content_snapshot ?? "",
        source: doc.source,
        // The token authorises the file, so the URL carries it rather than a
        // storage path — the visitor never learns where anything is stored.
        pdfUrl: doc.source === "upload" ? "pdf" : null,
        status: doc.status,
        expiresAt: doc.expires_at ? new Date(doc.expires_at).toISOString() : null,
      },
      signer: {
        id: signer.id,
        displayName: signer.display_name,
        roleKey: signer.role_key,
        status: signer.status,
      },
      session: session
        ? {
            lastStep: Number(session.last_step) || 1,
            scrolledToEnd: !!session.scrolled_to_end,
            consentConfirmed: !!session.consent_confirmed,
            partialSignature: session.partial_signature ?? null,
            fieldAnswers: (session.field_answers ?? {}) as Record<string, unknown>,
          }
        : null,
      extraQuestions: ((doc.fields_schema ?? []) as PublicSigningView["extraQuestions"]).filter(
        (q) => !q.roles?.length || q.roles.includes(signer.role_key)
      ),
      waitingOn: outstandingBefore?.display_name ?? null,
      nextSignerName: nextAfterMe?.display_name ?? null,
      tokenId: row.id,
    },
  };
}

/** Persists where a signer got to. Called as they move through the steps. */
export async function saveSigningSession(
  c: PoolClient,
  args: {
    clinicId: string;
    documentId: string;
    signerId: string;
    lastStep: number;
    scrolledToEnd?: boolean;
    consentConfirmed?: boolean;
    partialSignature?: unknown;
    fieldAnswers?: Record<string, unknown>;
  }
): Promise<void> {
  await c.query(
    `insert into signing_sessions
       (signer_id, clinic_id, document_id, last_step, scrolled_to_end, consent_confirmed,
        partial_signature, field_answers)
     values ($1, $2, $3, $4, coalesce($5, false), coalesce($6, false), $7, coalesce($8, '{}'::jsonb))
     on conflict (signer_id) do update set
       last_step = greatest(signing_sessions.last_step, excluded.last_step),
       scrolled_to_end = signing_sessions.scrolled_to_end or excluded.scrolled_to_end,
       consent_confirmed = excluded.consent_confirmed,
       partial_signature = coalesce(excluded.partial_signature, signing_sessions.partial_signature),
       field_answers = excluded.field_answers`,
    [
      args.signerId,
      args.clinicId,
      args.documentId,
      Math.min(3, Math.max(1, Math.round(args.lastStep))),
      args.scrolledToEnd ?? null,
      args.consentConfirmed ?? null,
      args.partialSignature ? JSON.stringify(args.partialSignature) : null,
      args.fieldAnswers ? JSON.stringify(args.fieldAnswers) : null,
    ]
  );
}
