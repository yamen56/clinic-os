import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { alertKindsFor } from "@/lib/staff-alerts";
import { PREF_DEFS, levelOf, parseQuiet, type PrefKey, type NotificationLevel } from "@/lib/notification-kinds";
import { NotificationsClient } from "./notifications-client";

export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { slug } = await params;
  const { tab } = await searchParams;
  const access = await guardClinic(slug);

  const data = await inClinic(access, async (c) => {
    const me = (
      await c.query(`select notification_prefs, locale from users where id = $1`, [access.session.user.id])
    ).rows[0];
    const member = access.memberId
      ? (
          await c.query(`select reminder_minutes from clinic_members where id = $1`, [access.memberId])
        ).rows[0]
      : null;
    const alertKinds = await alertKindsFor(c, access.clinicId, {
      role: access.role,
      isOwner: access.isOwner,
    });
    return {
      prefs: (me?.notification_prefs ?? {}) as Record<string, unknown>,
      locale: me?.locale === "en" ? ("en" as const) : ("ar" as const),
      reminderMinutes: (member?.reminder_minutes as number | undefined) ?? 30,
      alertKinds,
    };
  });

  /*
    A switch is offered only for what this person can actually be sent — by
    their access, and by which of the clinic's alerts name their role. The page
    used to split the world into "doctor" and "everyone else", so an owner who
    also sees patients could not mute their own reminders, and a receptionist
    was offered a switch for cancellation alerts that did not exist.
  */
  const audience = {
    role: access.role,
    isOwner: access.isOwner,
    caps: access.caps as Record<string, boolean>,
    alertKinds: data.alertKinds,
  };
  const rows = PREF_DEFS.filter((d) => d.shownTo(audience)).map((d) => ({
    key: d.key,
    group: d.group,
    lockOff: !!d.lockOff,
  }));
  const levels = Object.fromEntries(rows.map((r) => [r.key, levelOf(data.prefs, r.key)])) as Record<
    PrefKey,
    NotificationLevel
  >;

  return (
    <NotificationsClient
      slug={slug}
      tz={access.clinic.timezone}
      initialTab={tab === "settings" ? "settings" : "inbox"}
      rows={rows}
      levels={levels}
      quiet={parseQuiet(data.prefs.quiet)}
      inApp={{ popups: data.prefs.popups !== false, sound: data.prefs.sound === true }}
      language={data.locale}
      showReminder={data.alertKinds.has("appointment_reminder") && access.role === "doctor"}
      reminderMinutes={data.reminderMinutes}
      canManageAlerts={access.caps.automations === true}
    />
  );
}
