/**
 * Every note about a patient written outside the Notes tab, for the Notes tab.
 *
 * Yamen: a note anywhere in the file — on a visit, an invoice, the chart —
 * should be connected, and show in the patient's notes with where it came
 * from. The notes stay where they were written (that is where they are
 * edited); the Notes tab reads them all, each with its source and a way
 * back to it.
 *
 * This is the part kept in the database apart from the chart: the visit's own
 * notes and the answers given when booking, the note on an invoice and on its
 * insurance claim, a prescription's diagnosis and instructions, a waitlist
 * entry's note, an x-ray request's note. The chart's notes — on an entry, on
 * a step, a case's history and diagnosis — come from the chart the file
 * already holds, live. Each source is read only by a member who may open it.
 */

import type { PoolClient } from "pg";

export type FeedSource = "visit" | "invoice" | "claim" | "prescription" | "waitlist" | "xray";

export type FeedItem = {
  source: FeedSource;
  /** The record the note is on: the appointment, the invoice, the prescription… */
  id: string;
  at: string;
  /** Who wrote it, where that is known — the visit's doctor, the invoice's author, the prescriber. */
  by: string | null;
  body: string;
  /** The invoice's number, the prescription's. */
  ref: string | null;
  /** A visit's or a waitlist entry's service. */
  service: string | null;
  serviceAr: string | null;
  status: string | null;
  /** Booking answers ({label, labelAr, value}[]), a prescription's medicines, an x-ray's teeth. */
  extra: unknown;
};

export async function loadNoteFeed(
  c: PoolClient,
  clinicId: string,
  patientId: string,
  can: { visits: boolean; invoices: boolean; claims: boolean },
  /** The invoices this member may see — `invoiceScopeSql(access, "i", 6)`. */
  invoiceScope: { sql: string; params: string[] }
): Promise<FeedItem[]> {
  const r = await c.query(
    `select * from (
       select 'visit'::text as source, a.id, a.starts_at as at, u.full_name as by, a.notes as body, null::text as ref,
              s.name as service, s.name_ar as service_ar, a.status::text as status, a.intake_answers as extra
         from appointments a
         left join services s on s.id = a.service_id
         left join clinic_members cm on cm.id = a.doctor_member_id
         left join users u on u.id = cm.user_id
        where $3 and a.clinic_id = $1 and a.patient_id = $2
          and (btrim(a.notes) <> '' or jsonb_array_length(coalesce(a.intake_answers, '[]'::jsonb)) > 0)
       union all
       select 'invoice', i.id, i.created_at, cu.full_name, i.notes, i.number, null, null, i.status, null
         from invoices i left join users cu on cu.id = i.created_by
        where $4 and i.clinic_id = $1 and i.patient_id = $2 and btrim(i.notes) <> ''${invoiceScope.sql}
       union all
       select 'claim', i.id, coalesce(i.claim_submitted_at, i.created_at), null, i.claim_note, i.number, null, null, i.claim_status, null
         from invoices i
        where $5 and i.clinic_id = $1 and i.patient_id = $2 and btrim(i.claim_note) <> ''${invoiceScope.sql}
       union all
       select 'prescription', p.id, p.created_at, p.doctor_name, p.diagnosis, p.number::text, null, null, null, p.items
         from prescriptions p
        where p.clinic_id = $1 and p.patient_id = $2
          and (btrim(p.diagnosis) <> ''
               or exists (select 1 from jsonb_array_elements(p.items) x where btrim(coalesce(x->>'instructions', '')) <> ''))
       union all
       select 'waitlist', w.id, w.created_at, null, w.note, null, s.name, s.name_ar, w.status, null
         from waitlist_entries w left join services s on s.id = w.service_id
        where $3 and w.clinic_id = $1 and w.patient_id = $2 and btrim(w.note) <> ''
       union all
       select 'xray', x.id, x.created_at, xu.full_name, x.note, null, null, null,
              case when x.cancelled_at is not null then 'cancelled' when x.fulfilled_at is not null then 'done' else 'waiting' end,
              to_jsonb(x.teeth)
         from imaging_requests x left join users xu on xu.id = x.requested_by
        where x.clinic_id = $1 and x.patient_id = $2 and btrim(x.note) <> ''
     ) f
     order by at desc
     limit 200`,
    [clinicId, patientId, can.visits, can.invoices, can.claims, ...invoiceScope.params]
  );
  return r.rows.map((x) => ({
    source: x.source as FeedSource,
    id: x.id as string,
    at: new Date(x.at).toISOString(),
    by: (x.by as string) ?? null,
    body: (x.body as string) ?? "",
    ref: (x.ref as string) ?? null,
    service: (x.service as string) ?? null,
    serviceAr: (x.service_ar as string) ?? null,
    status: (x.status as string) ?? null,
    extra: x.extra ?? null,
  }));
}
