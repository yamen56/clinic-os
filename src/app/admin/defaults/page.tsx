import { guardAdminCap } from "@/lib/guard";
import { withSystem } from "@/lib/db";
import { getDict } from "@/lib/i18n";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Workflow, BookOpen } from "lucide-react";
import type { Specialty } from "@/lib/specialties";

export default async function DefaultsPage() {
  await guardAdminCap("defaults");
  const t = await getDict();

  const data = await withSystem(async (c) => {
    const recipes = (
      await c.query(
        `select key, name, name_ar, description, trigger_type, trigger_config, steps, active, sort,
                specialty
         from recipe_templates order by sort`
      )
    ).rows;
    const knowledge = (
      await c.query(`select category, title, sort from knowledge_templates order by sort`)
    ).rows;
    const usage = (
      await c.query(
        `select recipe_key, count(*)::int as clinics, count(*) filter (where active)::int as enabled
         from automations where recipe_key is not null group by recipe_key`
      )
    ).rows;
    return { recipes, knowledge, usage };
  });

  const usageFor = (key: string) => data.usage.find((u) => u.recipe_key === key);

  return (
    <>
      <PageHeader
        title={t.admin.defaults}
        sub="Copied into every new clinic, disabled and fully editable by them."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Workflow className="h-4 w-4 text-ink-400" />
                Automation recipes
              </span>
            }
            sub={`${data.recipes.length} recipes`}
          />
          <ul className="divide-y divide-line">
            {data.recipes.map((r) => {
              const u = usageFor(r.key);
              const steps = Array.isArray(r.steps) ? r.steps.length : 0;
              return (
                <li key={r.key} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{r.name_ar || r.name}</span>
                    <Badge status="brand">{r.trigger_type}</Badge>
                    {/* Only the packs are labelled. 'general' is every clinic,
                        which is the default and needs no chip. */}
                    {r.specialty !== "general" && (
                      <Badge status="pending">{t.specialties[r.specialty as Specialty]}</Badge>
                    )}
                    {!r.active && <Badge status="cancelled">hidden</Badge>}
                  </div>
                  <p className="mt-0.5 text-[13px] text-ink-500">{r.description}</p>
                  <div className="mt-1 text-[12px] text-ink-400 tnum">
                    {steps} step{steps === 1 ? "" : "s"}
                    {u ? ` · in ${u.clinics} clinics, ${u.enabled} enabled` : " · not yet used"}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card className="h-fit">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-ink-400" />
                AI knowledge structure
              </span>
            }
            sub={`${data.knowledge.length} entries seeded per clinic`}
          />
          <ul className="divide-y divide-line">
            {data.knowledge.map((k, i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-2.5">
                <span className="flex-1 text-sm">{k.title}</span>
                <Badge status="neutral">{k.category}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <p className="mt-4 text-[13px] text-ink-500">
        Edit these in <code className="rounded bg-ink-900/5 px-1.5 py-0.5">scripts/seed-recipes.ts</code>, then run{" "}
        <code className="rounded bg-ink-900/5 px-1.5 py-0.5">npm run seed:recipes</code>. Existing clinics keep their
        own copies untouched.
      </p>
    </>
  );
}
