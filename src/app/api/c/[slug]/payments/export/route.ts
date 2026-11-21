import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { ownInvoicesOnly } from "@/lib/invoice-scope";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { asExportFormat } from "@/lib/exports/table";
import { MAX_SHEET_ROWS, paymentsTable } from "@/lib/exports/payments";
import { sendExport, tooMany } from "@/lib/exports/respond";

/**
 * The payments taken in a period — Excel, CSV (the default, as it always was)
 * or PDF. See lib/exports.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  /*
    `invoices.analytics`, not `invoices`. This file is every payment the clinic
    has ever taken — the same number as the Analytics figures, in a different
    shape — and it was guarded one rung lower than they are. A receptionist who
    had just been stopped from seeing the takings could still download them.
    And never for a member filtered to their own invoices, whom the Analytics
    page turns away for the same reason: every row here is the clinic's.
  */
  const g = await apiClinic(slug, "invoices.analytics");
  if (!g.ok) return g.res;
  if (ownInvoicesOnly(g.access)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const format = asExportFormat(url.searchParams.get("format"), "csv");
  const range = { from: url.searchParams.get("from"), to: url.searchParams.get("to") };
  const t = await dictForClinic(g.access.clinic.vocabulary);
  const locale = (await getLocale()) === "ar" ? "ar" : "en";

  const { table, over } = await inClinic(g.access, (c) => paymentsTable(c, g.access, range, t, locale));
  if (over) return tooMany(over, MAX_SHEET_ROWS);
  return sendExport({ access: g.access, table, format, action: "payments.export", detail: range });
}
