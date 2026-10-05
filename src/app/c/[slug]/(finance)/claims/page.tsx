import { DateTime } from "luxon";
import { guardCap } from "@/lib/guard";
import { can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { isUuid } from "@/lib/uuid";
import { loadClaims, summariseOpenClaims } from "@/lib/claims";
import { ClaimsClient } from "./claims-client";

/**
 * Insurance claims: what each company owes the clinic, and the list to work.
 *
 * Opened with the insurance capability; working the claims takes
 * `insurance.claims`. The rows are scoped like the invoice list — a claim is an
 * invoice seen from the insurer's side — and the tab itself only shows for a
 * clinic with at least one company (lib/finance).
 */
export default async function ClaimsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ insurer?: string; status?: string; month?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardCap(slug, "insurance");
  const today = DateTime.now().setZone(access.clinic.timezone).toISODate()!;

  const filters = {
    insurerId: sp.insurer && isUuid(sp.insurer) ? sp.insurer : null,
    status: sp.status ?? "open",
    month: sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : null,
  };

  const data = await inClinic(access, async (c) => {
    const rows = await loadClaims(c, access, filters);
    const summary = await summariseOpenClaims(c, access, today);
    const insurers = (
      await c.query(`select id, name from insurers where clinic_id = $1 order by active desc, name`, [
        access.clinicId,
      ])
    ).rows;
    return { rows, summary, insurers };
  });

  return (
    <ClaimsClient
      slug={slug}
      currency={access.clinic.currency}
      today={today}
      filters={filters}
      rows={JSON.parse(JSON.stringify(data.rows))}
      summary={data.summary}
      insurers={JSON.parse(JSON.stringify(data.insurers))}
      canWork={can(access, "insurance.claims")}
      canOpenInvoices={can(access, "invoices")}
      canOpenPatients={can(access, "patients")}
    />
  );
}
