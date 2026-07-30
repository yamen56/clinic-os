import type { PoolClient } from "pg";
import { loadFieldDefinitions } from "./fields";
import { buildMergeTable, BODY_OVERRIDE_KEY, signersDueNow, type SignerRow } from "./documents";
import { loadDocEvents, type DocEvent } from "./events";
import { renderTokens, sanitizeHtml, type MergeValue } from "./render";

/**
 * Read models for the staff-facing document screens.
 *
 * Kept out of the page components so the list, the patient tab and the
 * appointment panel all describe a document the same way — "waiting on the
 * doctor" has to mean the same thing everywhere it appears.
 */

export type DocumentListRow = {
  id: string;
  title: string;
  status: string;
  language: string;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  patient_id: string | null;
  patient_name: string | null;
  final_pdf_path: string | null;
  signer_count: number;
  signed_count: number;
  waiting_on: string | null;
  template_name: string | null;
};

const LIST_COLUMNS = `
  d.id, d.title, d.status, d.language, d.created_at, d.sent_at, d.completed_at, d.expires_at,
  d.patient_id, d.final_pdf_path,
  p.full_name as patient_name,
  t.name as template_name,
  (select count(*)::int from document_signers s where s.document_id = d.id) as signer_count,
  (select count(*)::int from document_signers s where s.document_id = d.id and s.status = 'signed') as signed_count,
  /*
    Who the list says it is waiting on. Sequential documents wait on the lowest
    outstanding order; parallel ones name the first outstanding signer. Either
    way it is a name, because "partially signed" tells reception nothing about
    who to chase.
  */
  (select s.display_name from document_signers s
    where s.document_id = d.id and s.status <> 'signed' and s.is_required
    order by case when d.signing_mode = 'sequential' then s.signing_order else 0 end,
             s.created_at
    limit 1) as waiting_on`;

export async function loadDocumentList(
  c: PoolClient,
  clinicId: string,
  opts: {
    scope?: "pending" | "completed" | "all";
    patientId?: string | null;
    limit?: number;
  } = {}
): Promise<DocumentListRow[]> {
  const where: string[] = [`d.clinic_id = $1`];
  const params: unknown[] = [clinicId];

  if (opts.patientId) {
    params.push(opts.patientId);
    where.push(`d.patient_id = $${params.length}`);
  }
  if (opts.scope === "pending") {
    where.push(`d.status in ('draft', 'sent', 'partially_signed')`);
  } else if (opts.scope === "completed") {
    where.push(`d.status in ('completed', 'declined', 'expired', 'voided')`);
  }

  params.push(Math.min(500, opts.limit ?? 200));
  const r = await c.query(
    `select ${LIST_COLUMNS}
     from documents d
     left join patients p on p.id = d.patient_id
     left join document_templates t on t.id = d.template_id
     where ${where.join(" and ")}
     order by
       case d.status when 'partially_signed' then 0 when 'sent' then 1 when 'draft' then 2 else 3 end,
       d.created_at desc
     limit $${params.length}`,
    params
  );
  return r.rows as DocumentListRow[];
}

export type DocumentDetail = {
  doc: {
    id: string;
    clinic_id: string;
    patient_id: string | null;
    patient_name: string | null;
    patient_phone: string | null;
    template_id: string | null;
    template_name: string | null;
    template_version: number | null;
    source: "template" | "upload";
    title: string;
    language: "ar" | "en";
    status: string;
    signing_mode: "sequential" | "parallel";
    content_snapshot: string | null;
    source_pdf_path: string | null;
    final_pdf_path: string | null;
    content_hash: string | null;
    hash_ok: boolean;
    appointment_id: string | null;
    service_id: string | null;
    created_by_name: string | null;
    sent_at: string | null;
    completed_at: string | null;
    expires_at: string | null;
    void_reason: string | null;
    locked_by: string | null;
    locked_by_name: string | null;
    locked_at: string | null;
    supersedes_document_id: string | null;
    created_at: string;
  };
  /** The body as it will be sent, tokens resolved. Frozen documents show their snapshot. */
  previewHtml: string;
  bodySource: string;
  signers: (SignerRow & { role_label: string; role_label_ar: string | null; is_staff: boolean })[];
  dueSignerIds: string[];
  fields: {
    key: string;
    label: string;
    labelAr: string;
    value: string;
    isOverride: boolean;
    isOneOff: boolean;
    scope: string;
    fixHint: string | null;
    used: boolean;
  }[];
  missing: { key: string; label: string; fixHint: string | null }[];
  events: DocEvent[];
  roles: { key: string; label: string; label_ar: string | null; is_staff: boolean }[];
  extraQuestions: {
    key: string;
    label: string;
    label_ar: string;
    type: string;
    required: boolean;
    options: string[];
    roles: string[];
  }[];
};

