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
