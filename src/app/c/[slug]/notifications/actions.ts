"use server";

import { requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";

const KEYS = [
  "doctor_reminder", "daily_summary", "new_booking",
  "cancellation", "unread_digest", "day_end",
] as const;

export async function saveNotificationPrefsAction(
  slug: string,
  prefs: Record<string, boolean>,
  reminderMinutes?: number
) {
  const access = await requireClinic(slug);
  const clean: Record<string, boolean> = {};
  for (const k of KEYS) if (k in prefs) clean[k] = !!prefs[k];

  await inClinic(access, async (c) => {
    await c.query(
      `update users set notification_prefs = notification_prefs || $2::jsonb where id = $1`,
      [access.session.user.id, JSON.stringify(clean)]
    );
    if (access.memberId && typeof reminderMinutes === "number") {
      await c.query(
        `update clinic_members set reminder_minutes = $2 where id = $1 and clinic_id = $3`,
        [access.memberId, Math.max(0, Math.min(1440, reminderMinutes)), access.clinicId]
      );
    }
  });
}
