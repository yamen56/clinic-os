import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { AutomationsClient } from "./automations-client";
import { can } from "@/lib/auth";

export default async function AutomationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  const canEdit = can(access, "automations");
  if (!canEdit) redirect(`/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const automations = (
      await c.query(
        `select a.id, a.name, a.description, a.trigger_type, a.trigger_config, a.active, a.recipe_key,
                (select count(*)::int from automation_steps s where s.automation_id = a.id) as step_count,
                (select count(*)::int from automation_runs r where r.automation_id = a.id) as run_count,
                (select count(*)::int from automation_runs r where r.automation_id = a.id and r.status = 'failed') as failed_count
         from automations a where a.clinic_id = $1 order by a.active desc, a.created_at`,
        [access.clinicId]
      )
    ).rows;
    const clinic = (
      await c.query(
        `select message_window_start, message_window_end, timezone from clinics where id = $1`,
        [access.clinicId]
      )
    ).rows[0];
    return { automations, clinic };
  });

  return (
    <AutomationsClient
      slug={slug}
      isOwner={can(access, "settings.clinic")}
      automations={JSON.parse(JSON.stringify(data.automations))}
      windowStart={String(data.clinic.message_window_start).slice(0, 5)}
      windowEnd={String(data.clinic.message_window_end).slice(0, 5)}
    />
  );
}
