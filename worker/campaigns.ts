import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { withSystem } from "./db";
import { sessions } from "./wa/session";
import { withinWindow } from "./automations";
import { loadContext, renderTemplate } from "./templates";
import { queueWhatsAppMessage } from "../src/lib/outbound";
import { licensed } from "./features";

/**
 * Campaign drip.
 *
 * A campaign sends nothing. Once per configured interval it moves exactly one
 * recipient into the ordinary outbox, and everything after that is the existing
 * outbound sender's job — the randomized gap, the daily cap, the failure pause.
 * That is deliberate: bulk messaging is the fastest way to lose a WhatsApp
 * number, and it should not get a private path around the rails.
 *
 * The corollary is that this loop must not run ahead of those rails. Queueing a
 * hundred recipients while the number is paused would look like pacing and
 * behave like a blast the moment the pause lifted, so every condition that
 * stops the sender also stops the pump, and the drip resumes where it left off.
 */

export function startCampaignLoop() {
  const tick = async () => {
    try {
      await reconcileDelivery();
      await processOnce();
    } catch (e) {
      console.error("[campaigns]", (e as Error).message);
    }
    setTimeout(tick, 2000);
  };
  void tick();
}

/**
 * Recipients follow their message. The outbound sender only knows about the
 * outbox, so the campaign's own view of who was reached is caught up here.
 */
export async function reconcileDelivery() {
  await withSystem((c) =>
    c.query(
      `update campaign_recipients r
       set status = case
             when m.status in ('sent', 'delivered', 'read') then 'sent'
             when m.status = 'failed' then 'failed'
             else 'cancelled'
           end,
           error = m.error
       from messages m
       where m.id = r.message_id
         and r.status = 'queued'
         and m.status in ('sent', 'delivered', 'read', 'failed', 'cancelled')`
    )
  );
}

async function processOnce() {
  const connected = [...sessions.entries()].filter(([, s]) => s.connected);
  await Promise.all(connected.map(([clinicId]) => pumpClinic(clinicId)));
}

/**
 * One clinic's turn: release at most one recipient, or decide why not.
 * Exported so the campaign QA suite can drive the pacing rules directly —
 * they are the whole safety story and must not need a live WhatsApp socket
 * to test.
 */
