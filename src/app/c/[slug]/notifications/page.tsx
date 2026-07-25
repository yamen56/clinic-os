import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { NotificationsClient } from "./notifications-client";

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);

  const data = await inClinic(access, async (c) => {
    const prefs = (
      await c.query(`select notification_prefs from users where id = $1`, [access.session.user.id])
    ).rows[0].notification_prefs as Record<string, boolean>;
    const member = access.memberId
      ? (
          await c.query(`select reminder_minutes from clinic_members where id = $1`, [access.memberId])
        ).rows[0]
      : null;
    const tz = (await c.query(`select timezone from clinics where id = $1`, [access.clinicId])).rows[0]
      .timezone as string;
    return { prefs: prefs ?? {}, reminderMinutes: member?.reminder_minutes ?? 30, tz };
  });

  return (
    <NotificationsClient
      slug={slug}
      tz={data.tz}
      isDoctor={access.role === "doctor"}
      prefs={data.prefs}
      reminderMinutes={data.reminderMinutes}
    />
  );
}
