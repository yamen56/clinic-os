import { guardAdmin } from "@/lib/guard";
import { canAdmin } from "@/lib/auth";
import { getDict } from "@/lib/i18n";
import { withSystem } from "@/lib/db";
import { PageHeader } from "@/components/ui/card";
import { PLANS, asPlan, type Plan } from "@/lib/plans";
import { PlansClient } from "./plans-client";

/**
 * The three plans, side by side (Admin → Plans, 2026-11-27): what each one
 * includes — read from lib/plans, the same table that decides it — how many
 * clinics are on it, and the price a new clinic on it starts at.
 */
export default async function AdminPlansPage() {
  const s = await guardAdmin();
  const t = await getDict();
  const data = await withSystem(async (c) => {
    const prices = (await c.query(`select plan, price, currency from plan_defaults`)).rows;
    const counts = (
      await c.query(`select plan, count(*)::int as n from clinics where deleted_at is null group by plan`)
    ).rows;
    return { prices, counts };
  });
  const price = Object.fromEntries(PLANS.map((p) => [p, { price: 0, currency: "JOD" }])) as Record<Plan, { price: number; currency: string }>;
  for (const r of data.prices) price[asPlan(r.plan)] = { price: Number(r.price), currency: r.currency };
  const count = Object.fromEntries(PLANS.map((p) => [p, 0])) as Record<Plan, number>;
  for (const r of data.counts) count[asPlan(r.plan)] += r.n;

  return (
    <>
      <PageHeader title={t.admin.plansTitle} sub={t.admin.plansSub} />
      <PlansClient prices={price} counts={count} canEdit={canAdmin(s, "clinics.edit")} />
    </>
  );
}
