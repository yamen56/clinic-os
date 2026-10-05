import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { InsurersClient } from "./insurers-client";

export default async function InsurersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Insurance, not only Settings: the companies are the first thing the
  // insurance switch is meant to take away. REQUIRES ties this to both.
  const access = await guardCap(slug, "insurance.companies");

  const rows = await inClinic(access, async (c) =>
    (
      await c.query(
        `select i.id, i.name, i.code, i.notes, i.active, i.coverage_percent, i.coverage_cap,
                (select count(*)::int from patients p
                  where p.insurer_id = i.id and p.merged_into is null) as patients,
                (select count(*)::int from invoices v
                  where v.insurer_id = i.id and v.claim_status in ('to_submit','submitted','approved','rejected')
                    and v.status <> 'void') as open_claims
           from insurers i
          where i.clinic_id = $1
          order by i.active desc, i.name`,
        [access.clinicId]
      )
    ).rows
  );

  return <InsurersClient slug={slug} initial={JSON.parse(JSON.stringify(rows))} />;
}
