import { notFound } from "next/navigation";
import { guardAdmin } from "@/lib/guard";
import { getDict, getLocale } from "@/lib/i18n";
import { withSystem } from "@/lib/db";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/misc";
import { ClinicAdminPanel } from "./clinic-admin-panel";
import { OwnerInvite } from "./owner-invite";
import { DangerZone } from "./danger-zone";
import { FEATURES, resolveFeatures } from "@/lib/features";
import type { MemberRole } from "@/lib/permissions";
import { asSpecialty, clinicSpecialties, isSpecialty } from "@/lib/specialties";
import { setupChecklist } from "@/lib/setup-checklist";
import { pendingDefaultRecipes } from "@/lib/clinic-provision";
import { DefaultFlowsButton } from "./default-flows-button";
import { CheckCircle2, Circle, ShieldCheck } from "lucide-react";
import { listSupportVisits, SUPPORT_VISIT_HOURS } from "@/lib/support-visits";
import { SupportVisitList } from "@/components/support-visit-list";
import { EmptyState } from "@/components/ui/misc";

/** The first message a flow sends — what its patients will read — for the preview before it is switched on. */
function firstMessage(steps: unknown): string {
  for (const st of Array.isArray(steps) ? steps : []) {
    const s = st as { step_type?: string; config?: { message?: string }; children?: Record<string, unknown> };
    if (s.step_type === "send_whatsapp" && s.config?.message) return s.config.message;
    for (const branch of Object.values(s.children ?? {})) {
      const m = firstMessage(branch);
      if (m) return m;
    }
  }
  return "";
}

