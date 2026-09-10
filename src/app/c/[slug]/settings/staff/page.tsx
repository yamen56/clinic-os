import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { withSystem } from "@/lib/db";
import { StaffClient } from "./staff-client";
import { can } from "@/lib/auth";

export default async function StaffSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (!can(access, "settings.staff")) redirect(`/c/${slug}/settings`);

  const members = await inClinic(access, async (c) => {
    const r = await c.query(
      `select cm.id, cm.user_id, cm.role, cm.is_owner, cm.title, cm.specialty, cm.color, cm.active,
              cm.reminder_minutes, cm.meeting_url, cm.permissions, cm.working_hours, u.full_name, u.email,
              (u.avatar_path is not null) as has_photo
       from clinic_members cm join users u on u.id = cm.user_id
       where cm.clinic_id = $1 order by cm.created_at`,
      [access.clinicId]
    );
    return r.rows;
  });

  /*
    Which of these people also work somewhere else on this platform.

    It decides one thing: whether this clinic may edit their name, which lives on
    the shared `users` row rather than on the membership. It cannot be asked
    inside `inClinic` — RLS on `clinic_members` hides other clinics' rows, so the
    count would come back zero for everyone and the screen would offer an edit
    the server then refuses.
  */
  const shared = await withSystem(async (sc) => {
    const r = await sc.query(
      `select distinct user_id from clinic_members
        where user_id = any($1::uuid[]) and clinic_id <> $2`,
      [members.map((m) => m.user_id), access.clinicId]
    );
    return new Set(r.rows.map((x) => x.user_id as string));
  });

  // `user_id` was only needed for the question above; the browser gets the answer.
  const rows = members.map(({ user_id, ...m }) => ({
    ...m,
    shared_account: shared.has(user_id as string),
  }));

  return (
    <StaffClient
      slug={slug}
      members={JSON.parse(JSON.stringify(rows))}
      selfId={access.memberId}
      viewerIsOwner={access.isOwner}
    />
  );
}