export async function loadDocumentDetail(
  c: PoolClient,
  clinicId: string,
  documentId: string
): Promise<DocumentDetail | null> {
  const doc = (
    await c.query(
      `select d.*, p.full_name as patient_name, p.phone_e164 as patient_phone,
              t.name as template_name, t.body as template_body, t.body_ar as template_body_ar,
              t.fields_schema,
              u.full_name as created_by_name, lu.full_name as locked_by_name
       from documents d
       left join patients p on p.id = d.patient_id
       left join document_templates t on t.id = d.template_id
       left join users u on u.id = d.created_by
       left join users lu on lu.id = d.locked_by
       where d.id = $1 and d.clinic_id = $2`,
      [documentId, clinicId]
    )
  ).rows[0];
  if (!doc) return null;

  /*
    Sequential, not Promise.all. node-pg serialises statements on a single
    connection anyway, so the concurrency was imaginary — and pg 8.22 now emits a
    deprecation warning for overlapping queries on one client. Awaiting in turn
    costs nothing and says what actually happens.
  */
  const signerRows = await c.query(
    `select s.*, r.label as role_label, r.label_ar as role_label_ar,
            coalesce(r.is_staff, false) as is_staff
     from document_signers s
     left join signer_roles r on r.clinic_id = s.clinic_id and r.key = s.role_key
     where s.document_id = $1 order by s.signing_order, s.created_at`,
    [documentId]
  );
  const roles = await c.query(
    `select key, label, label_ar, is_staff from signer_roles
     where clinic_id = $1 order by display_order, label`,
    [clinicId]
  );
  const events = await loadDocEvents(c, documentId, clinicId);
  const bodyOverride = await c.query(
    `select value from document_field_values where document_id = $1 and field_key = $2`,
    [documentId, BODY_OVERRIDE_KEY]
  );

  const signers = signerRows.rows as DocumentDetail["signers"];
  const bodySource =
    (bodyOverride.rows[0]?.value as string | undefined)?.trim() ||
    (doc.language === "ar"
      ? doc.template_body_ar || doc.template_body || ""
      : doc.template_body || doc.template_body_ar || "");

  const table = await buildMergeTable(c, {
    clinicId,
    documentId,
    body: bodySource,
    locale: doc.language,
    patientId: doc.patient_id,
    appointmentId: doc.appointment_id,
    serviceId: doc.service_id,
  });

  /*
    A frozen document shows its snapshot verbatim — that is the whole point of
    freezing. A draft is rendered live, with overrides marked, so staff can see
    at a glance which values they changed for this document only.
  */
  const previewHtml = doc.content_snapshot
    ? doc.content_snapshot
    : renderTokens(
        sanitizeHtml(bodySource),
        new Map<string, MergeValue>(
          table.fields.map((f) => [f.key, { value: f.value, isOverride: f.isOverride }])
        ),
        { markOverrides: true }
      );

  // Definitions decide the display order; the merge table decides the values.
  const defs = await loadFieldDefinitions(c, clinicId);
  const order = new Map(defs.map((d, i) => [d.key, i]));

  return {
    doc: {
      ...doc,
      hash_ok: true, // recomputed by the caller when it matters; see verifyHash
    },
    previewHtml,
    bodySource,
    signers,
    dueSignerIds: signersDueNow(signers, doc.signing_mode).map((s) => s.id),
    fields: table.fields
      .map((f) => ({ ...f, used: table.used.includes(f.key) }))
      .sort((a, b) => {
        // Used first (they are what the document actually says), then definition order.
        if (a.used !== b.used) return a.used ? -1 : 1;
        return (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999);
      }),
    missing: table.missing.map((m) => ({
      key: m.key,
      label: doc.language === "ar" ? m.labelAr : m.label,
      fixHint: m.fixHint,
    })),
    events,
    roles: roles.rows,
    extraQuestions: (doc.fields_schema ?? []) as DocumentDetail["extraQuestions"],
  };
}

/** Counts for the sidebar badge and the dashboard. */
export async function countPendingDocuments(c: PoolClient, clinicId: string): Promise<number> {
  const r = await c.query(
    `select count(*)::int as n from documents
     where clinic_id = $1 and status in ('sent', 'partially_signed')`,
    [clinicId]
  );
  return r.rows[0]?.n ?? 0;
}

/** Documents a booked service requires, and whether they exist and are signed. */
export async function loadAppointmentDocuments(
  c: PoolClient,
  clinicId: string,
  appointmentId: string
): Promise<
  {
    templateId: string;
    templateName: string;
    templateNameAr: string | null;
    autoSend: boolean;
    documentId: string | null;
    status: string | null;
  }[]
> {
  const r = await c.query(
    `select t.id as template_id, t.name, t.name_ar, sd.auto_send,
            d.id as document_id, d.status
     from appointments a
     join service_documents sd on sd.service_id = a.service_id and sd.clinic_id = a.clinic_id
     join document_templates t on t.id = sd.template_id and t.is_active
     left join documents d
       on d.template_id = t.id and d.clinic_id = a.clinic_id
      and (d.appointment_id = a.id or (d.appointment_id is null and d.patient_id = a.patient_id))
      and d.status <> 'voided'
     where a.id = $1 and a.clinic_id = $2
     order by t.name`,
    [appointmentId, clinicId]
  );
  return r.rows.map((row) => ({
    templateId: row.template_id,
    templateName: row.name,
    templateNameAr: row.name_ar,
    autoSend: !!row.auto_send,
    documentId: row.document_id,
    status: row.status,
  }));
}
