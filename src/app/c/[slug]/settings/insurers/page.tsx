import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { InsurersClient } from "./insurers-client";

export default async function InsurersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (!can(access, "settings")) redirect(`/c/${slug}`);

  const rows = await inClinic(access, async (c) =>
    (
      await c.query(
        `select i.id, i.name, i.code, i.notes, i.active,
                (select count(*)::int from patients p
                  where p.insurer_id = i.id and p.merged_into is null) as patients,
                (select count(*)::int from invoices v
                  where v.insurer_id = i.id and v.claim_status in ('to_submit','submitted')) as open_claims
           from insurers i
          where i.clinic_id = $1
          order by i.active desc, i.name`,
        [access.clinicId]
      )
    ).rows
  );

  return <InsurersClient slug={slug} initial={JSON.parse(JSON.stringify(rows))} />;
}
