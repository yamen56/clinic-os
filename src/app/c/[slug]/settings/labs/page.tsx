import { redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { toCustomTreatment } from "@/lib/charts/dental/db";
import { toLab, type LabPrice } from "@/lib/charts/dental/labs";
import { DentalLabs } from "./dental-labs";

/*
  Dental labs: the clinic's labs, and what each charges for its work.

  Beside Treatment prices, behind the same capability: what the work costs the
  clinic is part of pricing it. A clinic with its own lab adds it as in-house;
  one that sends work out adds every lab it uses, each with its own prices.
*/
export default async function DentalLabsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings.services");
  if (!access.clinic.features.dental) redirect(`/c/${slug}/settings/services`);

  const data = await inClinic(access, async (c) => {
    const labs = (await c.query(`select * from dental_labs where clinic_id = $1 and active order by sort, name`, [access.clinicId])).rows.map(toLab);
    const prices = (await c.query(`select lab_id, chart_key, chart_variant, cost from dental_lab_prices where clinic_id = $1`, [access.clinicId])).rows.map(
      (x): LabPrice => ({ labId: x.lab_id, chartKey: x.chart_key, variant: x.chart_variant ?? null, cost: Number(x.cost) })
    );
    const custom = (
      await c.query(
        `select t.*, null::text as creator_name from chart_treatments t where t.clinic_id = $1 and t.chart = 'dental' and t.archived_at is null order by t.created_at`,
        [access.clinicId]
      )
    ).rows.map(toCustomTreatment);
    // How often each lab was sent work, so the list says which are in use.
    const used = (await c.query(`select lab_id, count(*)::int as n from lab_cases where clinic_id = $1 group by lab_id`, [access.clinicId])).rows;
    return { labs, prices, custom, used: Object.fromEntries(used.map((u) => [u.lab_id as string, Number(u.n)])) };
  });

  return (
    <DentalLabs
      slug={slug}
      currency={access.clinic.currency}
      labs={data.labs}
      prices={data.prices}
      custom={JSON.parse(JSON.stringify(data.custom))}
      used={data.used}
    />
  );
}
