import Link from "next/link";
import { guardAdmin } from "@/lib/guard";
import { getDict } from "@/lib/i18n";
import { withSystem } from "@/lib/db";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Avatar } from "@/components/ui/misc";
import { FEATURES, resolveFeatures } from "@/lib/features";
import { daysUntilPurge } from "@/lib/clinic-lifecycle";
import { Building2, Plus, Trash2 } from "lucide-react";

const subStatus: Record<string, StatusKey> = {
  trial: "pending",
  active: "confirmed",
  past_due: "no_show",
  suspended: "cancelled",
};

export default async function AdminClinicsPage() {
  const s = await guardAdmin();
  const t = await getDict();

  const clinics = await withSystem(async (c) => {
    const r = await c.query(`
      select cl.id, cl.name, cl.name_ar, cl.slug, cl.subscription_status, cl.plan, cl.created_at,
             cl.features, cl.deleted_at,
             ws.status as wa_status,
             (select max(created_at) from audit_log al where al.clinic_id = cl.id) as last_activity,
             (select count(*) from automation_runs ar where ar.clinic_id = cl.id and ar.status = 'failed'
                and ar.started_at > now() - interval '7 days') as failed_runs,
             coalesce((select enabled from ai_agents aa where aa.clinic_id = cl.id), false) as ai_enabled
      from clinics cl
      left join whatsapp_sessions ws on ws.clinic_id = cl.id
      order by cl.created_at desc
    `);
    return r.rows;
  });

  // One query, two lists. A deleted clinic is still a clinic — it has to stay
  // reachable to be restored — but it must never sit in the working list where
  // a glance would count it as a customer.
  const live = clinics.filter((cl) => !cl.deleted_at);
  const deleted = clinics.filter((cl) => cl.deleted_at);

  return (
    <>
      <PageHeader
        title={t.admin.clinics}
        action={
          s.adminCaps["clinics.create"] ? (
            <Link href="/admin/clinics/new">
              <Button>
                <Plus className="h-4 w-4" />
                {t.admin.newClinic}
              </Button>
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
              <Link href="/admin/clinics/new">
                <Button>{t.admin.newClinic}</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3">
          {live.map((cl) => {
            const features = resolveFeatures(cl.features);
            const missing = FEATURES.filter((f) => !features[f]);
            return (
              <Link key={cl.id} href={`/admin/clinics/${cl.slug}`}>
                <Card className="flex flex-wrap items-center gap-4 p-4 transition-shadow hover:shadow-pop">
                  <Avatar name={cl.name} size={40} />
                  <div className="min-w-40 flex-1">
                    <div className="font-medium">{cl.name_ar || cl.name}</div>
                    <div className="text-[13px] text-ink-500" dir="ltr">
                      /{cl.slug}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Only when something is switched off. A badge on every
                        row saying "full product" is noise that hides the two
                        rows where the licence is the answer. */}
                    {missing.length > 0 && (
                      <Badge status="neutral">
                        {t.admin.featuresOf
                          .replace("{n}", String(FEATURES.length - missing.length))
                          .replace("{total}", String(FEATURES.length))}
                      </Badge>
                    )}
                    <Badge status={cl.wa_status === "connected" ? "ok" : "danger"} dot>
                      {t.dashboard.whatsapp}
                    </Badge>
                    <Badge status={cl.ai_enabled ? "ok" : "neutral"} dot>
                      AI
                    </Badge>
                    {Number(cl.failed_runs) > 0 && <Badge status="danger">{cl.failed_runs} ⚠</Badge>}
                    <Badge status={subStatus[cl.subscription_status] ?? "neutral"}>
                      {
                        {
                          trial: t.admin.trial,
                          active: t.admin.activeSub,
                          past_due: t.admin.pastDue,
                          suspended: t.admin.suspended,
                        }[cl.subscription_status as string]
                      }
                    </Badge>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
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
                      <div className="text-sm font-medium text-ink-500">
                        {cl.name_ar || cl.name}
                      </div>
                      <div className="text-[12px] text-ink-400" dir="ltr">
                        /{cl.slug}
                      </div>
                    </div>
                    {/* Red only once it is nearly gone. A two-month countdown
                        rendered as an alarm from day one stops being read. */}
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
