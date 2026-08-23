import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { AutomationsClient } from "./automations-client";
import { can } from "@/lib/auth";
import { loadSystemMessages } from "@/lib/system-messages";
import { loadStaffAlerts } from "@/lib/staff-alerts";
import { asSpecialty } from "@/lib/specialties";

export default async function AutomationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  const canEdit = can(access, "automations");
  if (!canEdit) redirect(`/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const automations = (
      await c.query(
        `select a.id, a.name, a.description, a.trigger_type, a.trigger_config, a.active, a.recipe_key,
                a.recipe_specialty,
                (select count(*)::int from automation_steps s where s.automation_id = a.id) as step_count,
                (select count(*)::int from automation_runs r where r.automation_id = a.id) as run_count,
                (select count(*)::int from automation_runs r where r.automation_id = a.id and r.status = 'failed') as failed_count
         from automations a where a.clinic_id = $1 order by a.active desc, a.created_at`,
        [access.clinicId]
      )
    ).rows;
    const clinic = (
      await c.query(
        `select message_window_start, message_window_end, timezone, specialty from clinics where id = $1`,
        [access.clinicId]
      )
    ).rows[0];
    // Sequential on purpose: node-pg serialises every query on one client
    // anyway, so a Promise.all here would buy nothing but a harder stack trace.
    const messages = await loadSystemMessages(c, access.clinicId);
    const alerts = await loadStaffAlerts(c, access.clinicId);
    return { automations, clinic, messages, alerts };
  });

  return (
    <AutomationsClient
      slug={slug}
      isOwner={can(access, "settings.clinic")}
      specialty={asSpecialty(data.clinic.specialty)}
      automations={JSON.parse(JSON.stringify(data.automations))}
      messages={data.messages}
      alerts={JSON.parse(JSON.stringify(data.alerts))}
      windowStart={String(data.clinic.message_window_start).slice(0, 5)}
      windowEnd={String(data.clinic.message_window_end).slice(0, 5)}
    />
  );
}
