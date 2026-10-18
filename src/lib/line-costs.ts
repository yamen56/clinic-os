import type { PoolClient } from "pg";
import { round2 } from "./invoices";

/**
 * What the materials of an invoice line cost the clinic.
 *
 * Frozen beside the doctor's rate when the line is billed
 * (`invoice_line_doctors.material_cost`, 0081): the work's cost, each, times
 * the line's quantity — a bridge's teeth, three of a service. Read from the
 * database, never taken from the request: what comes off a doctor's share is
 * not the browser's to say.
 *
 * Chart work costs what was set for this patient by hand, else its price's
 * service on the list (`chart_marks.material_cost`, then `services`); a line
 * of a plain service costs what that service does; a line typed by hand costs
 * nothing.
 */
export async function lineMaterialCosts(
  c: PoolClient,
  clinicId: string,
  lines: { markId?: string | null; serviceId?: string | null; qty: number }[]
): Promise<number[]> {
  const markIds = [...new Set(lines.map((l) => l.markId).filter((x): x is string => !!x))];
  const serviceIds = [...new Set(lines.map((l) => l.serviceId).filter((x): x is string => !!x))];
  const marks = new Map<string, number>();
  const services = new Map<string, number>();
  if (markIds.length) {
    const r = await c.query(
      `select m.id, coalesce(m.material_cost, s.material_cost, 0)::float as cost
         from chart_marks m left join services s on s.id = m.service_id
        where m.id = any($1::uuid[]) and m.clinic_id = $2`,
      [markIds, clinicId]
    );
    for (const x of r.rows) marks.set(x.id as string, Number(x.cost));
  }
  if (serviceIds.length) {
    const r = await c.query(
      `select id, coalesce(material_cost, 0)::float as cost from services where id = any($1::uuid[]) and clinic_id = $2`,
      [serviceIds, clinicId]
    );
    for (const x of r.rows) services.set(x.id as string, Number(x.cost));
  }
  return lines.map((l) => {
    const each = l.markId ? (marks.get(l.markId) ?? 0) : l.serviceId ? (services.get(l.serviceId) ?? 0) : 0;
    return round2(each * Math.max(0, Number(l.qty) || 0));
  });
}

/** The same, for lines already on an invoice: their treatment, if they bill one, else their service. */
export async function itemMaterialCosts(c: PoolClient, clinicId: string, itemIds: string[]): Promise<Map<string, number>> {
  if (!itemIds.length) return new Map();
  const r = await c.query(
    `select ii.id, ii.qty::float as qty, ii.service_id,
            (select iim.mark_id from invoice_item_marks iim where iim.invoice_item_id = ii.id limit 1) as mark_id
       from invoice_items ii
      where ii.id = any($1::uuid[]) and ii.clinic_id = $2`,
    [itemIds, clinicId]
  );
  const costs = await lineMaterialCosts(
    c,
    clinicId,
    r.rows.map((x) => ({ markId: x.mark_id as string | null, serviceId: x.service_id as string | null, qty: Number(x.qty) }))
  );
  return new Map(r.rows.map((x, i) => [x.id as string, costs[i]]));
}
