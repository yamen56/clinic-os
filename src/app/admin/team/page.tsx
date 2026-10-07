import { guardAdminCap } from "@/lib/guard";
import { getDict, getLocale } from "@/lib/i18n";
import { withSystem } from "@/lib/db";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { SupportVisitList } from "@/components/support-visit-list";
import { listSupportVisits } from "@/lib/support-visits";
import { ShieldCheck } from "lucide-react";
import { TeamClient } from "./team-client";

export default async function AdminTeamPage() {
  const s = await guardAdminCap("admins");
  const t = await getDict();
  const locale = await getLocale();

  const { admins, visits } = await withSystem(async (c) => {
    const r = await c.query(
      // password_hash null means the invitation is still outstanding — the
      // account exists but cannot be signed into, exactly as for clinic staff.
      `select u.id, u.full_name, u.email, u.admin_permissions,
              (u.password_hash is null and u.google_sub is null
                 and u.apple_sub is null) as invite_pending,
              u.created_at,
              (select count(*)::int from clinic_members cm where cm.user_id = u.id) as clinic_count,
              (select max(s2.created_at) from sessions s2 where s2.user_id = u.id) as last_session
         from users u
        where u.is_super_admin
        order by u.created_at`
    );
    // Every clinic the team went into, so whoever runs the team can answer for
    // it without opening each clinic in turn.
    const visits = await listSupportVisits(c, {}, { limit: 100 });
    return { admins: r.rows, visits };
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
      <Card className="mt-4">
        <CardHeader title={t.admin.visits} sub={t.admin.teamVisitsSub} />
        {visits.length === 0 ? (
          <EmptyState bare icon={<ShieldCheck />} title={t.admin.noTeamVisits} />
        ) : (
          <SupportVisitList visits={visits} t={t} locale={locale} showClinic showOrigin />
        )}
      </Card>
    </>
  );
}
