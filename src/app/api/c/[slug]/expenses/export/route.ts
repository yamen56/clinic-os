import { apiClinic, inClinic } from "@/lib/clinic-api";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { asExportFormat } from "@/lib/exports/table";
import { MAX_SHEET_ROWS } from "@/lib/exports/payments";
import { expensesTable } from "@/lib/exports/expenses";
import { sendExport, tooMany } from "@/lib/exports/respond";

/**
 * What was spent in a period — the accountant's deliverable. Excel, CSV (the
 * default, as it always was) or PDF. See lib/exports.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "expenses");
  if (!g.ok) return g.res;

  const url = new URL(req.url);
  const format = asExportFormat(url.searchParams.get("format"), "csv");
  // Calendar days on both sides: `spent_on` is a `date`.
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const range = { from: day(url.searchParams.get("from")), to: day(url.searchParams.get("to")) };
  const t = await dictForClinic(g.access.clinic.vocabulary);
  const locale = (await getLocale()) === "ar" ? "ar" : "en";

  const { table, over } = await inClinic(g.access, (c) => expensesTable(c, g.access, range, t, locale));
  if (over) return tooMany(over, MAX_SHEET_ROWS);
  return sendExport({ access: g.access, table, format, action: "expenses.export", detail: range });
}
