import { guardAdminCap } from "@/lib/guard";
import { getDict } from "@/lib/i18n";
import { withSystem } from "@/lib/db";
import { PageHeader } from "@/components/ui/card";
import { PLANS, asPlan, type Plan } from "@/lib/plans";
import { NewClinicWizard } from "./new-clinic-wizard";

export default async function NewClinicPage() {
  await guardAdminCap("clinics.create");
  const t = await getDict();
  // The starting price of each plan (Admin → Plans), to prefill the form.
  const prices = await withSystem(async (c) => {
    const out = Object.fromEntries(PLANS.map((p) => [p, 0])) as Record<Plan, number>;
    for (const r of (await c.query(`select plan, price from plan_defaults`)).rows) out[asPlan(r.plan)] = Number(r.price);
    return out;
  });
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t.admin.newClinic} />
      <NewClinicWizard prices={prices} />
    </div>
  );
}
