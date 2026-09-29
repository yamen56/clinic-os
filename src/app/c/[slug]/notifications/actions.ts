"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { PREF_DEFS, PREF_KEYS } from "@/lib/notification-kinds";

const HM = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);

/*
  Everything optional, because each control saves only itself: flipping one
  switch must not write back a stale copy of the others that another tab, or
  another device, changed a minute ago.
*/
const patchSchema = z.object({
  levels: z.partialRecord(z.enum(PREF_KEYS), z.enum(["push", "app", "off"])).optional(),
  quiet: z.object({ on: z.boolean(), from: HM, to: HM, urgent: z.boolean() }).optional(),
  popups: z.boolean().optional(),
  sound: z.boolean().optional(),
  language: z.enum(["ar", "en"]).optional(),
  reminderMinutes: z.number().int().min(0).max(1440).optional(),
});

const LOCKED = new Set(PREF_DEFS.filter((d) => d.lockOff).map((d) => d.key));

/**
 * Saves this person's own notification settings.
 *
 * Authorised by identity rather than a capability: every statement here is
 * addressed to the signed-in user's own row (or their own membership, for the
 * reminder lead time), so there is nobody else's setting it could reach.
 */
export async function saveNotificationPrefsAction(
  slug: string,
  patch: unknown
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) return { error: "invalid" };
  const p = parsed.data;

  const merge: Record<string, unknown> = {};
  for (const [key, level] of Object.entries(p.levels ?? {})) {
    // The ones somebody has to hear about may go quiet on the phone, never away.
    merge[key] = level === "off" && LOCKED.has(key as (typeof PREF_KEYS)[number]) ? "app" : level;
  }
  if (p.quiet) merge.quiet = p.quiet;
  if (p.popups !== undefined) merge.popups = p.popups;
  if (p.sound !== undefined) merge.sound = p.sound;

  await inClinic(access, async (c) => {
    if (Object.keys(merge).length) {
      await c.query(
        `update users set notification_prefs = notification_prefs || $2::jsonb where id = $1`,
        [access.session.user.id, JSON.stringify(merge)]
      );
    }
    if (p.language) {
      await c.query(`update users set locale = $2 where id = $1`, [access.session.user.id, p.language]);
    }
    if (access.memberId && p.reminderMinutes !== undefined) {
      await c.query(
        `update clinic_members set reminder_minutes = $2 where id = $1 and clinic_id = $3`,
        [access.memberId, p.reminderMinutes, access.clinicId]
      );
    }
  });
  // The router keeps a copy of this page for the Back button; without this it
  // would bring back the switches as they were before the change.
  revalidatePath(`/c/${slug}/notifications`);
  return {};
}
