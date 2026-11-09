import { guardCap } from "@/lib/guard";
import { WhatsappClient } from "./whatsapp-client";
import { Deliverability } from "./deliverability";
import { can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { UNDELIVERED_AFTER_HOURS } from "@/lib/wa-delivery";

export default async function WhatsappSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings.whatsapp");

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
              count(*) filter (where status in ('queued', 'sending'))::int as pending,
              -- Cancelled with a reason is the sender giving up on a stale
              -- reminder; without one it is a campaign someone stopped.
              count(*) filter (where status = 'cancelled' and error is not null)::int as cancelled,
              count(*) filter (where status = 'sent' and delivered_at is null
                                and coalesce(sent_at, created_at) < now() - make_interval(hours => $2))::int as undelivered
         from messages
        where clinic_id = $1 and direction = 'out'
          and created_at > now() - interval '7 days'`,
      [access.clinicId, UNDELIVERED_AFTER_HOURS]
    );
    const bad = await c.query(
      `select count(*)::int as n from conversations where clinic_id = $1 and on_whatsapp = false`,
      [access.clinicId]
    );
    /*
      The messages themselves, each with its reason. A count says something is
      wrong; this says what, and to whom, and links to the chat where it can be
      sent again. Ones already sent again are left out — they are dealt with.
    */
    const problems = await c.query(
      `select m.id, m.conversation_id, m.direction, m.status, m.error, m.created_at, m.sent_at,
              m.scheduled_at, m.delivered_at, m.sender_kind,
              coalesce(p.full_name, cv.whatsapp_name) as name, cv.phone_e164, cv.identifier_kind
         from messages m
         join conversations cv on cv.id = m.conversation_id
         left join patients p on p.id = cv.patient_id
        where m.clinic_id = $1 and m.direction = 'out'
          and m.created_at > now() - interval '7 days'
          and m.resent_at is null
          and (m.status = 'failed'
               or (m.status = 'cancelled' and m.error is not null)
               or (m.status = 'sent' and m.delivered_at is null
                   and coalesce(m.sent_at, m.created_at) < now() - make_interval(hours => $2)))
        order by m.created_at desc
        limit 25`,
      [access.clinicId, UNDELIVERED_AFTER_HOURS]
    );
    return { ...r.rows[0], unreachable: bad.rows[0].n as number, problems: problems.rows };
  });

  return (
    <div className="grid gap-4">
      <WhatsappClient
        slug={slug}
        canEdit={can(access, "settings.whatsapp")}
        canSetCap={can(access, "settings.clinic")}
      />
      <Deliverability stats={JSON.parse(JSON.stringify(stats))} slug={slug} tz={access.clinic.timezone} />
    </div>
  );
}
