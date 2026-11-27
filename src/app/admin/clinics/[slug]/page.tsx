import Link from "next/link";
import { notFound } from "next/navigation";
import { guardAdmin } from "@/lib/guard";
import { getDict, getLocale } from "@/lib/i18n";
import { withSystem } from "@/lib/db";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { ClinicAdminPanel } from "./clinic-admin-panel";
import { DangerZone } from "./danger-zone";
import { DetailsForm } from "./details-form";
import { PlanBilling } from "./plan-billing";
import { MembersPanel, type AdminMember } from "./members-panel";
import { BranchesPanel, type BranchRow } from "./branches-panel";
import { resolveFeatures } from "@/lib/features";
import { asPlan, planOverrides } from "@/lib/plans";
import type { MemberRole } from "@/lib/permissions";
import { asSpecialty, isSpecialty } from "@/lib/specialties";
import { setupChecklist } from "@/lib/setup-checklist";
import { fmtDateTime, fmtRelative } from "@/lib/dates";
import { CheckCircle2, Circle, ShieldCheck } from "lucide-react";
import { listSupportVisits, SUPPORT_VISIT_HOURS } from "@/lib/support-visits";
import { SupportVisitList } from "@/components/support-visit-list";

const TABS = ["overview", "details", "plan", "members", "branches", "activity"] as const;
type Tab = (typeof TABS)[number];

const subStatus: Record<string, StatusKey> = {
  trial: "pending",
  active: "confirmed",
  past_due: "no_show",
  suspended: "cancelled",
};

/**
 * One clinic, from the agency's side (rebuilt 2026-11-27): a tab for each job
 * the agency comes here to do — see how it is doing, fix its details, change
 * what it bought, help its people, and look back at what happened — instead
 * of one page of cards and three modals.
 */
