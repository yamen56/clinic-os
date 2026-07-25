import Link from "next/link";
import { guardAdmin } from "@/lib/guard";
import { getDict } from "@/lib/i18n";
import { withSystem } from "@/lib/db";
import { PageHeader, Card } from "@/components/ui/card";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Avatar } from "@/components/ui/misc";
import { Building2, Plus } from "lucide-react";

const subStatus: Record<string, StatusKey> = {
  trial: "pending",
  active: "confirmed",
  past_due: "no_show",
  suspended: "cancelled",
};

export default async function AdminClinicsPage() {
  await guardAdmin();
  const t = await getDict();

  const clinics = await withSystem(async (c) => {
    const r = await c.query(`
      select cl.id, cl.name, cl.name_ar, cl.slug, cl.subscription_status, cl.plan, cl.created_at,
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

  return (
    <>
      <PageHeader
        title={t.admin.clinics}
        action={
          <Link href="/admin/clinics/new">
            <Button>
              <Plus className="h-4 w-4" />
              {t.admin.newClinic}
            </Button>
          </Link>
        }
      />
      {clinics.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          title={t.admin.noClinics}
          action={
            <Link href="/admin/clinics/new">
              <Button>{t.admin.newClinic}</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-3">
          {clinics.map((cl) => (
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
                  <Badge status={cl.wa_status === "connected" ? "ok" : "danger"} dot>
                    {t.dashboard.whatsapp}
                  </Badge>
                  <Badge status={cl.ai_enabled ? "ok" : "neutral"} dot>
                    AI
                  </Badge>
                  {Number(cl.failed_runs) > 0 && (
                    <Badge status="danger">{cl.failed_runs} ⚠</Badge>
                  )}
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
          ))}
        </div>
      )}
    </>
  );
}
