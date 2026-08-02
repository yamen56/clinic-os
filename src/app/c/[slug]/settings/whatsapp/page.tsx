import { guardClinic } from "@/lib/guard";
import { WhatsappClient } from "./whatsapp-client";
import { Deliverability } from "./deliverability";
import { can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";

export default async function WhatsappSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);

  /*
    What actually landed this week. Connection status on its own says nothing
    about delivery — a session can sit green while every message goes to a
    number that has no WhatsApp account.
  */
  const stats = await inClinic(access, async (c) => {
    const r = await c.query(
      `select count(*)::int                                                as total,
              count(*) filter (where status in ('delivered', 'read'))::int as delivered,
              count(*) filter (where status = 'read')::int                 as read,
              count(*) filter (where status = 'sent')::int                 as sent,
              count(*) filter (where status = 'failed')::int               as failed,
              count(*) filter (where status = 'failed'
                                and error = 'no_whatsapp_account')::int    as no_account,
              count(*) filter (where status in ('queued', 'sending'))::int as pending
         from messages
        where clinic_id = $1 and direction = 'out'
          and created_at > now() - interval '7 days'`,
      [access.clinicId]
    );
    const bad = await c.query(
      `select count(*)::int as n from conversations where clinic_id = $1 and on_whatsapp = false`,
      [access.clinicId]
    );
    return { ...r.rows[0], unreachable: bad.rows[0].n as number };
  });

  return (
    <div className="grid gap-4">
      <WhatsappClient slug={slug} canEdit={can(access, "settings")} />
      <Deliverability stats={JSON.parse(JSON.stringify(stats))} />
    </div>
  );
}
