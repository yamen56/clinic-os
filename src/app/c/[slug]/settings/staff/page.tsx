import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { StaffClient } from "./staff-client";
import { can } from "@/lib/auth";

export default async function StaffSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (!can(access, "settings.staff")) redirect(`/c/${slug}/settings`);

  const members = await inClinic(access, async (c) => {
    const r = await c.query(
      `select cm.id, cm.role, cm.is_owner, cm.title, cm.specialty, cm.color, cm.active,
              cm.reminder_minutes, cm.meeting_url, cm.permissions, cm.working_hours, u.full_name, u.email,
              (u.avatar_path is not null) as has_photo
       from clinic_members cm join users u on u.id = cm.user_id
       where cm.clinic_id = $1 order by cm.created_at`,
      [access.clinicId]
    );
    return r.rows;
  });

  return (
    <StaffClient
      slug={slug}
      members={JSON.parse(JSON.stringify(members))}
      selfId={access.memberId}
      viewerIsOwner={access.isOwner}
    />
  );
}
