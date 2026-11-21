import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import type { ClinicAccess } from "@/lib/auth";
import type { Dict } from "@/lib/i18n/en";
import type { ExportTable } from "./table";

/** Rows a payments or expenses spreadsheet carries before the export asks for a narrower period. */
export const MAX_SHEET_ROWS = 20_000;

/**
 * The payments taken in a period, as an export.
 *
 * A cancelled invoice's payments are not money taken, so they are left out —
 * the same rule as every takings figure in the product. Over MAX_SHEET_ROWS
 * the caller refuses rather than handing back a file that silently stops
 * (it used to stop at 5,000 without a word).
 */
export async function paymentsTable(
  c: PoolClient,
  access: ClinicAccess,
  range: { from: string | null; to: string | null },
  t: Dict,
  locale: "ar" | "en"
): Promise<{ table: ExportTable; over: number | null }> {
  const conds = ["pay.clinic_id = $1", "i.status <> 'void'"];
  const vals: unknown[] = [access.clinicId];
  if (range.from) {
    vals.push(range.from);
    conds.push(`pay.paid_at >= $${vals.length}`);
  }
  if (range.to) {
    vals.push(range.to);
    conds.push(`pay.paid_at < $${vals.length}`);
  }
  const rows = (
    await c.query(
      `select pay.paid_at, pay.amount::float8 as amount, pay.method, pay.reference,
              i.number as invoice_number, i.currency, p.full_name as patient, u.full_name as recorded_by
         from payments pay
         join invoices i on i.id = pay.invoice_id
         join patients p on p.id = pay.patient_id
         left join users u on u.id = pay.recorded_by
        where ${conds.join(" and ")}
        order by pay.paid_at desc
        limit ${MAX_SHEET_ROWS + 1}`,
      vals
    )
  ).rows;

  // Past the cap, the real number, so the message says how far over it is.
  const over =
    rows.length > MAX_SHEET_ROWS
      ? Number(
          (await c.query(`select count(*)::int as n from payments pay join invoices i on i.id = pay.invoice_id where ${conds.join(" and ")}`, vals))
            .rows[0].n
        )
      : null;
  const tz = access.clinic.timezone;
  const intl = locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB";
  const X = t.exports;
  const methods = t.invoices.methods as Record<string, string>;
  const day = (iso: string) => DateTime.fromISO(iso, { zone: tz }).setLocale(intl).toFormat("d LLL yyyy");
  const last = range.to ? DateTime.fromISO(range.to, { zone: tz }).minus({ days: 1 }).toISO()! : null;
  const total = rows.slice(0, MAX_SHEET_ROWS).reduce((s, r) => s + Number(r.amount), 0);

  return {
    over,
    table: {
      title: X.paymentsTitle,
      subtitle: range.from && last ? `${day(range.from)} – ${day(last)}` : undefined,
      clinicName: (locale === "ar" && access.clinic.nameAr) || access.clinic.name,
      fileName: `payments-${access.clinic.slug}-${DateTime.now().setZone(tz).toISODate()}`,
      locale,
      currency: access.clinic.currency,
      sheets: [
        {
          name: X.paymentsTitle,
          columns: [
            { key: "date", label: X.date, kind: "date" },
            { key: "amount", label: X.amount, kind: "money" },
            { key: "currency", label: X.currency },
            { key: "method", label: X.method },
            { key: "invoice", label: X.invoice },
            { key: "patient", label: X.patient },
            { key: "reference", label: X.reference },
            { key: "recordedBy", label: X.recordedBy },
          ],
          rows: rows.slice(0, MAX_SHEET_ROWS).map((r) => ({
            date: DateTime.fromJSDate(new Date(r.paid_at)).setZone(tz).toFormat("yyyy-MM-dd HH:mm"),
            amount: Number(r.amount),
            currency: r.currency,
            method: methods[r.method] ?? r.method,
            invoice: r.invoice_number,
            patient: r.patient,
            reference: r.reference ?? "",
            recordedBy: r.recorded_by ?? "",
          })),
          totals: rows.length ? { date: X.total, amount: Math.round(total * 100) / 100 } : undefined,
        },
      ],
    },
  };
}