export async function pumpClinic(clinicId: string) {
  await withSystem(async (c) => {
    /*
      Joined to clinics so the licence is part of the question. A drip that was
      started while the clinic had Campaigns would otherwise keep releasing
      recipients after the agency withdrew the module — the clinic could no
      longer open the screen to stop it, and neither could they see it running.
    */
    const due = (
      await c.query(
        `select 1 from campaigns ca join clinics cl on cl.id = ca.clinic_id
          where ca.clinic_id = $1 and ca.status = 'running'
            and ${licensed("campaigns")} limit 1`,
        [clinicId]
      )
    ).rowCount;
    if (!due) return;

    const ses = (
      await c.query(
        // outbound_date::text so it compares against a clinic-local ISO day;
        // as a `date` node-pg hands back a JS Date in the server's zone.
        `select ws.paused_until, ws.outbound_today, ws.outbound_date::text as outbound_date,
                cl.daily_outbound_cap, cl.timezone, cl.message_window_start, cl.message_window_end
         from whatsapp_sessions ws join clinics cl on cl.id = ws.clinic_id
         where ws.clinic_id = $1`,
        [clinicId]
      )
    ).rows[0];
    if (!ses) return;

    // Paused for repeated send failures: hold the drip rather than pile up work
    // that would flush all at once when the pause lifts.
    if (ses.paused_until && new Date(ses.paused_until) > new Date()) {
      await deferRunning(c, clinicId, DateTime.fromJSDate(new Date(ses.paused_until)));
      return;
    }

    const tz = ses.timezone as string;
    const windowStart = String(ses.message_window_start).slice(0, 5);
    const windowEnd = String(ses.message_window_end).slice(0, 5);
    const now = DateTime.now().setZone(tz);
    const sendAt = withinWindow(now, tz, windowStart, windowEnd);

    // Outside the clinic's messaging hours — resume when the window opens.
    if (sendAt > now) {
      await deferRunning(c, clinicId, sendAt);
      return;
    }

    // Daily cap: the sender would defer these to tomorrow one by one, which
    // would empty the whole campaign into the outbox tonight. Hold instead.
    const today = now.toISODate();
    const usedToday = ses.outbound_date === today ? Number(ses.outbound_today) : 0;
    if (usedToday >= Number(ses.daily_outbound_cap)) {
      const tomorrow = withinWindow(now.plus({ days: 1 }).startOf("day"), tz, windowStart, windowEnd);
      await deferRunning(c, clinicId, tomorrow);
      return;
    }

    // Claim a due campaign and move its clock forward in the same statement, so
    // a second worker cannot pick up the same slot.
    const campaign = (
      await c.query(
        `update campaigns
         set next_send_at = now() + (interval_seconds * interval '1 second')
         where id = (
           select id from campaigns
           where clinic_id = $1 and status = 'running'
             and next_send_at is not null and next_send_at <= now()
           order by next_send_at
           limit 1 for update skip locked
         )
         returning id, body, interval_seconds`,
        [clinicId]
      )
    ).rows[0];
    if (!campaign) return;

    const recipient = (
      await c.query(
        `update campaign_recipients
         set status = 'queued', queued_at = now()
         where id = (
           select id from campaign_recipients
           where campaign_id = $1 and status = 'pending'
           order by sort
           limit 1 for update skip locked
         )
         returning id, patient_id, phone_e164`,
        [campaign.id]
      )
    ).rows[0];

    if (!recipient) {
      await c.query(
        `update campaigns set status = 'done', finished_at = now(), next_send_at = null
         where id = $1 and not exists (
           select 1 from campaign_recipients where campaign_id = $1 and status = 'pending'
         )`,
        [campaign.id]
      );
      return;
    }

    /*
      Anyone who opted out since the list was frozen.

      The audience is a snapshot taken when the campaign was built, which is what
      makes "who did this actually go to" answerable — but it also means somebody
      who asked to be left alone this morning is still sitting in a drip that
      started yesterday. Checked on the one recipient just claimed rather than
      swept across the table: this loop runs every two seconds per clinic, and
      the cheap question is the one being asked anyway.

      Cancelled rather than removed, so the campaign's own report still accounts
      for them, and the tick returns — the next one takes the following name.
    */
    if (recipient.patient_id) {
      const muted = await c.query(
        `select 1 from patients where id = $1 and clinic_id = $2 and automation_opt_out`,
        [recipient.patient_id, clinicId]
      );
      if (muted.rowCount) {
        await c.query(
          `update campaign_recipients set status = 'cancelled', error = 'opted out' where id = $1`,
          [recipient.id]
        );
        return;
      }
    }

    const ctx = await loadContext(c, { clinicId, patientId: recipient.patient_id });
    const body = renderTemplate(campaign.body, ctx).trim();
    if (!body) {
      await c.query(
        `update campaign_recipients set status = 'failed', error = 'empty message' where id = $1`,
        [recipient.id]
      );
      return;
    }

    const { messageId } = await queueWhatsAppMessage(c, {
      clinicId,
      phoneE164: recipient.phone_e164,
      body,
      senderKind: "campaign",
      patientId: recipient.patient_id,
    });
    await c.query(`update campaign_recipients set message_id = $2 where id = $1`, [
      recipient.id,
      messageId,
    ]);
  });
}

/** Hold every running campaign in this clinic until `at`. */
async function deferRunning(c: PoolClient, clinicId: string, at: DateTime) {
  await c.query(
    `update campaigns set next_send_at = greatest(next_send_at, $2::timestamptz)
     where clinic_id = $1 and status = 'running'`,
    [clinicId, at.toUTC().toISO()]
  );
}
