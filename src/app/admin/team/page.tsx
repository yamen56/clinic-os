import { guardAdminCap } from "@/lib/guard";
import { getDict } from "@/lib/i18n";
import { withSystem } from "@/lib/db";
import { PageHeader } from "@/components/ui/card";
import { TeamClient } from "./team-client";

export default async function AdminTeamPage() {
  const s = await guardAdminCap("admins");
  const t = await getDict();

  const admins = await withSystem(async (c) => {
    const r = await c.query(
      // password_hash null means the invitation is still outstanding — the
      // account exists but cannot be signed into, exactly as for clinic staff.
      `select u.id, u.full_name, u.email, u.admin_permissions,
              (u.password_hash is null and u.google_sub is null) as invite_pending,
              u.created_at,
              (select count(*)::int from clinic_members cm where cm.user_id = u.id) as clinic_count,
              (select max(s2.created_at) from sessions s2 where s2.user_id = u.id) as last_session
         from users u
        where u.is_super_admin
        order by u.created_at`
    );
    return r.rows;
  });

  return (
    <>
      <PageHeader title={t.admin.team} sub={t.admin.teamSub} />
      <TeamClient
        selfId={s.user.id}
        admins={admins.map((a) => ({
          id: a.id,
          fullName: a.full_name,
          email: a.email,
          permissions: (a.admin_permissions ?? {}) as Record<string, unknown>,
          invitePending: !!a.invite_pending,
          clinicCount: Number(a.clinic_count),
          lastSession: a.last_session ? new Date(a.last_session).toISOString() : null,
        }))}
      />
    </>
  );
}
