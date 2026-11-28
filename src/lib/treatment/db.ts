/**
 * The treatment record's rows, read for a patient file and shaped for the page.
 *
 * Two things, both since 0108. What each visit was — complaint, examination,
 * diagnosis, plan — is a row of visit_records. What was done at it, when it
 * has no drawing to go on (a consultation, a dressing, a session), is a
 * chart_marks row of chart 'general': the same entries, history and billing
 * links as tooth and face work, read on their own so neither chart draws one.
 *
 * Tooth and face work is not read here. The file already holds those charts,
 * and the record shows a visit's share of them from there — entered once, on
 * the chart, and never again.
 */

import type { PoolClient } from "pg";
import type { Billed } from "@/lib/charts/dental/billing-server";
import { asVitals, type Vitals } from "./vitals";

type Person = { id: string; name: string };

/** What a visit was. Every part may be empty. */
export type VisitRecord = {
  id: string;
  /** The visit it is about; null for a record that stands by its date. */
  appointmentId: string | null;
  complaint: string;
  exam: string;
  diagnosis: string;
  plan: string;
  /** Blood pressure, pulse, weight… by name (0125); a key is absent until measured. */
  vitals: Vitals;
  recordedBy: Person | null;
  updatedBy: Person | null;
  createdAt: string;
  updatedAt: string;
};

/** A treatment done (or planned) that no chart draws. */
export type GeneralMark = {
  id: string;
  /** The names as they were when recorded: renaming a service never rewrites a record. */
  label: string;
  labelAr: string;
  /** The line of the price list it is; null when its name was typed by hand. */
  serviceId: string | null;
  /** Its price that day. Null: not on the list, so reception prices it on the invoice. */
  fee: number | null;
  status: "planned" | "done";
  note: string;
  performedBy: Person | null;
  recordedBy: Person;
  createdAt: string;
  doneAt: string | null;
  voidedAt: string | null;
  appointmentId: string | null;
  courseId: string | null;
};

/** A line of the price list a doctor can record as done. */
export type ServiceOption = {
  id: string;
  name: string;
  nameAr: string | null;
  price: number;
  /** How often this member recorded it lately — what they do most comes first. */
  used: number;
};

export type TreatmentData = {
  records: VisitRecord[];
  marks: GeneralMark[];
  /** What is billed of each treatment, on invoices that stand. Empty for a member who may not see invoices. */
  billing: Billed[];
  services: ServiceOption[];
};

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

export const RECORD_SELECT = `
  select r.*, ru.full_name as recorder_name, uu.full_name as updater_name
    from visit_records r
    left join users ru on ru.id = r.recorded_by
    left join users uu on uu.id = r.updated_by`;