export default async function AdminClinicDetail({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const s = await guardAdmin();
  const { slug } = await params;
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(String(sp.tab)) ? (sp.tab as Tab) : "overview";
  const [t, locale] = await Promise.all([getDict(), getLocale()]);

  const data = await withSystem(async (c) => {
    const clinic = (
      await c.query(
        `select cl.*, ws.status as wa_status, ws.phone_number as wa_phone, ws.connected_at as wa_connected_at
         from clinics cl left join whatsapp_sessions ws on ws.clinic_id = cl.id
         where cl.slug = $1`,
        [slug]
      )
    ).rows[0];
    if (!clinic) return null;
    const members = (
      await c.query(
        // password_hash is null exactly while an invitation is outstanding.
        `select cm.id, cm.user_id, cm.role, cm.is_owner, cm.active, u.full_name, u.email,
                (u.password_hash is null) as invite_pending,
                coalesce((select json_agg(coalesce(nullif(oc.name_ar, ''), oc.name) order by om.created_at)
                            from clinic_members om join clinics oc on oc.id = om.clinic_id
                           where om.user_id = cm.user_id and om.clinic_id <> cm.clinic_id and om.active and oc.deleted_at is null), '[]') as elsewhere
           from clinic_members cm
           join users u on u.id = cm.user_id where cm.clinic_id = $1 order by cm.is_owner desc, cm.created_at`,
        [clinic.id]
      )
    ).rows;
    const stats = (
      await c.query(
        `select
           (select count(*)::int from patients where clinic_id = $1 and merged_into is null) as patients,
           (select count(*)::int from appointments where clinic_id = $1 and starts_at > now() - interval '30 days') as appointments,
           (select count(*)::int from automations where clinic_id = $1 and active) as active_automations,
           (select count(*)::int from automation_runs where clinic_id = $1 and status = 'failed' and started_at > now() - interval '7 days') as failed_runs,
           coalesce((select enabled from ai_agents where clinic_id = $1), false) as ai_enabled,
           (select count(*)::int from ai_knowledge_items where clinic_id = $1) as knowledge_items,
           (select max(created_at) from audit_log where clinic_id = $1) as last_activity`,
        [clinic.id]
      )
    ).rows[0];
    const setup = await setupChecklist(c, clinic.id);
    const activity =
      tab === "activity"
        ? (
            await c.query(
              `select a.action, a.detail, a.created_at, u.full_name as who, a.impersonated_by is not null as by_agency
                 from audit_log a left join users u on u.id = a.user_id
                where a.clinic_id = $1 and (a.action like 'admin.%' or a.action like 'staff.%' or a.action like 'clinic.%')
                order by a.created_at desc limit 60`,
              [clinic.id]
            )
          ).rows
        : [];
    const visits = tab === "activity" ? await listSupportVisits(c, { clinicId: clinic.id }, { limit: 30 }) : [];
    // The workspaces in its group (lib/branches): itself first, then the others by age.
    const branches =
      tab === "branches"
        ? (
            await c.query(
              `select id, slug, coalesce(nullif(name_ar, ''), name) as name, subscription_status as status, id = $1 as current
                 from clinics
                where deleted_at is null and (id = $1 or ($2::uuid is not null and group_id = $2))
                order by (id = $1) desc, created_at`,
              [clinic.id, clinic.group_id]
            )
          ).rows
        : [];
    return { clinic, members, stats, setup, activity, visits, branches };
  });
  if (!data) notFound();
  const { clinic, members, stats, setup, activity, visits, branches } = data;
  const features = resolveFeatures(clinic.features);
  const plan = asPlan(clinic.plan);
  const diff = planOverrides(features, plan);
  const deleted = !!clinic.deleted_at;
  const name = (locale === "ar" ? clinic.name_ar : null) || clinic.name;
  const statusLabel: Record<string, string> = {
    trial: t.admin.trial,
    active: t.admin.activeSub,
    past_due: t.admin.pastDue,
    suspended: t.admin.suspended,
  };
  const tabLabel: Record<Tab, string> = {
    overview: t.admin.tabOverview,
    details: t.admin.tabDetails,
    plan: t.admin.tabPlan,
    members: t.admin.tabMembers,
    branches: t.admin.tabBranches,
    activity: t.admin.tabActivity,
  };
  const activeMembers = members.filter((m) => m.active);

  const checklist = [
    ...setup.map((i) => ({ key: i.key, done: i.done, label: t.setup.items[i.key].label })),
    ...(features.ai
      ? [{ key: "ai", done: !!stats.ai_enabled && Number(stats.knowledge_items) > 0, label: locale === "en" ? "AI agent configured" : "تم إعداد المساعد الذكي" }]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Avatar name={clinic.name} size={36} />
            {name}
          </span>
        }
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <span dir="ltr">/{clinic.slug}</span>
            <Badge status="brand">
              <span data-clinic-plan={plan}>{t.plans.names[plan]}</span>
              {diff.added.length > 0 && ` +${diff.added.length}`}
              {diff.removed.length > 0 && ` −${diff.removed.length}`}
            </Badge>
            <Badge status={subStatus[clinic.subscription_status] ?? "neutral"}>{statusLabel[clinic.subscription_status]}</Badge>
          </span>
        }
        action={
          <ClinicAdminPanel
            caps={s.adminCaps}
            visitHours={SUPPORT_VISIT_HOURS}
            clinic={{
              id: clinic.id,
              slug: clinic.slug,
              name,
              specialty: asSpecialty(clinic.specialty),
              departments: ((clinic.specialties ?? []) as string[]).filter(isSpecialty).filter((x) => x !== clinic.specialty),
              deleted,
            }}
          />
        }
      />

      {!deleted && (
        <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist" data-clinic-tabs>
          {TABS.map((k) => (
            <Link
              key={k}
              href={k === "overview" ? `/admin/clinics/${clinic.slug}` : `/admin/clinics/${clinic.slug}?tab=${k}`}
              role="tab"
              aria-selected={tab === k}
              data-clinic-tab={k}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2.5 text-[0.8125rem] font-medium transition-colors ${
                tab === k ? "border-brand-600 text-ink-900" : "border-transparent text-ink-500 hover:text-ink-900"
              }`}
            >
              {tabLabel[k]}
              {k === "members" && <span className="ms-1.5 text-ink-400 tnum">{activeMembers.length}</span>}
            </Link>
          ))}
        </div>
      )}

      {(deleted || tab === "overview") && (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                [stats.patients, t.nav.patients],
                [stats.appointments, `${t.nav.calendar} · 30d`],
                [stats.active_automations, t.nav.automations],
                [activeMembers.length, t.plans.users],
              ] as [number, string][]
            ).map(([n, label]) => (
              <Card key={label} className="p-4">
                <div className="text-xl font-semibold tnum">{n}</div>
                <div className="text-[0.75rem] text-ink-500">{label}</div>
              </Card>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title={locale === "en" ? "Health" : "الحالة"} />
              <dl className="grid gap-2.5 px-5 pb-5 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-500">{t.dashboard.whatsapp}</dt>
                  <dd className="flex items-center gap-2">
                    {clinic.wa_phone && <span dir="ltr" className="text-ink-500">+{clinic.wa_phone}</span>}
                    <Badge status={clinic.wa_status === "connected" ? "ok" : "danger"} dot>
                      {clinic.wa_status ?? "—"}
                    </Badge>
                  </dd>
                </div>
                {features.ai && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-500">AI</dt>
                    <dd>
                      <Badge status={stats.ai_enabled ? "ok" : "neutral"} dot>
                        {stats.ai_enabled ? (locale === "en" ? "On" : "مفعّل") : locale === "en" ? "Off" : "متوقف"}
                      </Badge>
                    </dd>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-500">{locale === "en" ? "Failed automation runs (7 days)" : "تشغيلات أتمتة فشلت (7 أيام)"}</dt>
                  <dd>
                    <Badge status={stats.failed_runs > 0 ? "danger" : "ok"}>{stats.failed_runs}</Badge>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-500">{t.admin.lastActive}</dt>
                  <dd className="text-ink-700">{stats.last_activity ? fmtRelative(stats.last_activity, locale) : "—"}</dd>
                </div>
                {clinic.admin_notes && (
                  <div className="mt-1 rounded-lg bg-sunken px-3 py-2 text-[0.8125rem] whitespace-pre-line text-ink-700" data-admin-notes>
                    {clinic.admin_notes}
                  </div>
                )}
              </dl>
            </Card>
            <Card>
              <CardHeader title="Onboarding" />
              <ul className="grid gap-2.5 px-5 pb-5 text-sm">
                {checklist.map((item) => (
                  <li key={item.key} className="flex items-center gap-2.5" data-admin-setup={item.key} data-done={item.done ? "1" : "0"}>
                    {item.done ? <CheckCircle2 className="h-4.5 w-4.5 text-brand-700" /> : <Circle className="h-4.5 w-4.5 text-ink-300" />}
                    <span className={item.done ? "" : "text-ink-500"}>{item.label}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          {/* At the foot of the clinic's first tab, where the agency looks for it: stop access, or delete. */}
          {deleted && s.adminCaps["clinics.delete"] && (
            <DangerZone clinic={{ id: clinic.id, slug: clinic.slug, deletedAt: new Date(clinic.deleted_at).toISOString() }} />
          )}
          {!deleted && (s.adminCaps["clinics.delete"] || s.adminCaps["clinics.edit"]) && (
            <DangerZone
              clinic={{ id: clinic.id, slug: clinic.slug, deletedAt: null, status: clinic.subscription_status }}
              canSuspend={s.adminCaps["clinics.edit"]}
              canDelete={s.adminCaps["clinics.delete"]}
            />
          )}
        </div>
      )}

      {!deleted && tab === "details" && (
        <div className="grid gap-4">
          <DetailsForm
            clinicId={clinic.id}
            slug={clinic.slug}
            canEdit={s.adminCaps["clinics.edit"]}
            initial={{
              name: clinic.name,
              nameAr: clinic.name_ar ?? "",
              phone: clinic.phone_e164 ?? "",
              address: clinic.address ?? "",
              addressAr: clinic.address_ar ?? "",
              mapsUrl: clinic.google_maps_url ?? "",
              timezone: clinic.timezone,
              currency: clinic.currency,
              defaultLocale: clinic.default_locale === "en" ? "en" : "ar",
              dailyCap: Number(clinic.daily_outbound_cap ?? 200),
            }}
          />
        </div>
      )}

      {!deleted && tab === "plan" && (
        <PlanBilling
          clinicId={clinic.id}
          canPlan={s.adminCaps["clinics.features"]}
          canBill={s.adminCaps["clinics.edit"]}
          initial={{
            plan,
            memberLimit: clinic.member_limit === null ? null : Number(clinic.member_limit),
            status: clinic.subscription_status,
            price: Number(clinic.plan_price),
            currency: clinic.currency,
            trialEndsAt: clinic.trial_ends_at ? new Date(clinic.trial_ends_at).toISOString() : null,
            paidUntil: clinic.paid_until ? String(clinic.paid_until instanceof Date ? clinic.paid_until.toISOString() : clinic.paid_until) : null,
            notes: clinic.admin_notes ?? "",
            features,
          }}
        />
      )}

      {!deleted && tab === "members" && (
        <MembersPanel
          clinicId={clinic.id}
          limit={clinic.member_limit === null ? null : Number(clinic.member_limit)}
          canEdit={s.adminCaps["clinics.edit"]}
          members={members.map(
            (m): AdminMember => ({
              id: m.id,
              name: m.full_name,
              email: m.email,
              role: m.role as MemberRole,
              isOwner: m.is_owner,
              active: m.active,
              pending: m.invite_pending,
              elsewhere: m.elsewhere as string[],
            })
          )}
        />
      )}

      {!deleted && tab === "branches" && (
        <BranchesPanel
          clinicId={clinic.id}
          clinicSlug={clinic.slug}
          licensed={features.branches}
          canAdd={s.adminCaps["clinics.create"]}
          branches={branches as BranchRow[]}
          staff={members
            .filter((m) => m.active && !m.is_owner)
            .map((m) => ({ userId: m.user_id as string, name: m.full_name as string, role: m.role as string }))}
        />
      )}

      {!deleted && tab === "activity" && (
        <div className="grid gap-4">
          <Card>
            <CardHeader title={t.admin.tabActivity} />
            {activity.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-ink-500">{t.admin.noActivity}</p>
            ) : (
              <ul className="divide-y divide-line" data-clinic-activity>
                {activity.map((a, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2.5 text-[0.8125rem]">
                    <span className="text-ink-900">
                      <code className="rounded bg-sunken px-1.5 py-0.5 text-[0.75rem]">{a.action}</code>
                      {a.who && <span className="ms-2 text-ink-500">{a.who}</span>}
                    </span>
                    <span className="text-[0.75rem] text-ink-400" suppressHydrationWarning>
                      {fmtDateTime(a.created_at, clinic.timezone, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title={t.admin.visits} sub={t.admin.visitsSub} />
            {visits.length === 0 ? (
              <EmptyState bare icon={<ShieldCheck />} title={t.admin.noVisits} />
            ) : (
              <SupportVisitList visits={visits} t={t} locale={locale} showOrigin />
            )}
          </Card>
        </div>
      )}
    </>
  );
}
