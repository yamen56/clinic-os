import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { CampaignsClient } from "./campaigns-client";

export default async function CampaignsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  const canSend = access.role === "owner" || access.permissions.automations === true;
  if (!canSend) redirect(`/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const campaigns = (
      await c.query(
        `select c.id, c.name, c.status, c.interval_seconds, c.total_count, c.created_at,
                c.started_at, c.finished_at, c.next_send_at,
                count(*) filter (where r.status = 'sent')::int as sent,
                count(*) filter (where r.status = 'failed')::int as failed,
                count(*) filter (where r.status = 'pending')::int as pending
         from campaigns c
         left join campaign_recipients r on r.campaign_id = c.id
         where c.clinic_id = $1
         group by c.id
         order by c.created_at desc
         limit 50`,
        [access.clinicId]
      )
    ).rows;
    const tags = (
      await c.query(
        `select distinct unnest(tags) as tag from patients where clinic_id = $1 order by 1 limit 50`,
        [access.clinicId]
      )
    ).rows.map((r) => r.tag as string);
    return { campaigns, tags };
  });

  return (
    <CampaignsClient
      slug={slug}
      tz={access.clinic.timezone}
      allTags={data.tags}
      campaigns={JSON.parse(JSON.stringify(data.campaigns))}
    />
  );
}
