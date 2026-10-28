/**
 * The face chart's rows, read for a patient file and shaped for the page.
 *
 * Face work is chart_marks of chart 'aesthetic' (0084): the same entries,
 * history and billing links as the dental chart, read on their own so a
 * medical centre that keeps both never draws a face treatment on a tooth.
 */

import type { PoolClient } from "pg";
import type { MarkEvent } from "@/lib/charts/dental/state";
import type { Billed } from "@/lib/charts/dental/billing-server";
import { toEvent } from "@/lib/charts/dental/db";
import { FACE_TREATMENT_BY_KEY, type Area, type Family } from "./catalog";
import { loadMarkProducts, loadStockProducts, type MarkProduct, type StockProduct } from "./stock";
import { loadPatientPackages, loadPlans, type PackagePlan, type PatientPackage } from "./packages";

type Person = { id: string; name: string };

/** A treatment on the patient's face, as the chart draws it. */
export type FaceMark = {
  id: string;
  treatmentKey: string;
  /** The names as they were when recorded: renaming a treatment never rewrites a record. */
  label: string;
  labelAr: string;
  family: Family;
  areas: Area[];
  /** What its price counts (lib/charts/face/catalog quantityOf). */
  quantity: number | null;
  /** The whole price, as quoted when it was recorded. Null: no price on the list then. */
  fee: number | null;
  feeManual: boolean;
  serviceId: string | null;
  note: string;
  performedBy: Person | null;
  recordedBy: Person;
  createdAt: string;
  doneAt: string | null;
  voidedAt: string | null;
  voidedBy: Person | null;
  voidReason: string | null;
  appointmentId: string | null;
  /** A session done from one of the patient's packages: no new charge. */
  packageItemId: string | null;
};

/** A face treatment's price on the clinic's list: the service that is the price. */
export type FacePrice = { serviceId: string; chartKey: string; variant: string | null; price: number; name: string; nameAr: string | null };

export type FaceChartData = {
  marks: FaceMark[];
  events: MarkEvent[];
  prices: FacePrice[];
  /** What is billed of each treatment, on invoices that stand. Empty for a member who may not see invoices. */
  billing: Billed[];
  /** The products the chart offers: active, with what is on hand and the batch next in line. */
  products: StockProduct[];
  /** What each treatment used. Costs only for a member who sees stock. */
  markProducts: MarkProduct[];
  /** The patient's packages, with the sessions used of each item. */
  packages: PatientPackage[];
  /** What the clinic sells, for selling one here. */
  plans: PackagePlan[];
};

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

export const FACE_MARK_SELECT = `
  select m.*, pu.full_name as performer_name, ru.full_name as recorder_name, vu.full_name as voider_name
    from chart_marks m
    left join clinic_members pm on pm.id = m.performed_by
    left join users pu on pu.id = pm.user_id
    left join users ru on ru.id = m.recorded_by
    left join users vu on vu.id = m.voided_by`;

export function toFaceMark(r: Record<string, unknown>): FaceMark {
  const key = r.treatment_key as string;
  return {
    id: r.id as string,
    treatmentKey: key,
    label: r.label as string,
    labelAr: r.label_ar as string,
    family: FACE_TREATMENT_BY_KEY.get(key)?.family ?? ((r.look as Family) || "skin"),
    areas: ((r.areas as Area[]) ?? []).map((a) => ({ zone: a.zone, ...(a.units != null ? { units: Number(a.units) } : {}) })),
    quantity: r.quantity == null ? null : Number(r.quantity),
    fee: r.fee == null ? null : Number(r.fee),
    feeManual: !!r.fee_manual,
    serviceId: (r.service_id as string) ?? null,
    note: (r.note as string) ?? "",
    performedBy: r.performed_by ? { id: r.performed_by as string, name: (r.performer_name as string) ?? "" } : null,
    recordedBy: { id: (r.recorded_by as string) ?? "", name: (r.recorder_name as string) ?? "" },
    createdAt: iso(r.created_at)!,
    doneAt: iso(r.done_at),
    voidedAt: iso(r.voided_at),
    voidedBy: r.voided_by ? { id: r.voided_by as string, name: (r.voider_name as string) ?? "" } : null,
    voidReason: (r.void_reason as string) ?? null,
    appointmentId: (r.appointment_id as string) ?? null,
    packageItemId: (r.package_item_id as string) ?? null,
  };
}

