/**
 * The face chart's packages (0085), on the server.
 *
 * A plan is what the clinic sells: one treatment for so many sessions, or a
 * bundle of several. Sold to a patient it is a face chart entry at the plan's
 * price — billed like any other work — with each item's share of that price
 * written down, so a session done knows what it is worth to its doctor.
 */

import type { PoolClient } from "pg";

/** The face chart entry that sells a package. Not a treatment: nothing is drawn for it. */
export const PACKAGE_KEY = "aes_package";

export type PlanItem = { treatmentKey: string; sessions: number };
export type PackagePlan = { id: string; name: string; nameAr: string; price: number; validMonths: number | null; active: boolean; items: PlanItem[] };

export type PatientPackageItem = { id: string; treatmentKey: string; sessions: number; value: number; used: number };
export type PatientPackage = {
  id: string;
  name: string;
  nameAr: string;
  price: number;
  expiresOn: string | null;
  saleMarkId: string;
  createdAt: string;
  /** Its sale was voided: the package is gone, and no session can come from it. */
  voided: boolean;
  items: PatientPackageItem[];
};

export async function loadPlans(c: PoolClient, clinicId: string, activeOnly: boolean): Promise<PackagePlan[]> {
  const r = await c.query(
    `select p.id, p.name, p.name_ar, p.price::float as price, p.valid_months, p.active,
            coalesce((select json_agg(json_build_object('treatmentKey', i.treatment_key, 'sessions', i.sessions) order by i.sort)
                        from package_plan_items i where i.plan_id = p.id), '[]'::json) as items
       from package_plans p
      where p.clinic_id = $1 and ($2::boolean is false or p.active)
      order by p.active desc, p.sort, p.name`,
    [clinicId, activeOnly]
  );
  return r.rows.map((x) => ({ id: x.id, name: x.name, nameAr: x.name_ar, price: Number(x.price), validMonths: x.valid_months ?? null, active: !!x.active, items: x.items }));
}

export async function loadPatientPackages(c: PoolClient, clinicId: string, patientId: string): Promise<PatientPackage[]> {
  const r = await c.query(
    `select pp.id, pp.name, pp.name_ar, pp.price::float as price, pp.expires_on::text as expires_on, pp.sale_mark_id, pp.created_at,
            (m.voided_at is not null) as voided,
            coalesce((select json_agg(json_build_object(
                        'id', i.id, 'treatmentKey', i.treatment_key, 'sessions', i.sessions, 'value', i.value,
                        'used', (select count(*) from chart_marks s where s.package_item_id = i.id and s.voided_at is null)) order by i.sort)
                        from patient_package_items i where i.patient_package_id = pp.id), '[]'::json) as items
       from patient_packages pp
       join chart_marks m on m.id = pp.sale_mark_id
      where pp.clinic_id = $1 and pp.patient_id = $2
      order by pp.created_at`,
    [clinicId, patientId]
  );
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    nameAr: x.name_ar,
    price: Number(x.price),
    expiresOn: x.expires_on ? String(x.expires_on).slice(0, 10) : null,
    saleMarkId: x.sale_mark_id,
    createdAt: new Date(x.created_at).toISOString(),
    voided: !!x.voided,
    items: (x.items as PatientPackageItem[]).map((i) => ({ ...i, value: Number(i.value), used: Number(i.used) })),
  }));
}

/**
 * Each item's share of a package's price, by what its treatments cost on the
 * list (price × sessions); with no list prices, by sessions. Rounded to the
 * fils, the last item taking what rounding left, so the shares add up to the
 * price exactly.
 */
export function splitPrice(price: number, items: PlanItem[], listPrice: (key: string) => number | null): number[] {
  const weights = items.map((i) => (listPrice(i.treatmentKey) ?? 0) * i.sessions);
  const total = weights.reduce((a, b) => a + b, 0);
  const w = total > 0 ? weights : items.map((i) => i.sessions);
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  const out = w.map((x) => Math.round((price * x * 100) / sum) / 100);
  const drift = Math.round((price - out.reduce((a, b) => a + b, 0)) * 100) / 100;
  if (out.length) out[out.length - 1] = Math.round((out[out.length - 1] + drift) * 100) / 100;
  return out;
}

/**
 * The package item a session may come from: this patient's, of this
 * treatment, its package not voided and not expired (today in the clinic's
 * own day), with a session left. Locked, so two sessions saved at once never
 * take the last one twice.
 */
export async function usablePackageItem(
  c: PoolClient,
  clinicId: string,
  patientId: string,
  itemId: string,
  treatmentKey: string
): Promise<{ id: string } | { error: "package_item" | "package_used" | "package_expired" }> {
  const r = (
    await c.query(
      `select i.id, i.treatment_key, i.sessions, pp.expires_on, m.voided_at,
              (pp.expires_on is not null and pp.expires_on < (now() at time zone cl.timezone)::date) as expired,
              (select count(*)::int from chart_marks s where s.package_item_id = i.id and s.voided_at is null) as used
         from patient_package_items i
         join patient_packages pp on pp.id = i.patient_package_id
         join chart_marks m on m.id = pp.sale_mark_id
         join clinics cl on cl.id = pp.clinic_id
        where i.id = $1 and i.clinic_id = $2 and pp.patient_id = $3
        for update of i`,
      [itemId, clinicId, patientId]
    )
  ).rows[0];
  if (!r || r.voided_at || r.treatment_key !== treatmentKey) return { error: "package_item" };
  if (r.expired) return { error: "package_expired" };
  if (r.used >= r.sessions) return { error: "package_used" };
  return { id: r.id };
}
