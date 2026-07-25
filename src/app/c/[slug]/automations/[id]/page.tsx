import { notFound, redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { BuilderClient } from "./builder-client";
import type { StepInput } from "../actions";

type StepRow = {
  id: string;
  parent_step_id: string | null;
  branch: "yes" | "no" | null;
  sort: number;
  step_type: string;
  config: Record<string, unknown>;
};

/** Flat step rows → nested tree for the builder. */
function buildTree(rows: StepRow[], parentId: string | null, branch: "yes" | "no" | null): StepInput[] {
  return rows
    .filter((r) => r.parent_step_id === parentId && r.branch === branch)
    .sort((a, b) => a.sort - b.sort)
    .map((r) => ({
      step_type: r.step_type,
      config: r.config ?? {},
      ...(r.step_type === "condition"
        ? { children: { yes: buildTree(rows, r.id, "yes"), no: buildTree(rows, r.id, "no") } }
        : {}),
    }));
}

export default async function AutomationBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);
  const canEdit = access.role === "owner" || access.permissions.automations === true;
  if (!canEdit) redirect(`/c/${slug}`);

  const isNew = id === "new";

  const data = await inClinic(access, async (c) => {
    const services = (
      await c.query(`select id, name, name_ar from services where clinic_id = $1 and active order by sort`, [
        access.clinicId,
      ])
    ).rows;
    const others = (
      await c.query(`select id, name from automations where clinic_id = $1 and id <> $2::uuid`, [
        access.clinicId,
        isNew ? "00000000-0000-0000-0000-000000000000" : id,
      ])
    ).rows;
    const tz = (await c.query(`select timezone from clinics where id = $1`, [access.clinicId])).rows[0]
      .timezone as string;

    if (isNew) return { automation: null, steps: [], runs: [], services, others, tz };

    const automation = (
      await c.query(`select * from automations where id = $1 and clinic_id = $2`, [id, access.clinicId])
    ).rows[0];
    if (!automation) return null;
    const stepRows = (
      await c.query(
        `select id, parent_step_id, branch, sort, step_type, config from automation_steps
         where automation_id = $1 order by sort`,
        [id]
      )
    ).rows as StepRow[];
    const runs = (
      await c.query(
        `select r.id, r.status, r.started_at, r.finished_at, r.error, p.full_name as patient_name,
                (select json_agg(json_build_object('status', l.status, 'detail', l.detail, 'at', l.created_at, 'step', s.step_type) order by l.created_at)
                 from automation_run_logs l left join automation_steps s on s.id = l.step_id
                 where l.run_id = r.id) as logs
         from automation_runs r
         left join patients p on p.id = r.patient_id
         where r.automation_id = $1 order by r.started_at desc limit 30`,
        [id]
      )
    ).rows;
    return { automation, steps: buildTree(stepRows, null, null), runs, services, others, tz };
  });

  if (!data) notFound();

  return (
    <BuilderClient
      slug={slug}
      tz={data.tz}
      automation={data.automation ? JSON.parse(JSON.stringify(data.automation)) : null}
      initialSteps={JSON.parse(JSON.stringify(data.steps))}
      runs={JSON.parse(JSON.stringify(data.runs))}
      services={JSON.parse(JSON.stringify(data.services))}
      otherAutomations={JSON.parse(JSON.stringify(data.others))}
      initialTab={sp.tab === "history" ? "history" : "flow"}
    />
  );
}
