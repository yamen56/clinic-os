/**
 * The dental chart's rows, read for a patient file and shaped for the page.
 *
 * One function per kind of row so the routes that write a row can answer with
 * it in the same shape the page was loaded with — the client never has to
 * guess what the server stored.
 */

import type { PoolClient } from "pg";
import { BORROWABLE_LOOKS, BUILT_IN_BY_KEY, type Category, type Look, type Scope, type Treatment } from "./catalog";
import type { Mark, MarkEvent } from "./state";
import type { StepRecord } from "./protocols";
import type { Booking, TreatmentCase, Visit } from "./treatment";
import { readHistory, type MedicalHistory } from "@/lib/medical-history";
import type { PriceRow } from "./pricing";
import type { Billed } from "./billing-server";

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

export const MARK_SELECT = `
  select m.*, pu.full_name as performer_name, ru.full_name as recorder_name, vu.full_name as voider_name,
         -- Under way from its first step (an emergency is not one of its own).
         (select min(s.done_at) from chart_mark_steps s
           where s.mark_id = m.id and s.voided_at is null and s.step <> 'emergency') as started_at
    from chart_marks m
    left join clinic_members pm on pm.id = m.performed_by
    left join users pu on pu.id = pm.user_id
    left join users ru on ru.id = m.recorded_by
    left join users vu on vu.id = m.voided_by`;

export function toMark(r: Record<string, unknown>): Mark {
  return {
    id: r.id as string,
    site: r.site as string,
    surfaces: (r.surfaces as Mark["surfaces"]) ?? [],
    treatmentKey: r.treatment_key as string,
    label: r.label as string,
    labelAr: r.label_ar as string,
    abbr: (r.abbr as string) ?? undefined,
    look: r.look as Look,
    kind: r.kind as Mark["kind"],
    detail: (r.detail as Record<string, string>) ?? {},
    status: r.status as Mark["status"],
    groupId: (r.group_id as string) ?? undefined,
    role: (r.role as Mark["role"]) ?? undefined,
    performedBy: r.performed_by ? { id: r.performed_by as string, name: (r.performer_name as string) ?? "" } : null,
    recordedBy: { id: (r.recorded_by as string) ?? "", name: (r.recorder_name as string) ?? "" },
    createdAt: iso(r.created_at)!,
    doneAt: iso(r.done_at),
    voidedAt: iso(r.voided_at),
    voidedBy: r.voided_by ? { id: r.voided_by as string, name: (r.voider_name as string) ?? "" } : null,
    voidReason: (r.void_reason as string) ?? null,
    note: (r.note as string) ?? "",
    caseId: (r.case_id as string) ?? null,
    emergency: !!r.emergency,
    startedAt: iso(r.started_at),
    appointmentId: (r.appointment_id as string) ?? null,
    fee: r.fee == null ? null : Number(r.fee),
    feeManual: !!r.fee_manual,
    serviceId: (r.service_id as string) ?? null,
  };
}

export const STEP_SELECT = `
  select s.*, pu.full_name as performer_name, ru.full_name as recorder_name, vu.full_name as voider_name
    from chart_mark_steps s
    left join clinic_members pm on pm.id = s.performed_by
    left join users pu on pu.id = pm.user_id
    left join users ru on ru.id = s.recorded_by
    left join users vu on vu.id = s.voided_by`;

export function toStep(r: Record<string, unknown>): StepRecord {
  return {
    id: r.id as string,
    markId: r.mark_id as string,
    step: r.step as string,
    data: (r.data as StepRecord["data"]) ?? {},
    note: (r.note as string) ?? "",
    performedBy: r.performed_by ? { id: r.performed_by as string, name: (r.performer_name as string) ?? "" } : null,
    recordedBy: { id: (r.recorded_by as string) ?? "", name: (r.recorder_name as string) ?? "" },
    appointmentId: (r.appointment_id as string) ?? null,
    doneAt: iso(r.done_at)!,
    voidedAt: iso(r.voided_at),
    voidedBy: r.voided_by ? { id: r.voided_by as string, name: (r.voider_name as string) ?? "" } : null,
    voidReason: (r.void_reason as string) ?? null,
  };
}

export const CASE_SELECT = `
  select tc.*, du.full_name as doctor_name, cu.full_name as creator_name, mu.full_name as reviewer_name
    from treatment_cases tc
    left join clinic_members dm on dm.id = tc.doctor_member_id
    left join users du on du.id = dm.user_id
    left join users cu on cu.id = tc.created_by
    left join users mu on mu.id = tc.medical_reviewed_by`;

