/**
 * The money side of the chart, on the server: the clinic's dental prices,
 * and what has been billed of each treatment.
 *
 * Billed means on an invoice that still stands — not voided, not a credit
 * note. A voided invoice therefore gives its treatments back to "not billed"
 * with nothing written anywhere, and invoice_items is never touched.
 */

import type { PoolClient } from "pg";
import { invoiceLineText, pickPrice, variantOf, type LineWords, type PriceRow, type PriceUnit } from "./pricing";
import { EVERY_TOOTH, inChartOrder, leadIdOf } from "./full-arch";

/** The clinic's dental prices: the services linked to a treatment, still in use — or one treatment's. */
export async function loadPrices(c: PoolClient, clinicId: string, treatmentKey: string | null = null): Promise<PriceRow[]> {
  const r = await c.query(
    `select id, chart_key, chart_variant, price, price_unit, name, name_ar from services
      where clinic_id = $1 and chart_key is not null and active and ($2::text is null or chart_key = $2)`,
    [clinicId, treatmentKey]
  );
  return r.rows.map((x) => ({
    serviceId: x.id as string,
    chartKey: x.chart_key as string,
    variant: (x.chart_variant as string) ?? null,
    price: Number(x.price),
    unit: x.price_unit === "session" ? "session" : "item",
    name: x.name as string,
    nameAr: (x.name_ar as string) ?? null,
  }));
}

/** One treatment's billing: how many units are on invoices that stand, and which. */
export type Billed = { markId: string; qty: number; invoices: { id: string; number: string; status: string }[] };

/** The SQL for what is billed of a set of treatments ($1 the clinic, $2 the ids) — shared by the chart and the builder. */
export const BILLED_SQL = `
  select iim.mark_id,
         sum(ii.qty)::float as qty,
         json_agg(distinct jsonb_build_object('id', i.id, 'number', i.number, 'status', i.status)) as invoices
    from invoice_item_marks iim
    join invoice_items ii on ii.id = iim.invoice_item_id
    join invoices i on i.id = ii.invoice_id
   where iim.clinic_id = $1 and iim.mark_id = any($2::uuid[])
     and i.status <> 'void' and i.credit_note_of is null
   group by iim.mark_id`;

export async function loadBilled(c: PoolClient, clinicId: string, markIds: string[]): Promise<Billed[]> {
  if (!markIds.length) return [];
  const r = await c.query(BILLED_SQL, [clinicId, markIds]);
  return r.rows.map((x) => ({ markId: x.mark_id as string, qty: Number(x.qty), invoices: x.invoices ?? [] }));
}

/**
 * A treatment's price from the list — charged the way asked, or the way it
 * starts (pricing.ts pickPrice). Null when the clinic has no such price.
 */
export async function priceFor(
  c: PoolClient,
  clinicId: string,
  treatmentKey: string,
  variant: string | null,
  unit: PriceUnit | null = null
): Promise<{ serviceId: string; price: number; unit: PriceUnit } | null> {
  const row = pickPrice(await loadPrices(c, clinicId, treatmentKey), treatmentKey, variant, unit);
  return row ? { serviceId: row.serviceId, price: row.price, unit: row.unit } : null;
}

/** A chart_marks row, as much of it as a change of detail reads. */
export type DetailRow = {
  id: string;
  treatment_key: string;
  detail: Record<string, string> | null;
  fee_manual: boolean;
  kind: string;
  status: string;
  service_id: string | null;
};

/**
 * A treatment's detail set — a crown made zirconia — and its price with it.
 *
 * A crown made zirconia instead of PFM costs what zirconia costs, unless a
 * price was set by hand for this patient, which a change of material does not
 * undo. Charged the way it started (the whole treatment when the list prices
 * it), it is priced again the way a new one would be; charged the other way
 * because someone chose so, it stays charged that way. The chart's detail
 * chips and a step that carries the detail (a crown's preparation) both come
 * through here.
 */
export async function setDetail(c: PoolClient, clinicId: string, cur: DetailRow, key: string, value: string): Promise<void> {
  await c.query(`update chart_marks set detail = detail || jsonb_build_object($2::text, $3::text) where id = $1`, [cur.id, key, value]);
  if (cur.fee_manual || cur.kind !== "procedure" || cur.status === "existing") return;
  const list = await loadPrices(c, clinicId, cur.treatment_key);
  const was = list.find((p) => p.serviceId === cur.service_id)?.unit ?? null;
  const chosen = !!was && pickPrice(list, cur.treatment_key, variantOf(cur.treatment_key, cur.detail ?? {}), null)?.unit !== was;
  const price = pickPrice(list, cur.treatment_key, variantOf(cur.treatment_key, { ...(cur.detail ?? {}), [key]: value }), chosen ? was : null);
  if (price) await c.query(`update chart_marks set fee = $2, service_id = $3 where id = $1`, [cur.id, price.price, price.serviceId]);
}