export function toRecord(r: Record<string, unknown>): VisitRecord {
  return {
    id: r.id as string,
    appointmentId: (r.appointment_id as string) ?? null,
    complaint: (r.complaint as string) ?? "",
    exam: (r.exam as string) ?? "",
    diagnosis: (r.diagnosis as string) ?? "",
    plan: (r.plan as string) ?? "",
    vitals: asVitals(r.vitals),
    recordedBy: r.recorded_by ? { id: r.recorded_by as string, name: (r.recorder_name as string) ?? "" } : null,
    updatedBy: r.updated_by ? { id: r.updated_by as string, name: (r.updater_name as string) ?? "" } : null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

export const GENERAL_MARK_SELECT = `
  select m.*, pu.full_name as performer_name, ru.full_name as recorder_name
    from chart_marks m
    left join clinic_members pm on pm.id = m.performed_by
    left join users pu on pu.id = pm.user_id
    left join users ru on ru.id = m.recorded_by`;

export function toGeneralMark(r: Record<string, unknown>): GeneralMark {
  return {
    id: r.id as string,
    label: r.label as string,
    labelAr: (r.label_ar as string) ?? "",
    serviceId: (r.service_id as string) ?? null,
    fee: r.fee == null ? null : Number(r.fee),
    status: r.status === "planned" ? "planned" : "done",
    note: (r.note as string) ?? "",
    performedBy: r.performed_by ? { id: r.performed_by as string, name: (r.performer_name as string) ?? "" } : null,
    recordedBy: { id: (r.recorded_by as string) ?? "", name: (r.recorder_name as string) ?? "" },
    createdAt: iso(r.created_at)!,
    doneAt: iso(r.done_at),
    voidedAt: iso(r.voided_at),
    appointmentId: (r.appointment_id as string) ?? null,
    courseId: (r.course_id as string) ?? null,
  };
}

/**
 * Everything the treatment record needs for one patient, in one round trip.
 *
 * The services are the price list without the lines a chart prices: a crown
 * or a filler is recorded on its chart, and offering it here too is how one
 * treatment would be billed twice.
 */
export async function loadTreatment(
  c: PoolClient,
  clinicId: string,
  patientId: string,
  opts: { billing: boolean; userId: string }
): Promise<TreatmentData> {
  const r = (
    await c.query(
      `select
         (select coalesce(json_agg(x order by x.created_at), '[]'::json)
            from (${RECORD_SELECT} where r.clinic_id = $1 and r.patient_id = $2) x) as records,
         (select coalesce(json_agg(x order by x.created_at), '[]'::json)
            from (${GENERAL_MARK_SELECT} where m.clinic_id = $1 and m.patient_id = $2 and m.chart = 'general') x) as marks,
         (select coalesce(json_agg(x), '[]'::json)
            from (select iim.mark_id as "markId", sum(ii.qty)::float as qty,
                         sum(ii.amount - ii.discount_amount + ii.tax_amount)::float as charged,
                         sum(round((ii.amount - ii.discount_amount + ii.tax_amount) * i.amount_paid / nullif(i.total, 0), 2))::float as paid,
                         json_agg(distinct jsonb_build_object('id', i.id, 'number', i.number, 'status', i.status, 'total', i.total, 'paid', i.amount_paid,
                                                   'filed', i.einvoice_status in ('submitted', 'pending'))) as invoices
                    from invoice_item_marks iim
                    join chart_marks m on m.id = iim.mark_id
                    join invoice_items ii on ii.id = iim.invoice_item_id
                    join invoices i on i.id = ii.invoice_id
                   where $3 and iim.clinic_id = $1 and m.patient_id = $2 and m.chart = 'general'
                     and i.status <> 'void' and i.credit_note_of is null
                   group by iim.mark_id) x) as billing,
         (select coalesce(json_agg(x order by x.used desc, x.sort, x.name), '[]'::json)
            from (select s.id, s.name, s.name_ar as "nameAr", s.price, s.sort,
                         (select count(*)::int from chart_marks u
                           where u.clinic_id = $1 and u.chart = 'general' and u.service_id = s.id
                             and u.recorded_by = $4 and u.voided_at is null
                             and u.created_at > now() - interval '90 days') as used
                    from services s
                   where s.clinic_id = $1 and s.active and s.chart_key is null) x) as services`,
      [clinicId, patientId, opts.billing, opts.userId]
    )
  ).rows[0] as {
    records: Record<string, unknown>[];
    marks: Record<string, unknown>[];
    billing: Billed[];
    services: { id: string; name: string; nameAr: string | null; price: string | number; used: number }[];
  };
  return {
    records: r.records.map(toRecord),
    marks: r.marks.map(toGeneralMark),
    billing: r.billing.map((b) => ({ markId: b.markId, qty: Number(b.qty), charged: Number(b.charged ?? 0), paid: Number(b.paid ?? 0), invoices: b.invoices ?? [] })),
    services: r.services.map((s) => ({ id: s.id, name: s.name, nameAr: s.nameAr ?? null, price: Number(s.price), used: Number(s.used ?? 0) })),
  };
}