export default async function AdminClinicDetail({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const s = await guardAdmin();
  const { slug } = await params;
  const t = await getDict();
  const locale = await getLocale();

  const data = await withSystem(async (c) => {
    const clinic = (
      await c.query(
        `select cl.*, ws.status as wa_status, ws.phone_number as wa_phone
         from clinics cl left join whatsapp_sessions ws on ws.clinic_id = cl.id
         where cl.slug = $1`,
        [slug]
      )
    ).rows[0];
    if (!clinic) return null;
    const members = (
      await c.query(
        // password_hash is null exactly while an invitation is outstanding —
        // the account exists but cannot be signed into yet.
        `select cm.role, cm.is_owner, u.full_name, u.email,
                (u.password_hash is null) as invite_pending
           from clinic_members cm
           join users u on u.id = cm.user_id where cm.clinic_id = $1 order by cm.created_at`,
        [clinic.id]
      )
    ).rows;
    const stats = (
      await c.query(
        `select
           (select count(*) from patients where clinic_id = $1 and merged_into is null) as patients,
           (select count(*) from appointments where clinic_id = $1) as appointments,
           (select count(*) from services where clinic_id = $1 and active) as services,
           (select count(*) from automations where clinic_id = $1 and active) as active_automations,
           coalesce((select enabled from ai_agents where clinic_id = $1), false) as ai_enabled,
           (select count(*) from ai_knowledge_items where clinic_id = $1) as knowledge_items`,
        [clinic.id]
      )
    ).rows[0];
    const visits = await listSupportVisits(c, { clinicId: clinic.id }, { limit: 30 });
    // The clinic's own setup list, as its owner sees it on the dashboard.
    const setup = await setupChecklist(c, clinic.id);
    /*
      The default flows it does not have yet, with the first message each
      sends, and what that means for its WhatsApp: about how many reminders a
      day against the daily cap.
    */
    const chosen = asSpecialty(clinic.specialty);
    const practises = clinicSpecialties(chosen, clinic.specialties ?? []);
    const pendingByKey = new Map<string, { key: string; name: string; message: string }>();
    for (const sp of practises.length ? practises : [chosen]) {
      for (const r of await pendingDefaultRecipes(c, clinic.id, sp)) {
        pendingByKey.set(r.key, { key: r.key, name: r.name_ar || r.name, message: firstMessage(r.steps) });
      }
    }
    const volume = (
      await c.query(
        `select (select count(*) from appointments where clinic_id = $1 and starts_at between now() and now() + interval '7 days'
                   and status in ('pending_approval', 'scheduled', 'confirmed'))::int as week`,
        [clinic.id]
      )
    ).rows[0];
    return { clinic, members, stats, visits, setup, pendingFlows: [...pendingByKey.values()], perDay: Math.ceil(Number(volume.week) / 7) };
  });
  if (!data) notFound();
  const { clinic, members, stats, visits, setup, pendingFlows, perDay } = data;
  const features = resolveFeatures(clinic.features);
  const missing = FEATURES.filter((f) => !features[f]);

  /*
    The clinic's own setup list (lib/setup-checklist), the one its owner sees,
    and the AI receptionist, which only the agency sets up. The old list said
    "automations enabled" from day one, because the welcome flow always is;
    reminders being on is the item that matters.
  */
  const checklist = [
    ...setup.map((i) => ({ key: i.key, done: i.done, label: t.setup.items[i.key].label })),
    { key: "ai", done: !!stats.ai_enabled && Number(stats.knowledge_items) > 0, label: locale === "en" ? "AI agent configured" : "تم إعداد المساعد الذكي" },
  ];

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Avatar name={clinic.name} size={36} />
            {clinic.name_ar || clinic.name}
          </span>
        }
        sub={`/${clinic.slug} · ${clinic.timezone}`}
        action={
          <ClinicAdminPanel
            caps={s.adminCaps}
            visitHours={SUPPORT_VISIT_HOURS}
            clinic={{
              id: clinic.id,
              slug: clinic.slug,
              name: clinic.name_ar || clinic.name,
              subscriptionStatus: clinic.subscription_status,
              plan: clinic.plan,
              planPrice: Number(clinic.plan_price),
              features,
              specialty: asSpecialty(clinic.specialty),
              departments: ((clinic.specialties ?? []) as string[]).filter(isSpecialty).filter((s) => s !== clinic.specialty),
              deleted: !!clinic.deleted_at,
            }}
          />
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title={t.admin.subscription} />
          <div className="grid gap-2 px-5 py-4 text-sm">
            <div className="flex justify-between">
              <span className="text-ink-500">{t.common.status}</span>
              <Badge
                status={
                  clinic.subscription_status === "active"
                    ? "confirmed"
                    : clinic.subscription_status === "trial"
                      ? "pending"
                      : clinic.subscription_status === "past_due"
                        ? "no_show"
                        : "cancelled"
                }
              >
                {clinic.subscription_status}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-500">{t.admin.plan}</span>
              <span>{clinic.plan}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-500">{t.admin.planPrice}</span>
              <span className="tnum">
                {Number(clinic.plan_price).toFixed(2)} {clinic.currency}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-500">{t.dashboard.whatsapp}</span>
              <Badge status={clinic.wa_status === "connected" ? "ok" : "danger"} dot>
                {clinic.wa_status ?? "—"}
              </Badge>
            </div>
            <div className="flex justify-between gap-3">
              <span className="shrink-0 text-ink-500">{t.admin.features}</span>
              <span className="text-end">
                {missing.length === 0 ? (
                  <Badge status="ok">{t.admin.featuresAll}</Badge>
                ) : (
                  /*
                    What is missing, named — not "6 of 8". The count answers a
                    question nobody has; the list answers the one the agency
                    actually opens this page with, which is why the customer
                    cannot see a screen they were told about.
                  */
                  <span className="flex flex-wrap justify-end gap-1">
                    {missing.map((f) => (
                      <Badge key={f} status="cancelled">
                        {t.caps[f]}
                      </Badge>
                    ))}
                  </span>
                )}
              </span>
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Onboarding" />
          <ul className="grid gap-2.5 px-5 py-4 text-sm">
            {checklist.map((item) => (
              <li key={item.key} className="flex items-center gap-2.5" data-admin-setup={item.key} data-done={item.done ? "1" : "0"}>
                {item.done ? <CheckCircle2 className="h-4.5 w-4.5 text-brand-700" /> : <Circle className="h-4.5 w-4.5 text-ink-300" />}
                <span className={item.done ? "" : "text-ink-500"}>{item.label}</span>
              </li>
            ))}
          </ul>
        </Card>
        {/*
          The flows a new clinic starts with that this one does not have: the
          first message each sends, and what it means for the number. Switched
          on from here, after reading them, because its patients receive them.
        */}
        <div data-default-flows>
          <Card>
            <CardHeader
              title={locale === "en" ? "Default flows" : "التدفقات الافتراضية"}
              action={pendingFlows.length > 0 ? <DefaultFlowsButton slug={clinic.slug} count={pendingFlows.length} locale={locale} /> : undefined}
            />
            {pendingFlows.length === 0 ? (
              <p className="px-5 pb-4 text-sm text-ink-500">{locale === "en" ? "All of them are on." : "كلها مفعّلة."}</p>
            ) : (
              <div className="grid gap-3 px-5 pb-4">
                {pendingFlows.map((f) => (
                  <div key={f.key} className="grid gap-1" data-pending-flow={f.key}>
                    <div className="text-sm font-semibold">{f.name}</div>
                    {f.message && (
                      <p dir="rtl" className="whitespace-pre-line rounded-lg bg-sunken px-3 py-2 text-[12.5px] text-ink-700">
                        {f.message}
                      </p>
                    )}
                  </div>
                ))}
                <p className="text-[12px] text-ink-500">
                  {locale === "en"
                    ? `About ${perDay} appointment(s) a day in the coming week — each gets a reminder. Daily WhatsApp cap: ${clinic.daily_outbound_cap}.`
                    : `نحو ${perDay} موعد يومياً خلال الأسبوع القادم، لكل منها تذكير. الحد اليومي لواتساب: ${clinic.daily_outbound_cap}.`}
                </p>
              </div>
            )}
          </Card>
        </div>
        <Card>
          <CardHeader title={t.settings.staff} />
          <ul className="grid gap-2.5 px-5 py-4 text-sm">
            {members.map((m, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate">{m.full_name}</span>
                <span className="flex items-center gap-1.5">
                  {m.invite_pending && (
                    <Badge status="pending">{t.admin.ownerInvitePending}</Badge>
                  )}
                  <Badge status={m.is_owner ? "brand" : "neutral"}>
                    {/* The job and the flag are two different facts, which is
                        the whole point of this pair of columns — an admin is
                        also a doctor or a receptionist. */}
                    {m.is_owner ? `${t.staff.roles[m.role as MemberRole]} · ${t.staff.owner}` : t.staff.roles[m.role as MemberRole]}
                  </Badge>
                </span>
              </li>
            ))}
            {/* Only while it can still be accepted; once a password exists an
                invitation would be a reset link nobody asked for. */}
            {s.adminCaps["clinics.edit"] &&
              members.some((m) => m.is_owner && m.invite_pending) && (
              <li className="pt-1">
                <OwnerInvite clinicId={clinic.id as string} />
              </li>
            )}
          </ul>
        </Card>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          [stats.patients, t.nav.patients],
          [stats.appointments, t.nav.calendar],
          [stats.services, t.settings.services],
          [stats.active_automations, t.nav.automations],
        ].map(([n, label], i) => (
          <Card key={i} className="p-4 text-center">
            <div className="text-2xl font-semibold tnum">{String(n)}</div>
            <div className="text-[13px] text-ink-500">{String(label)}</div>
          </Card>
        ))}
      </div>

      <Card className="mt-4">
        <CardHeader title={t.admin.visits} sub={t.admin.visitsSub} />
        {visits.length === 0 ? (
          <EmptyState bare icon={<ShieldCheck />} title={t.admin.noVisits} />
        ) : (
          <SupportVisitList visits={visits} t={t} locale={locale} showOrigin />
        )}
      </Card>

      {s.adminCaps["clinics.delete"] && (
        <DangerZone
          clinic={{
            id: clinic.id,
            slug: clinic.slug,
            deletedAt: clinic.deleted_at ? new Date(clinic.deleted_at).toISOString() : null,
          }}
        />
      )}
    </>
  );
}