/** An invoice line for chart work, as the invoice builder starts it. */
export type ChartLine = {
  markId: string;
  serviceId: string | null;
  description: string;
  qty: number;
  unitPrice: number;
  /** The doctor who did it — the builder keeps it only for a doctor with a share. */
  doctorMemberId: string | null;
};

/**
 * The lines to bill a patient's chart work: one per treatment, in the clinic's
 * language. A bridge is one line with its units as the quantity; a price per
 * visit bills the visits not yet billed; work already billed once is left
 * out. Only this patient's own work, still standing, ever becomes a line.
 */
export async function chartLines(
  c: PoolClient,
  clinicId: string,
  patientId: string,
  ids: string[],
  locale: string,
  words: LineWords
): Promise<ChartLine[]> {
  if (!ids.length) return [];
  const marks = (
    await c.query(
      `select m.id, m.site, m.label, m.label_ar, m.treatment_key, m.detail, m.group_id, m.fee, m.service_id, m.performed_by,
              s.price_unit, s.name as service_name, s.name_ar as service_name_ar, s.chart_variant as service_variant
         from chart_marks m left join services s on s.id = m.service_id
        where m.id = any($1::uuid[]) and m.clinic_id = $2 and m.patient_id = $3
          and m.voided_at is null and m.kind = 'procedure' and m.status <> 'existing'
        order by m.created_at`,
      [ids, clinicId, patientId]
    )
  ).rows;
  if (!marks.length) return [];
  const groups = [...new Set(marks.map((m) => m.group_id).filter(Boolean))] as string[];
  const members = groups.length
    ? (
        await c.query(`select id, site, group_id from chart_marks where group_id = any($1::uuid[]) and clinic_id = $2 and voided_at is null`, [groups, clinicId])
      ).rows
    : [];
  const billed = new Map((await loadBilled(c, clinicId, marks.map((m) => m.id))).map((b) => [b.markId, b.qty]));
  const sessions = new Map(
    (
      await c.query(
        `select s.mark_id, count(distinct (s.done_at at time zone cl.timezone)::date)::int as n
           from chart_mark_steps s join clinics cl on cl.id = s.clinic_id
          where s.mark_id = any($1::uuid[]) and s.voided_at is null and s.step <> 'emergency'
          group by s.mark_id`,
        [marks.map((m) => m.id)]
      )
    ).rows.map((r) => [r.mark_id as string, Number(r.n)])
  );

  const lines: ChartLine[] = [];
  for (const m of marks) {
    const mates = m.group_id ? members.filter((x) => x.group_id === m.group_id) : [];
    // A bridge's teeth are its units; a full arch is one prosthesis, whatever it stands on.
    const archParent = mates.some((x) => !/^[1-8][1-8]$/.test(x.site));
    // A bridge is billed once, on its lead: its other teeth are in the lead's quantity.
    if (mates.length > 1 && !archParent && leadIdOf(mates) !== m.id) continue;
    const teeth = mates.length > 1 && !archParent ? inChartOrder(mates.map((x) => x.site as string).filter((s) => /^[1-8][1-8]$/.test(s))) : [];
    const already = billed.get(m.id) ?? 0;
    let qty: number;
    if (m.price_unit === "session" && sessions.has(m.id)) {
      // Charged per visit: the visits its steps were done on, less those already billed.
      const left = sessions.get(m.id)! - already;
      if (left <= 0) continue;
      qty = left;
    } else {
      // Charged once — and one-tap work charged per visit is one visit, recorded each time.
      if (already > 0) continue;
      qty = teeth.length || 1;
    }
    lines.push({
      markId: m.id,
      serviceId: m.service_id ?? null,
      description: invoiceLineText(
        { label: m.label, labelAr: m.label_ar, treatmentKey: m.treatment_key, detail: m.detail ?? {}, site: m.site },
        m.service_name ? { name: m.service_name, nameAr: m.service_name_ar ?? null, variant: m.service_variant ?? null } : null,
        locale,
        words,
        teeth
      ),
      qty,
      unitPrice: m.fee == null ? 0 : Number(m.fee),
      doctorMemberId: m.performed_by ?? null,
    });
  }
  return lines;
}

/**
 * The chart work waiting to be billed, as SQL: the rule of money.ts in one
 * statement, ending in a `due` relation of one row per treatment.
 *
 * A treatment is its group's lead — the arch entry, else the first tooth in
 * chart order — started or done since the clinic began billing from the
 * chart, not free, and not on an invoice that stands (a per-visit price: not
 * every visit of it). `units` is what is left to bill of it.
 *
 * `scope` picks the work it reads, both literals written here:
 *   recent  — finished or stepped on in the last month, for the desk ($1–$3);
 *   patient — one patient's, all of it, for the invoice builder ($4).
 * $1 the clinic, $2 the tooth order, $3 a doctor's own work only, or null.
 */
