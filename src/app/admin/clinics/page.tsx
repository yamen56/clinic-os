import Link from "next/link";
import { guardAdmin } from "@/lib/guard";
import { getDict } from "@/lib/i18n";
import { withSystem } from "@/lib/db";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button-class";
import { EmptyState, Avatar } from "@/components/ui/misc";
import { resolveFeatures } from "@/lib/features";
import { asPlan, isPlan, planOverrides } from "@/lib/plans";
import { daysUntilPurge } from "@/lib/clinic-lifecycle";
import { Building2, Plus, Trash2 } from "lucide-react";
import { ClinicsTable, type ClinicRow } from "./clinics-table";

/**
 * Every clinic on the platform, searchable (Admin → Clinics, 2026-11-27).
 *
 * The working list and the deleted ones are two lists from one query: a
 * deleted clinic must stay reachable to be restored, and must never sit where
 * a glance would count it as a customer.
 */
export default async function AdminClinicsPage({ searchParams }: { searchParams: Promise<{ plan?: string; q?: string }> }) {
  const s = await guardAdmin();
  const sp = await searchParams;
  const t = await getDict();

  const rows = await withSystem(async (c) => {
    const r = await c.query(`
      select cl.id, cl.name, cl.name_ar, cl.slug, cl.subscription_status, cl.plan, cl.plan_price, cl.currency,
             cl.features, cl.deleted_at, cl.specialty, cl.created_at, cl.member_limit, cl.trial_ends_at, cl.paid_until,
             cl.phone_e164, cl.address, cl.address_ar,
             ws.status as wa_status, ws.connected_at as wa_connected_at,
             (select max(created_at) from audit_log al where al.clinic_id = cl.id) as last_activity,
             (select count(*)::int from automation_runs ar where ar.clinic_id = cl.id and ar.status = 'failed'
                and ar.started_at > now() - interval '7 days') as failed_runs,
             (select count(*)::int from clinic_members m where m.clinic_id = cl.id and m.active) as members,
             (select json_build_object('name', u.full_name, 'email', u.email, 'phone', u.phone_e164, 'pending', u.password_hash is null)
                from clinic_members m join users u on u.id = m.user_id
               where m.clinic_id = cl.id and m.is_owner order by m.created_at limit 1) as owner
      from clinics cl
      left join whatsapp_sessions ws on ws.clinic_id = cl.id
      order by cl.created_at desc
    `);
    return r.rows;
  });

  const live: ClinicRow[] = rows
    .filter((cl) => !cl.deleted_at)
    .map((cl) => {
      const plan = asPlan(cl.plan);
      const diff = planOverrides(resolveFeatures(cl.features), plan);
      const trialEnds = cl.trial_ends_at ? new Date(cl.trial_ends_at) : null;
      const paidUntil = cl.paid_until ? new Date(cl.paid_until) : null;
      const now = Date.now();
      // The same conditions the Overview lists, so a filter here finds what it named.
      const attention =
        cl.subscription_status === "past_due" ||
        (cl.subscription_status === "active" && !!paidUntil && paidUntil.getTime() < now - 86_400_000) ||
        (cl.subscription_status === "trial" && !!trialEnds && trialEnds.getTime() < now + 7 * 86_400_000) ||
        (cl.wa_connected_at && (cl.wa_status === "logged_out" || cl.wa_status === "qr")) ||
        (cl.member_limit !== null && cl.members > cl.member_limit) ||
        cl.failed_runs > 0;
      return {
        id: cl.id,
        name: cl.name,
        nameAr: cl.name_ar,
        slug: cl.slug,
        status: cl.subscription_status,
        plan,
        added: diff.added,
        removed: diff.removed,
        price: Number(cl.plan_price),
        currency: cl.currency,
        specialty: cl.specialty,
        members: cl.members,
        memberLimit: cl.member_limit,
        waStatus: cl.wa_status,
        failedRuns: cl.failed_runs,
        lastActivity: cl.last_activity ? new Date(cl.last_activity).toISOString() : null,
        trialEnds: trialEnds ? trialEnds.toISOString() : null,
        owner: cl.owner ?? null,
        phone: cl.phone_e164,
        address: [cl.address, cl.address_ar].filter(Boolean).join(" "),
        attention: !!attention,
      };
    });
  const deleted = rows.filter((cl) => cl.deleted_at);

  return (
    <>
      <PageHeader
        title={t.admin.clinics}
        sub={`${live.length}`}
        action={
          s.adminCaps["clinics.create"] ? (
            <Link href="/admin/clinics/new" className={buttonClass()} data-new-clinic>
              <Plus className="h-4 w-4" />
              {t.admin.newClinic}
            </Link>
          ) : undefined
        }
      />
      {live.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          title={t.admin.noClinics}
          action={
            s.adminCaps["clinics.create"] ? (
              <Link href="/admin/clinics/new" className={buttonClass()}>
                {t.admin.newClinic}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <ClinicsTable rows={live} initialPlan={isPlan(sp.plan) ? sp.plan : ""} initialQuery={String(sp.q ?? "").slice(0, 80)} />
      )}

      {deleted.length > 0 && (
        <Card className="mt-6">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Trash2 className="h-4 w-4 text-ink-400" />
                {t.admin.deletedClinics}
              </span>
            }
            sub={t.admin.deletedClinicsSub}
          />
          <ul className="divide-y divide-line">
            {deleted.map((cl) => {
              const left = daysUntilPurge(cl.deleted_at as Date);
              return (
                <li key={cl.id}>
                  <Link
                    href={`/admin/clinics/${cl.slug}`}
                    className="flex flex-wrap items-center gap-3 px-5 py-3 transition-colors hover:bg-sunken"
                  >
                    <Avatar name={cl.name} size={28} />
                    <div className="min-w-32 flex-1">
                      <div className="text-sm font-medium text-ink-500">{cl.name_ar || cl.name}</div>
                      <div className="text-[0.75rem] text-ink-400" dir="ltr">
                        /{cl.slug}
                      </div>
                    </div>
                    <Badge status={left <= 7 ? "danger" : "neutral"}>
                      {left > 0 ? t.admin.purgeIn.replace("{n}", String(left)) : t.admin.purgeDueNow}
                    </Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