/** The clinic's face prices, or one treatment's. */
export async function loadFacePrices(c: PoolClient, clinicId: string, key: string | null = null): Promise<FacePrice[]> {
  const r = await c.query(
    `select id, chart_key, chart_variant, price, name, name_ar from services
      where clinic_id = $1 and chart_key like 'aes\\_%' and active and price_unit = 'item' and ($2::text is null or chart_key = $2)`,
    [clinicId, key]
  );
  return r.rows.map((x) => ({ serviceId: x.id, chartKey: x.chart_key, variant: x.chart_variant ?? null, price: Number(x.price), name: x.name, nameAr: x.name_ar ?? null }));
}

/**
 * Everything the face chart needs for one patient, in one round trip: its
 * treatments, their history, the clinic's face prices, and what is billed.
 */
export async function loadFaceChart(c: PoolClient, clinicId: string, patientId: string, opts: { billing: boolean; stockCosts: boolean }): Promise<FaceChartData> {
  const r = (
    await c.query(
      `select
         (select coalesce(json_agg(x order by x.created_at), '[]'::json)
            from (${FACE_MARK_SELECT} where m.clinic_id = $1 and m.patient_id = $2 and m.chart = 'aesthetic') x) as marks,
         (select coalesce(json_agg(x order by x.at), '[]'::json)
            from (select e.*, u.full_name as by_name
                    from chart_mark_events e
                    join chart_marks m on m.id = e.mark_id
                    left join users u on u.id = e.by_user
                   where m.clinic_id = $1 and m.patient_id = $2 and m.chart = 'aesthetic') x) as events,
         (select coalesce(json_agg(json_build_object('serviceId', s.id, 'chartKey', s.chart_key, 'variant', s.chart_variant, 'price', s.price, 'name', s.name, 'nameAr', s.name_ar)), '[]'::json)
            from services s where s.clinic_id = $1 and s.chart_key like 'aes\\_%' and s.active and s.price_unit = 'item') as prices,
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
                   where $3 and iim.clinic_id = $1 and m.patient_id = $2 and m.chart = 'aesthetic'
                     and i.status <> 'void' and i.credit_note_of is null
                   group by iim.mark_id) x) as billing`,
      [clinicId, patientId, opts.billing]
    )
  ).rows[0] as { marks: Record<string, unknown>[]; events: Record<string, unknown>[]; prices: Record<string, unknown>[]; billing: Billed[] };
  return {
    marks: r.marks.map(toFaceMark),
    events: r.events.map(toEvent),
    prices: r.prices.map((p) => ({
      serviceId: p.serviceId as string,
      chartKey: p.chartKey as string,
      variant: (p.variant as string) ?? null,
      price: Number(p.price),
      name: p.name as string,
      nameAr: (p.nameAr as string) ?? null,
    })),
    billing: r.billing.map((b) => ({ markId: b.markId, qty: Number(b.qty), charged: Number(b.charged ?? 0), paid: Number(b.paid ?? 0), invoices: b.invoices ?? [] })),
    // One after another: one connection runs one statement at a time whatever Promise.all suggests.
    products: await loadStockProducts(c, clinicId, { activeOnly: true }),
    markProducts: await loadMarkProducts(c, clinicId, patientId, opts.stockCosts),
    packages: await loadPatientPackages(c, clinicId, patientId),
    plans: await loadPlans(c, clinicId, true),
  };
}