export function toCase(r: Record<string, unknown>): TreatmentCase {
  return {
    id: r.id as string,
    title: (r.title as string) ?? "",
    complaint: (r.complaint as string) ?? "",
    history: (r.history as string) ?? "",
    exam: (r.exam as string) ?? "",
    diagnosis: (r.diagnosis as string) ?? "",
    doctor: r.doctor_member_id ? { id: r.doctor_member_id as string, name: (r.doctor_name as string) ?? "" } : null,
    status: r.status as TreatmentCase["status"],
    medicalReviewedAt: iso(r.medical_reviewed_at),
    medicalReviewedBy: r.medical_reviewed_by ? { id: r.medical_reviewed_by as string, name: (r.reviewer_name as string) ?? "" } : null,
    createdBy: { id: (r.created_by as string) ?? "", name: (r.creator_name as string) ?? "" },
    createdAt: iso(r.created_at)!,
    closedAt: iso(r.closed_at),
  };
}

function toVisit(r: Record<string, unknown>): Visit {
  return {
    id: r.id as string,
    startsAt: iso(r.starts_at)!,
    endsAt: iso(r.ends_at)!,
    status: r.status as string,
    doctor: (r.doctor_name as string) ?? null,
    service: (r.service_name as string) ?? null,
  };
}

export function toEvent(r: Record<string, unknown>): MarkEvent {
  return {
    id: r.id as string,
    markId: r.mark_id as string,
    action: r.action as MarkEvent["action"],
    at: iso(r.at)!,
    by: { id: (r.by_user as string) ?? "", name: (r.by_name as string) ?? "" },
    reason: (r.reason as string) ?? undefined,
  };
}

export const CUSTOM_CATEGORIES: Category[] = [
  "findings",
  "diagnostic",
  "preventive",
  "restorative",
  "endodontic",
  "periodontic",
  "fixed",
  "removable",
  "implant",
  "surgery",
  "ortho",
  "pediatric",
  "cosmetic",
];
export const CUSTOM_SCOPES: Scope[] = ["surface", "tooth", "quadrant", "arch", "mouth"];
export const CUSTOM_LOOKS = BORROWABLE_LOOKS;

/** A clinic's own treatment, as the catalog knows treatments. */
export function toCustomTreatment(r: Record<string, unknown>): Treatment {
  const category = r.category as Category;
  const scope = r.scope as Scope;
  return {
    key: `custom:${r.id as string}`,
    kind: category === "findings" ? "finding" : "procedure",
    category,
    en: r.name as string,
    ar: r.name as string,
    abbr: (r.abbr as string) ?? undefined,
    scope,
    needsSurfaces: scope === "surface",
    look: r.look as Look,
    custom: { addedBy: (r.creator_name as string) ?? "", addedAt: iso(r.created_at)! },
  };
}

export type FavoriteRow = { key: string; addedBy: { id: string; name: string }; addedAt: string };

export type DentalChartData = {
  marks: Mark[];
  events: MarkEvent[];
  custom: Treatment[];
  favorites: FavoriteRow[];
  /** The patient's cases, newest first. */
  cases: TreatmentCase[];
  /** Every step of every treatment, voided ones included — they are the record. */
  steps: StepRecord[];
  /**
   * The patient's visits and which plan items are booked into them. Empty for
   * a member who may not see the calendar: when a patient comes is the
   * calendar's to tell.
   */
  visits: Visit[];
  bookings: Booking[];
  medical: MedicalHistory;
  /** The clinic's dental prices: what a treatment starts at. */
  prices: PriceRow[];
  /**
   * What has been billed of each treatment, on invoices that still stand.
   * Empty for a member who may not see invoices: what a patient was billed
   * is the invoices' to tell.
   */
  billing: Billed[];
  /** From when chart work counts as waiting to be billed (work before it was billed by hand). */
  billingSince: string | null;
};

/**
 * Everything the chart needs for one patient, in one round trip.
 *
 * One statement rather than one per kind of row: everything on a connection
 * runs in series, so four queries were four round trips to the database, and
 * the patient file waits on them before it can render. Timestamps come back
 * through JSON as ISO strings, which `iso()` reads like the dates node-pg
 * would have handed over.
 */
