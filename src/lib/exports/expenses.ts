import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import type { ClinicAccess } from "@/lib/auth";
import type { Dict } from "@/lib/i18n/en";
import type { ExportTable } from "./table";
import { MAX_SHEET_ROWS } from "./payments";

/**
 * What was spent in a period, as an export — the accountant's deliverable.
 *
 * `spent_on` is a calendar day and comes back as text: node-pg turns a `date`
 * into a JavaScript Date at local midnight, and the old CSV printed that as
 * "Wed Nov 18" (String(date).slice(0, 10)). Both bounds are days too, so no
 * clinic east of UTC loses a day at either end.
 */
export async function expensesTable(
  c: PoolClient,
  access: ClinicAccess,
  range: { from: string | null; to: string | null },
  t: Dict,
  locale: "ar" | "en"
): Promise<{ table: ExportTable; over: number | null }> {
  const conds = ["e.clinic_id = $1"];
  const vals: unknown[] = [access.clinicId];
  if (range.from) {
    vals.push(range.from);
    conds.push(`e.spent_on >= $${vals.length}::date`);
  }
  if (range.to) {
    vals.push(range.to);
    conds.push(`e.spent_on < $${vals.length}::date`);
  }
  const rows = (
    await c.query(
      `select e.spent_on::text as spent_on, e.amount::float8 as amount, e.method, e.vendor, e.note,
              ec.name as category, ec.name_ar as category_ar, u.full_name as recorded_by,
              e.schedule_id is not null as recurring
         from expenses e
         left join expense_categories ec on ec.id = e.category_id
         left join users u on u.id = e.created_by
        where ${conds.join(" and ")}
        order by e.spent_on desc, e.created_at desc
        limit ${MAX_SHEET_ROWS + 1}`,
      vals
    )
  ).rows;

  const over =
    rows.length > MAX_SHEET_ROWS
      ? Number((await c.query(`select count(*)::int as n from expenses e where ${conds.join(" and ")}`, vals)).rows[0].n)
      : null;
  const intl = locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB";
  const X = t.exports;
  const methods = t.invoices.methods as Record<string, string>;
  const day = (d: string) => DateTime.fromISO(d).setLocale(intl).toFormat("d LLL yyyy");
  const last = range.to ? DateTime.fromISO(range.to).minus({ days: 1 }).toISODate()! : null;
  const kept = rows.slice(0, MAX_SHEET_ROWS);
  const total = kept.reduce((s, r) => s + Number(r.amount), 0);

  return {
    over,
    table: {
      title: X.expensesTitle,
      subtitle: range.from && last ? `${day(range.from)} – ${day(last)}` : undefined,
      clinicName: (locale === "ar" && access.clinic.nameAr) || access.clinic.name,
      fileName: `expenses-${access.clinic.slug}-${range.from ? range.from.slice(0, 7) : DateTime.now().toISODate()}`,
      locale,
      currency: access.clinic.currency,
      sheets: [
        {
          name: X.expensesTitle,
          columns: [
            { key: "date", label: X.date, kind: "date" },
            { key: "amount", label: X.amount, kind: "money" },
            { key: "currency", label: X.currency },
            { key: "method", label: X.method },
            { key: "category", label: X.category },
            { key: "paidTo", label: X.paidTo },
            { key: "note", label: X.note },
            { key: "recurring", label: X.recurring },
            { key: "recordedBy", label: X.recordedBy },
          ],
          rows: kept.map((r) => ({
            date: r.spent_on,
            amount: Number(r.amount),
            currency: access.clinic.currency,
            method: r.method ? methods[r.method] ?? r.method : "",
            category: (locale === "ar" ? r.category_ar || r.category : r.category || r.category_ar) ?? "",
            paidTo: r.vendor ?? "",
            note: r.note ?? "",
            recurring: r.recurring ? X.yes : X.no,
            recordedBy: r.recorded_by ?? "",
          })),
          totals: kept.length ? { date: X.total, amount: Math.round(total * 100) / 100 } : undefined,
        },
      ],
    },
  };
}
