"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, type ClinicAccess, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { patientFilterSql, type PatientFilters } from "@/lib/patients";
import { deleteFile } from "@/lib/storage";
import {
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  type CampaignAudience,
  type VideoMeta,
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

type Attachment = {
  kind: "image" | "video";
  path: string;
  name: string;
  mime: string;
  meta: VideoMeta | null;
};

/**
 * The file the upload route stored, checked rather than believed.
 *
 * The path arrives from the browser, so it must be one the route could have
 * written for this clinic — anything else would let a campaign send another
 * clinic's file, or a patient document from this one, to the whole audience.
 * The kind comes off the extension the route chose, and the name off the path,
 * so nothing the browser says about the file is kept.
 *
 * Undefined means "not a file this clinic uploaded"; null means no file at all.
 */
function attachment(
  clinicId: string,
  input: { path?: unknown; meta?: unknown } | null | undefined
): Attachment | null | undefined {
  if (!input) return null;
  const path = String(input.path ?? "");
  const m = path.match(new RegExp(`^${clinicId}/campaign-media/[0-9a-f]{8}-([^/\\\\]+\\.(jpg|mp4))$`));
  if (!m) return undefined;
  const kind = m[2] === "mp4" ? "video" : "image";
  return {
    kind,
    path,
    name: m[1],
    mime: kind === "video" ? "video/mp4" : "image/jpeg",
    meta: kind === "video" ? videoMeta(input.meta) : null,
  };
}

/**
 * What the browser measured about a video, kept only where it is plausible.
 * Every field is optional: a frame that would not decode just means WhatsApp
 * draws its own placeholder, which is no reason to refuse the campaign.
 */
function videoMeta(raw: unknown): VideoMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: VideoMeta = {};
  const dim = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 8192 ? v : undefined;
  out.width = dim(r.width);
  out.height = dim(r.height);
  if (typeof r.seconds === "number" && r.seconds > 0 && r.seconds <= 86400) {
    out.seconds = Math.max(1, Math.round(r.seconds));
  }
  // A small JPEG, and only that: it is copied into every outgoing message.
  if (
    typeof r.thumb === "string" &&
    r.thumb.length <= 64 * 1024 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(r.thumb) &&
    Buffer.from(r.thumb.slice(0, 8), "base64").subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
  ) {
    out.thumb = r.thumb;
  }
  const kept = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length ? (kept as VideoMeta) : null;
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
  input: {
    name: string;
    body: string;
    intervalSeconds: number;
    filters: PatientFilters;
    /** From the upload route. With a file attached the message is its caption, and may be empty. */
    media?: { path: string; meta?: VideoMeta | null } | null;
  }
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  assertCanSend(access);

  const name = input.name.trim().slice(0, 120);
  const body = input.body.trim();
  const media = attachment(access.clinicId, input.media);
  if (!name) return { error: "nameRequired" };
  if (media === undefined) return { error: "badMedia" };
  if (!body && !media) return { error: "messageRequired" };

  const interval = Math.round(input.intervalSeconds);
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) {
    return { error: "badInterval" };
  }

  // $1 and $2 are the clinic and the new campaign, so the filter starts at $3.
  const { where, values } = patientFilterSql(access.clinicId, input.filters, 3);

  return inClinic(access, async (c) => {
    const campaign = (
      await c.query(
        `insert into campaigns (clinic_id, name, body, filters, interval_seconds, created_by,
                                media_kind, media_path, media_name, media_mime, media_meta)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [
          access.clinicId,
          name,
          body,
          JSON.stringify(input.filters ?? {}),
          interval,
          access.session.user.id,
          media?.kind ?? null,
          media?.path ?? null,
          media?.name ?? null,
          media?.mime ?? null,
          media?.meta ? JSON.stringify(media.meta) : null,
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
      detail: {
        name,
        recipients: inserted.rowCount,
        intervalSeconds: interval,
        media: media?.kind ?? null,
      },
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

  /*
    The file goes with the campaign only if nobody was ever queued. Every
    recipient's message points at the same stored file, and those messages stay
    in the conversations after the campaign is gone ("Messages already sent stay
    in the conversations") — removing it would blank the photo in every one of
    those threads. Asked before the delete, because the recipients cascade.
  */
  const result = await inClinic(access, async (c) => {
    const r = await c.query(
      `with orphan as (
         select media_path from campaigns
          where id = $1 and clinic_id = $2 and media_path is not null
            and not exists (select 1 from campaign_recipients
                             where campaign_id = $1 and message_id is not null)
       )
       delete from campaigns where id = $1 and clinic_id = $2 and status in ('draft', 'cancelled', 'done')
       returning (select media_path from orphan) as orphan_path`,
      [id, access.clinicId]
    );
    if (!r.rowCount) return { error: "notDeletable" } as const;
    return { orphanPath: r.rows[0].orphan_path as string | null };
  });
  // After the commit: a rolled-back delete must not have taken the file with it.
  if ("orphanPath" in result && result.orphanPath) await deleteFile(result.orphanPath);
  revalidatePath(`/c/${slug}/campaigns`);
  return "error" in result ? { error: result.error } : {};
}