export async function loadDentalChart(
  c: PoolClient,
  clinicId: string,
  patientId: string,
  opts: { visits: boolean; billing?: boolean } = { visits: true }
): Promise<DentalChartData> {
  const r = (
    await c.query(
      `select
         (select coalesce(json_agg(x order by x.created_at), '[]'::json)
            from (${MARK_SELECT} where m.clinic_id = $1 and m.patient_id = $2) x) as marks,
         (select coalesce(json_agg(x order by x.at), '[]'::json)
            from (select e.*, u.full_name as by_name
                    from chart_mark_events e
                    join chart_marks m on m.id = e.mark_id
                    left join users u on u.id = e.by_user
                   where m.clinic_id = $1 and m.patient_id = $2) x) as events,
         (select coalesce(json_agg(x order by x.created_at), '[]'::json)
            from (select t.*, u.full_name as creator_name
                    from chart_treatments t left join users u on u.id = t.created_by
                   where t.clinic_id = $1 and t.chart = 'dental' and t.archived_at is null) x) as custom,
         (select coalesce(json_agg(x order by x.sort, x.added_at), '[]'::json)
            from (select f.treatment_key, f.added_at, f.added_by, f.sort, u.full_name as added_name
                    from chart_treatment_favorites f left join users u on u.id = f.added_by
                   where f.clinic_id = $1 and f.chart = 'dental') x) as favorites,
         (select coalesce(json_agg(x order by x.created_at desc), '[]'::json)
            from (${CASE_SELECT} where tc.clinic_id = $1 and tc.patient_id = $2) x) as cases,
         (select coalesce(json_agg(x order by x.done_at), '[]'::json)
            from (${STEP_SELECT} where s.clinic_id = $1 and s.patient_id = $2) x) as steps,
         (select coalesce(json_agg(x order by x.starts_at), '[]'::json)
            from (select a.id, a.starts_at, a.ends_at, a.status, u.full_name as doctor_name, sv.name as service_name
                    from appointments a
                    left join clinic_members cm on cm.id = a.doctor_member_id
                    left join users u on u.id = cm.user_id
                    left join services sv on sv.id = a.service_id
                   where $3 and a.clinic_id = $1 and a.patient_id = $2) x) as visits,
         (select coalesce(json_agg(json_build_object('markId', ai.mark_id, 'appointmentId', ai.appointment_id)), '[]'::json)
            from appointment_items ai
           where $3 and ai.clinic_id = $1 and ai.patient_id = $2) as bookings,
         (select medical_history from patients where id = $2 and clinic_id = $1) as medical,
         (select coalesce(json_agg(json_build_object('serviceId', s.id, 'chartKey', s.chart_key, 'variant', s.chart_variant, 'price', s.price, 'unit', s.price_unit, 'name', s.name, 'nameAr', s.name_ar)), '[]'::json)
            from services s where s.clinic_id = $1 and s.chart_key is not null and s.active) as prices,
         (select coalesce(json_agg(x), '[]'::json)
            from (select iim.mark_id as "markId", sum(ii.qty)::float as qty,
                         json_agg(distinct jsonb_build_object('id', i.id, 'number', i.number, 'status', i.status)) as invoices
                    from invoice_item_marks iim
                    join chart_marks m on m.id = iim.mark_id
                    join invoice_items ii on ii.id = iim.invoice_item_id
                    join invoices i on i.id = ii.invoice_id
                   where $4 and iim.clinic_id = $1 and m.patient_id = $2
                     and i.status <> 'void' and i.credit_note_of is null
                   group by iim.mark_id) x) as billing,
         (select dental_billing_since from clinics where id = $1) as billing_since`,
      [clinicId, patientId, opts.visits, opts.billing ?? false]
    )
  ).rows[0] as Record<string, Record<string, unknown>[]> & { bookings: Booking[]; medical: unknown; billing: Billed[]; billing_since: unknown };
  return {
    marks: r.marks.map(toMark),
    events: r.events.map(toEvent),
    custom: r.custom.map(toCustomTreatment),
    favorites: r.favorites.map((f) => ({
      key: f.treatment_key as string,
      addedBy: { id: (f.added_by as string) ?? "", name: (f.added_name as string) ?? "" },
      addedAt: iso(f.added_at)!,
    })),
    cases: r.cases.map(toCase),
    steps: r.steps.map(toStep),
    visits: r.visits.map(toVisit),
    bookings: r.bookings,
    medical: readHistory(r.medical),
    prices: r.prices.map((p) => ({
      serviceId: p.serviceId as string,
      chartKey: p.chartKey as string,
      variant: (p.variant as string) ?? null,
      price: Number(p.price),
      unit: p.unit === "session" ? "session" : "item",
      name: p.name as string,
      nameAr: (p.nameAr as string) ?? null,
    })),
    billing: r.billing.map((b) => ({ markId: b.markId, qty: Number(b.qty), invoices: b.invoices ?? [] })),
    billingSince: iso(r.billing_since),
  };
}

/**
 * The treatment behind a key, as this clinic knows it: a built-in, or one of
 * its own (`custom:<uuid>`, still unarchived). Null for anything else — the
 * server never takes a treatment's name or drawing from the browser.
 */
export async function resolveTreatment(c: PoolClient, clinicId: string, key: string): Promise<Treatment | null> {
  const built = BUILT_IN_BY_KEY.get(key);
  if (built) return built;
  const m = /^custom:([0-9a-f-]{36})$/i.exec(key);
  if (!m) return null;
  const r = await c.query(
    `select t.*, u.full_name as creator_name from chart_treatments t left join users u on u.id = t.created_by
      where t.id = $1 and t.clinic_id = $2 and t.archived_at is null`,
    [m[1], clinicId]
  );
  return r.rows[0] ? toCustomTreatment(r.rows[0]) : null;
}
