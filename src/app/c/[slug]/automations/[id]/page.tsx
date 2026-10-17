import { notFound, redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { guardClinic } from "@/lib/guard";
import { isUuid } from "@/lib/uuid";
import { inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { defaultSettingsFor, normalizeSettings, normalizeTriggerConfig } from "@/lib/automation/catalog";
import { treeToGraph, type RecipeStep } from "@/lib/automation/graph";
import { loadFlow, queryRuns } from "@/lib/automation/store";
import { BuilderClient, type BuilderInitial, type StepStats } from "./builder-client";

export default async function AutomationBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ tab?: string; template?: string }>;
}) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);
  if (!can(access, "automations")) redirect(`/c/${slug}`);

  const isNew = id === "new";
  if (!isNew && !isUuid(id)) notFound();
  const locale = access.clinic.defaultLocale;

  const data = await inClinic(access, async (c) => {
    // Sequential on purpose: node-pg runs one query at a time per client anyway.
    const services = (
      await c.query(`select id, name, name_ar from services where clinic_id = $1 and active order by sort, name`, [
        access.clinicId,
      ])
    ).rows;
    const members = (
      await c.query(
        `select cm.id, u.full_name as name, cm.role, cm.is_owner
           from clinic_members cm join users u on u.id = cm.user_id
          where cm.clinic_id = $1 and cm.active
          order by cm.is_owner desc, cm.role, u.full_name`,
        [access.clinicId]
      )
    ).rows;
    const automations = (
      await c.query(`select id, name from automations where clinic_id = $1 and id <> $2::uuid order by name`, [
        access.clinicId,
        isNew ? "00000000-0000-0000-0000-000000000000" : id,
      ])
    ).rows;
    const docTemplates = (
      await c.query(
        `select id, name, name_ar from document_templates where clinic_id = $1 and is_active order by category, name`,
        [access.clinicId]
      )
    ).rows;
    const tags = (
      await c.query(`select name from clinic_tags where clinic_id = $1 order by name`, [access.clinicId])
    ).rows.map((r) => r.name as string);
    const customFields = (
      await c.query(
        `select storage_key as key, label, label_ar from patient_field_definitions
          where clinic_id = $1 and scope = 'patient' and not is_system and storage_key is not null and not hidden
          order by display_order, label`,
        [access.clinicId]
      )
    ).rows;
    const lookups = { services, members, automations, docTemplates, tags, customFields };

    if (isNew) {
      let initial: BuilderInitial = {
        id: null,
        name: "",
        description: "",
        trigger: null,
        triggerConfig: {},
        settings: normalizeSettings({}),
        triggerPos: null,
        nodes: [],
        edges: [],
        active: false,
        updatedAt: null,
      };
      if (sp.template) {
        const r = (
          await c.query(`select * from recipe_templates where key = $1 and active`, [String(sp.template).slice(0, 80)])
        ).rows[0];
        if (r) {
          const graph = treeToGraph((Array.isArray(r.steps) ? r.steps : []) as RecipeStep[], () => randomUUID());
          initial = {
            ...initial,
            name: (locale === "ar" ? r.name_ar : r.name) || r.name,
            description: r.description ?? "",
            trigger: r.trigger_type,
            triggerConfig: normalizeTriggerConfig(r.trigger_type, r.trigger_config),
            settings: defaultSettingsFor(r.trigger_type),
            nodes: graph.nodes,
            edges: graph.edges,
          };
        }
      }
      return { initial, lookups, stats: {} as Record<string, StepStats>, runs: [] };
    }

    const flow = await loadFlow(c, access.clinicId, id);
    if (!flow) return null;
    const stats: Record<string, StepStats> = {};
    const rows = (
      await c.query(
        `select l.step_id, l.status, count(*)::int as n
           from automation_runs r join automation_run_logs l on l.run_id = r.id
          where r.automation_id = $1 and r.started_at > now() - interval '30 days' and l.step_id is not null
          group by 1, 2`,
        [id]
      )
    ).rows;
    for (const row of rows) {
      const s = (stats[row.step_id] ??= { ok: 0, skipped: 0, failed: 0, waiting: 0 });
      if (row.status === "ok") s.ok += row.n;
      if (row.status === "skipped") s.skipped += row.n;
      if (row.status === "failed") s.failed += row.n;
    }
    const waiting = (
      await c.query(
        `select current_step_id, count(*)::int as n from automation_runs
          where automation_id = $1 and status = 'waiting' and current_step_id is not null group by 1`,
        [id]
      )
    ).rows;
    for (const row of waiting) {
      (stats[row.current_step_id] ??= { ok: 0, skipped: 0, failed: 0, waiting: 0 }).waiting = row.n;
    }
    const runs = await queryRuns(c, access.clinicId, id, null, null);
    const initial: BuilderInitial = {
      id: flow.id,
      name: flow.name,
      description: flow.description,
      trigger: flow.trigger,
      triggerConfig: flow.triggerConfig,
      settings: flow.settings,
      triggerPos: flow.canvas.trigger ?? null,
      nodes: flow.nodes,
      edges: flow.edges,
      active: flow.active,
      updatedAt: flow.updatedAt,
    };
    return { initial, lookups, stats, runs };
  });

  if (!data) notFound();

  return (
    <BuilderClient
      slug={slug}
      tz={access.clinic.timezone}
      modules={access.clinic.features}
      initial={JSON.parse(JSON.stringify(data.initial))}
      lookups={JSON.parse(JSON.stringify(data.lookups))}
      stats={data.stats}
      runs={data.runs}
      initialTab={sp.tab === "history" || sp.tab === "activity" ? "activity" : sp.tab === "settings" ? "settings" : "flow"}
    />
  );
}
