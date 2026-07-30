import { notFound, redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { CampaignDetail } from "./campaign-detail";

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await guardClinic(slug);
  const canSend = access.role === "owner" || access.permissions.automations === true;
  if (!canSend) redirect(`/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const campaign = (
      await c.query(
        `select c.id, c.name, c.body, c.status, c.interval_seconds, c.total_count, c.filters,
                c.created_at, c.started_at, c.finished_at, c.next_send_at,
                u.full_name as created_by_name,
                cl.message_window_start, cl.message_window_end, cl.daily_outbound_cap,
                coalesce(ws.status, 'disconnected') as wa_status
         from campaigns c
         join clinics cl on cl.id = c.clinic_id
         left join users u on u.id = c.created_by
         left join whatsapp_sessions ws on ws.clinic_id = c.clinic_id
         where c.id = $1 and c.clinic_id = $2`,
        [id, access.clinicId]
      )
    ).rows[0];
    if (!campaign) return null;

    const recipients = (
      await c.query(
        `select r.id, r.full_name, r.phone_e164, r.status, r.error, r.queued_at, m.sent_at
         from campaign_recipients r
         left join messages m on m.id = r.message_id
         where r.campaign_id = $1
         order by r.sort
         limit 500`,
        [id]
      )
    ).rows;

    return { campaign, recipients };
  });

  if (!data) notFound();

  return (
    <CampaignDetail
      slug={slug}
      tz={access.clinic.timezone}
      campaign={JSON.parse(JSON.stringify(data.campaign))}
      recipients={JSON.parse(JSON.stringify(data.recipients))}
    />
  );
}
