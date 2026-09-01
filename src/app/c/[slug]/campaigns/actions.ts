"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, type ClinicAccess, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { patientFilterSql, type PatientFilters } from "@/lib/patients";
import {
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  type CampaignAudience,
} from "./constants";

/**
 * Who a campaign may actually be sent to.
 *
 * A number to send to, and no standing request not to be sent to. Written once
 * and used by the preview, the audience snapshot and the count beside it, so
 * the number the user approves is the number of people who get the message —
 * the preview promising 200 and the send reaching 190 would be a worse bug than
 * either figure being wrong.
 */
const SENDABLE = "p.phone_e164 is not null and not p.automation_opt_out";
/*
  Note what this does to a filter of `optedOut: "1"`: the two conditions cancel
  and the audience is empty. That is the right answer rather than an edge case to
  handle — "send a campaign to everyone who asked not to receive campaigns" has
  no sensible reading, and an empty audience says so where quietly dropping the
  filter would send to everybody instead.
*/

/**
 * Bulk messaging is the one action here that can reach hundreds of patients at
 * once, so it sits behind the same flag as automations rather than being open
 * to anyone who can open a conversation.
 */
function assertCanSend(access: ClinicAccess) {
  const allowed = can(access, "campaigns");
  if (!allowed) throw new Error("forbidden");
}

/** How many patients this filter would actually message, before committing to it. */
export async function previewAudienceAction(
  slug: string,
  filters: PatientFilters
): Promise<CampaignAudience> {
  const access = await requireClinic(slug);
  assertCanSend(access);
  const { where, values } = patientFilterSql(access.clinicId, filters);

  return inClinic(access, async (c) => {
    const r = await c.query(
      `select
         (select count(*)::int from patients p where ${where}) as total,
         (select count(distinct p.phone_e164)::int from patients p
           where ${where} and ${SENDABLE}) as reachable,
         (select count(*)::int from patients p where ${where} and p.automation_opt_out) as muted,
         coalesce((
           select json_agg(s.name) from (
             select p.full_name as name from patients p
             where ${where} and ${SENDABLE}
             order by p.full_name limit 5
           ) s
         ), '[]'::json) as sample`,
      values
    );
    const row = r.rows[0];
    return {
      total: row.total,
      reachable: row.reachable,
      muted: row.muted,
      sample: row.sample ?? [],
    };
  });
}

/**
 * Builds the campaign and freezes its audience.
 *
 * The recipient list is a snapshot, not a live query: a drip runs for hours, and
 * a patient tagged halfway through should not silently join a send that was
 * already reviewed and approved.
 */
export async function createCampaignAction(
  slug: string,
  input: { name: string; body: string; intervalSeconds: number; filters: PatientFilters }
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  assertCanSend(access);

  const name = input.name.trim().slice(0, 120);
  const body = input.body.trim();
  if (!name) return { error: "nameRequired" };
  if (!body) return { error: "messageRequired" };

  const interval = Math.round(input.intervalSeconds);
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) {
    return { error: "badInterval" };
  }

  // $1 and $2 are the clinic and the new campaign, so the filter starts at $3.
  const { where, values } = patientFilterSql(access.clinicId, input.filters, 3);

  return inClinic(access, async (c) => {
    const campaign = (
      await c.query(
        `insert into campaigns (clinic_id, name, body, filters, interval_seconds, created_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [
          access.clinicId,
          name,
          body,
          JSON.stringify(input.filters ?? {}),
          interval,
          access.session.user.id,
        ]
      )
    ).rows[0];

    // One row per reachable number. Two patient files sharing a phone get one
    // message, and `sort` fixes the order the drip will follow.
    const inserted = await c.query(
      `insert into campaign_recipients (clinic_id, campaign_id, patient_id, phone_e164, full_name, sort)
       select $1, $2, s.id, s.phone_e164, s.full_name,
              row_number() over (order by s.full_name, s.id)
       from (
         select distinct on (p.phone_e164) p.id, p.phone_e164, p.full_name
         from patients p
         where ${where} and ${SENDABLE}
         order by p.phone_e164, p.updated_at desc
       ) s`,
      [access.clinicId, campaign.id, ...values]
    );

    await c.query(`update campaigns set total_count = $2 where id = $1`, [
      campaign.id,
      inserted.rowCount ?? 0,
    ]);

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "campaign.create",
      entity: "campaign",
      entityId: campaign.id,
      detail: { name, recipients: inserted.rowCount, intervalSeconds: interval },
    });
    return { id: campaign.id as string };
  });
}

/** Hands the campaign to the worker. The first recipient goes out immediately. */
export async function startCampaignAction(
  slug: string,
  id: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  assertCanSend(access);

  const result = await inClinic(access, async (c) => {
    const r = await c.query(
      `update campaigns set status = 'running', started_at = coalesce(started_at, now()), next_send_at = now()
       where id = $1 and clinic_id = $2 and status = 'draft'
         and exists (select 1 from campaign_recipients where campaign_id = $1 and status = 'pending')
       returning id, name, total_count`,
      [id, access.clinicId]
    );
    if (!r.rowCount) return { error: "notStartable" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "campaign.start",
      entity: "campaign",
      entityId: id,
      detail: { recipients: r.rows[0].total_count },
    });
    return {};
  });

  revalidatePath(`/c/${slug}/campaigns/${id}`);
  revalidatePath(`/c/${slug}/campaigns`);
  return result;
}

/**
 * Stop means stop. Beyond halting the drip it withdraws the messages already
 * queued but not yet handed to WhatsApp — otherwise "stopped" would still send
 * whatever the outbox had picked up in the last interval.
 */
export async function stopCampaignAction(
  slug: string,
  id: string
): Promise<{ error?: string; withdrawn?: number }> {
  const access = await requireClinic(slug);
  assertCanSend(access);

  const result = await inClinic(access, async (c) => {
    const r = await c.query(
      `update campaigns set status = 'cancelled', finished_at = now(), next_send_at = null
       where id = $1 and clinic_id = $2 and status in ('draft', 'running')
       returning id`,
      [id, access.clinicId]
    );
    if (!r.rowCount) return { error: "notStoppable" };

    // Only 'queued' — anything already 'sending' or 'sent' has left.
    const withdrawn = await c.query(
      `update messages set status = 'cancelled'
       where clinic_id = $2 and status = 'queued'
         and id in (select message_id from campaign_recipients
                    where campaign_id = $1 and message_id is not null)
       returning id`,
      [id, access.clinicId]
    );

    await c.query(
      `update campaign_recipients set status = 'cancelled'
       where campaign_id = $1 and status in ('pending', 'queued')
         and (message_id is null or message_id = any($2::uuid[]))`,
      [id, withdrawn.rows.map((x) => x.id)]
    );

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "campaign.stop",
      entity: "campaign",
      entityId: id,
      detail: { withdrawn: withdrawn.rowCount },
    });
    return { withdrawn: withdrawn.rowCount ?? 0 };
  });

  revalidatePath(`/c/${slug}/campaigns/${id}`);
  revalidatePath(`/c/${slug}/campaigns`);
  return result;
}

export async function deleteCampaignAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  assertCanSend(access);

  const result = await inClinic(access, async (c) => {
    const r = await c.query(
      `delete from campaigns where id = $1 and clinic_id = $2 and status in ('draft', 'cancelled', 'done')
       returning id`,
      [id, access.clinicId]
    );
    return r.rowCount ? {} : { error: "notDeletable" };
  });
  revalidatePath(`/c/${slug}/campaigns`);
  return result;
}