function dueSql(scope: "recent" | "patient"): string {
  const marksIn = scope === "recent" ? "m.done_at >= clinic.recent" : "m.patient_id = $4";
  const stepsIn = scope === "recent" ? "s.done_at >= clinic.recent" : "s.patient_id = $4";
  return `with clinic as (
       select dental_billing_since as since, timezone as tz,
              greatest(dental_billing_since, now() - interval '30 days') as recent
         from clinics where id = $1
     ),
     touched as (
       select m.id, m.group_id from chart_marks m, clinic
        where m.clinic_id = $1 and m.kind = 'procedure' and m.voided_at is null and ${marksIn}
       union
       select m.id, m.group_id from chart_mark_steps s join chart_marks m on m.id = s.mark_id, clinic
        where s.clinic_id = $1 and s.voided_at is null and s.step <> 'emergency' and ${stepsIn}
          and m.voided_at is null
     ),
     work as (
       select m.id, m.patient_id, m.group_id, m.site, m.fee, m.status, m.done_at, m.performed_by, sv.price_unit
         from chart_marks m left join services sv on sv.id = m.service_id
        where m.clinic_id = $1 and m.voided_at is null and m.kind = 'procedure' and m.status <> 'existing'
          and (m.id in (select id from touched)
               or m.group_id in (select group_id from touched where group_id is not null))
     ),
     leads as (
       select distinct on (coalesce(w.group_id, w.id)) w.*,
              count(*) over g as members,
              bool_or(w.site !~ '^[1-8][1-8]$') over g as arch
         from work w
       window g as (partition by coalesce(w.group_id, w.id))
        order by coalesce(w.group_id, w.id), (w.site ~ '^[1-8][1-8]$'), array_position($2::text[], w.site), w.id
     ),
     steps as (
       select s.mark_id, min(s.done_at) as first_at, max(s.done_at) as last_at,
              count(distinct (s.done_at at time zone clinic.tz)::date)::int as sessions
         from chart_mark_steps s, clinic
        where s.mark_id in (select id from leads) and s.voided_at is null and s.step <> 'emergency'
        group by s.mark_id
     ),
     billed as (
       select iim.mark_id, sum(ii.qty)::float as qty
         from invoice_item_marks iim
         join invoice_items ii on ii.id = iim.invoice_item_id
         join invoices i on i.id = ii.invoice_id
        where iim.clinic_id = $1 and iim.mark_id in (select id from leads)
          and i.status <> 'void' and i.credit_note_of is null
        group by iim.mark_id
     ),
     due as (
       select l.id, l.patient_id, l.fee,
              case when l.price_unit = 'session' and st.sessions > 0 then st.sessions - coalesce(b.qty, 0)
                   when l.members > 1 and not l.arch then l.members
                   else 1 end as units,
              greatest(l.done_at, st.last_at) as last_at
         from leads l
         left join steps st on st.mark_id = l.id
         left join billed b on b.mark_id = l.id
         cross join clinic
        where (l.status = 'done' or st.first_at is not null)
          and coalesce(l.done_at, st.first_at) >= clinic.since
          and coalesce(l.fee, -1) <> 0
          and ($3::uuid is null or l.performed_by = $3)
          and case when l.price_unit = 'session' and st.sessions > 0 then st.sessions > coalesce(b.qty, 0)
                   else coalesce(b.qty, 0) = 0 end
     )`;
}

/** A patient on the desk's Ready to bill: how much of their chart work waits, and which. */
export type DeskRow = { patientId: string; name: string; marks: string[]; total: number; unpriced: boolean; lastAt: string };

/**
 * The desk's Ready to bill: patients whose chart work was finished or stepped
 * on in the last month and is not on an invoice yet, the latest first. Older
 * work still waits on the patient's own card; the desk is for today's
 * patients, and a month bounds what it reads.
 *
 * `memberId` narrows it to one doctor's own work, for a member who sees only
 * their own invoices.
 */
export async function readyToBillDesk(c: PoolClient, clinicId: string, memberId: string | null): Promise<DeskRow[]> {
  const r = await c.query(
    `${dueSql("recent")}
     select p.id, p.full_name,
            array_agg(d.id order by d.last_at) as marks,
            coalesce(sum(d.fee * d.units), 0)::float as total,
            bool_or(d.fee is null) as unpriced,
            max(d.last_at) as last_at
       from due d join patients p on p.id = d.patient_id and p.merged_into is null
      group by p.id, p.full_name
      order by max(d.last_at) desc
      limit 40`,
    [clinicId, EVERY_TOOTH, memberId]
  );
  return r.rows.map((x) => ({
    patientId: x.id as string,
    name: x.full_name as string,
    marks: x.marks as string[],
    total: Number(x.total),
    unpriced: !!x.unpriced,
    lastAt: new Date(x.last_at).toISOString(),
  }));
}

/** One patient's chart work waiting to be billed, oldest first: the treatments' ids, for chartLines. */
export async function billableMarks(c: PoolClient, clinicId: string, patientId: string, memberId: string | null): Promise<string[]> {
  const r = await c.query(`${dueSql("patient")} select id from due order by last_at limit 40`, [clinicId, EVERY_TOOTH, memberId, patientId]);
  return r.rows.map((x) => x.id as string);
}
