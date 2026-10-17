import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { AutomationsClient, type GalleryTemplate } from "./automations-client";
import { can } from "@/lib/auth";
import { loadSystemMessages } from "@/lib/system-messages";
import { loadStaffAlerts } from "@/lib/staff-alerts";
import { asSpecialty, clinicSpecialties } from "@/lib/specialties";
import { normalizeTriggerConfig } from "@/lib/automation/catalog";
import type { RecipeStep } from "@/lib/automation/graph";

/** The step types of a recipe in the order they run, branches included. */
function stepTypes(steps: RecipeStep[]): string[] {
  return steps.flatMap((s) => [
    s.step_type,
    ...Object.values(s.children ?? {}).flatMap((b) => stepTypes(b ?? [])),
  ]);
}

export default async function AutomationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string; new?: string }>;
}) {
  const { slug } = await params;
  // So another screen can send somebody straight to the team alerts.
  const { tab, new: openGallery } = await searchParams;
  const access = await guardClinic(slug);
  if (!can(access, "automations")) redirect(`/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const automations = (
      await c.query(
        `select a.id, a.name, a.description, a.trigger_type, a.trigger_config, a.active, a.recipe_key,
                a.recipe_specialty,
                (select count(*)::int from automation_steps s where s.automation_id = a.id) as step_count,
                (select count(*)::int from automation_runs r
                  where r.automation_id = a.id and r.started_at > now() - interval '30 days') as runs_30,
                (select count(*)::int from automation_runs r
                  where r.automation_id = a.id and r.status = 'waiting') as waiting,
                (select count(*)::int from automation_runs r
                  where r.automation_id = a.id and r.status = 'failed' and r.started_at > now() - interval '30 days') as failed_count,
                (select max(r.started_at) from automation_runs r where r.automation_id = a.id) as last_run,
                (select count(*)::int
                   from automation_runs r
                   join automation_run_logs l on l.run_id = r.id
                   join automation_steps s on s.id = l.step_id
                  where r.automation_id = a.id and r.started_at > now() - interval '30 days'
                    and l.status = 'ok' and s.step_type = 'send_whatsapp') as sent_30
         from automations a where a.clinic_id = $1 order by a.active desc, a.created_at`,
        [access.clinicId]
      )
    ).rows.map((a) => ({ ...a, trigger_config: normalizeTriggerConfig(a.trigger_type, a.trigger_config) }));
    const clinic = (
      await c.query(
        `select message_window_start, message_window_end, timezone, specialty, specialties, google_review_url
           from clinics where id = $1`,
        [access.clinicId]
      )
    ).rows[0];
    // Sequential on purpose: node-pg serialises every query on one client
    // anyway, so a Promise.all here would buy nothing but a harder stack trace.
    const messages = await loadSystemMessages(c, access.clinicId);
    const alerts = await loadStaffAlerts(c, access.clinicId);
    /*
      How many people these flows will never reach. Every automation on this
      screen quietly skips them, and a number that is only visible on individual
      patient files is a number nobody knows — which is how a clinic ends up
      wondering why a recall of 400 went to 340.
    */
    const muted = Number(
      (
        await c.query(
          `select count(*)::int as n from patients
            where clinic_id = $1 and automation_opt_out and merged_into is null`,
          [access.clinicId]
        )
      ).rows[0].n
    );
    const services = (
      await c.query(`select id, name, name_ar from services where clinic_id = $1 order by sort, name`, [access.clinicId])
    ).rows;
    const members = (
      await c.query(
        `select cm.id, u.full_name as name, cm.role, cm.is_owner
           from clinic_members cm join users u on u.id = cm.user_id where cm.clinic_id = $1`,
        [access.clinicId]
      )
    ).rows;
    const recipes = (
      await c.query(
        `select key, name, name_ar, trigger_type, trigger_config, steps, specialty
           from recipe_templates where active order by sort, key`
      )
    ).rows;
    return { automations, clinic, messages, alerts, muted, services, members, recipes };
  });

  const mine = clinicSpecialties(data.clinic.specialty, data.clinic.specialties ?? []);
  const templates: GalleryTemplate[] = data.recipes.map((r) => ({
    key: r.key,
    name: r.name,
    name_ar: r.name_ar,
    trigger: r.trigger_type,
    triggerConfig: normalizeTriggerConfig(r.trigger_type, r.trigger_config),
    steps: stepTypes(Array.isArray(r.steps) ? (r.steps as RecipeStep[]) : []),
    specialty: r.specialty ?? "general",
    suggested: (r.specialty ?? "general") === "general" || mine.includes(r.specialty),
  }));

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
      reviewUrl={data.clinic.google_review_url ?? ""}
      mutedPatients={data.muted}
      templates={templates}
      lookups={JSON.parse(JSON.stringify({ services: data.services, members: data.members }))}
      modules={access.clinic.features}
      initialTab={tab === "alerts" || tab === "messages" ? tab : "flows"}
      openGallery={openGallery === "1"}
    />
  );
}
