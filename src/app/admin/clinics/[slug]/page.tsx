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
import { asSpecialty } from "@/lib/specialties";
import { CheckCircle2, Circle } from "lucide-react";

const CHECKLIST: { key: string; en: string; ar: string }[] = [
  { key: "branding", en: "Branding set up", ar: "تم إعداد الهوية البصرية" },
  { key: "services", en: "Services added", ar: "تمت إضافة الخدمات" },
  { key: "whatsapp", en: "WhatsApp connected", ar: "تم ربط واتساب" },
  { key: "automations", en: "Automations enabled", ar: "تم تفعيل الأتمتة" },
  { key: "ai", en: "AI agent configured", ar: "تم إعداد المساعد الذكي" },
];

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
    return { clinic, members, stats };
  });
  if (!data) notFound();
  const { clinic, members, stats } = data;
  const features = resolveFeatures(clinic.features);
  const missing = FEATURES.filter((f) => !features[f]);

  const checklistState: Record<string, boolean> = {
    /*
      Compared against the schema's own default, which is what an untouched
      clinic actually has. This read "#6989a6" — a colour no clinic is ever
      created with — so the test was true for everybody and the checklist item
      has been reporting branding as done since the day it was written.
    */
    branding: !!clinic.logo_path || clinic.brand_color !== "#0f6e5c",
    services: Number(stats.services) > 0,
    whatsapp: clinic.wa_status === "connected",
    automations: Number(stats.active_automations) > 0,
    ai: stats.ai_enabled && Number(stats.knowledge_items) > 0,
  };

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
            clinic={{
              id: clinic.id,
              slug: clinic.slug,
              subscriptionStatus: clinic.subscription_status,
              plan: clinic.plan,
              planPrice: Number(clinic.plan_price),
              features,
              specialty: asSpecialty(clinic.specialty),
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
            {CHECKLIST.map((item) => (
              <li key={item.key} className="flex items-center gap-2.5">
                {checklistState[item.key] ? (
                  <CheckCircle2 className="h-4.5 w-4.5 text-brand-600" />
                ) : (
                  <Circle className="h-4.5 w-4.5 text-ink-300" />
                )}
                <span className={checklistState[item.key] ? "" : "text-ink-500"}>
                  {locale === "en" ? item.en : item.ar}
                </span>
              </li>
            ))}
          </ul>
        </Card>
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
                    {m.is_owner ? `${m.role} · owner` : m.role}
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
