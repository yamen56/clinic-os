import { apiClinic, inClinic } from "@/lib/clinic-api";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { isUuid } from "@/lib/uuid";
import { asExportFormat } from "@/lib/exports/table";
import { claimsTable } from "@/lib/exports/claims";
import { sendExport } from "@/lib/exports/respond";

/**
 * A company's claims for a month, as the statement it asks for — Excel (the
 * default: a claims sheet with totals and a sheet of service lines), CSV (the
 * claims sheet) or PDF (both). See lib/exports/claims.
 *
 * Gated on working the claims (`insurance.claims`), scoped like the claims
 * screen, and audited: this is patient data, with national numbers, leaving
 * the building.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "insurance.claims");
  if (!g.ok) return g.res;
  const access = g.access;
  const url = new URL(req.url);
  const insurerId = url.searchParams.get("insurer");
  const month = url.searchParams.get("month");
  const filters = {
    insurerId: insurerId && isUuid(insurerId) ? insurerId : null,
    status: url.searchParams.get("status") ?? "open",
    month: month && /^\d{4}-\d{2}$/.test(month) ? month : null,
  };
  const format = asExportFormat(url.searchParams.get("format"), "xlsx");
  const t = await dictForClinic(access.clinic.vocabulary);
  const locale = (await getLocale()) === "ar" ? "ar" : "en";

  const table = await inClinic(access, (c) => claimsTable(c, access, filters, t, locale));
  return sendExport({ access, table, format, action: "claims.export", detail: filters });
}
