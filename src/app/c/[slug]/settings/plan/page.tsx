import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { dictForClinic } from "@/lib/i18n";
import { Card, CardHeader } from "@/components/ui/card";
import { PLAN_MODULES, asPlan } from "@/lib/plans";
import { seatState } from "@/lib/plan-change";
import { Check } from "lucide-react";

/**
 * What this clinic's subscription includes (lib/plans) — read-only.
 *
 * Features outside the plan are hidden everywhere else (Yamen, 2026-11-27:
 * "hidden completely"), so this is the one place a clinic can see what it has,
 * how many people it may add, and who to ask for more.
 */
export default async function PlanPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings");
  const t = await dictForClinic(access.clinic.vocabulary);

  const data = await inClinic(access, async (c) => {
    const row = (await c.query(`select plan from clinics where id = $1`, [access.clinicId])).rows[0];
    return { plan: asPlan(row?.plan), seats: await seatState(c, access.clinicId) };
  });
  const has = PLAN_MODULES.filter((m) => access.clinic.features[m]);

  return (
    <Card>
      <CardHeader title={t.plans.yourPlan} sub={t.plans.yourPlanSub} />
      <div className="grid gap-4 px-5 pb-5" data-your-plan={data.plan}>
        <div>
          <div className="text-lg font-semibold text-ink-900">{t.plans.names[data.plan]}</div>
          <p className="mt-0.5 text-[0.8125rem] text-ink-500">{t.plans.blurbs[data.plan]}</p>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-sunken px-3 py-2.5 text-sm">
          <span className="text-ink-500">{t.plans.users}</span>
          <span className="font-semibold tnum" data-plan-seats>
            {data.seats.limit === null
              ? `${data.seats.used} · ${t.plans.unlimited}`
              : t.plans.usersOf.replace("{n}", String(data.seats.used)).replace("{limit}", String(data.seats.limit))}
          </span>
        </div>
        <div>
          <div className="eyebrow mb-2">{t.plans.includes}</div>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {has.map((m) => (
              <li key={m} className="flex items-center gap-2 text-[0.8125rem] text-ink-700">
                <Check className="h-4 w-4 shrink-0 text-brand-700" />
                {t.caps[m]}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[0.8125rem] text-ink-500">{t.plans.upgradeHint}</p>
      </div>
    </Card>
  );
}
