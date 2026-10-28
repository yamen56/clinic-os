import { redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadFacePrices } from "@/lib/charts/face/db";
import { FacePrices } from "./face-prices";

/*
  Face treatment prices: what each treatment on the face chart costs, in one
  place in Settings. The prices are services — the list the invoice builder
  reads — seen here by treatment, with how often each was recorded and how
  many of those waited with no price.
*/
export default async function FacePricesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings.services");
  if (!access.clinic.features.aesthetic) redirect(`/c/${slug}/settings/services`);

  const data = await inClinic(access, async (c) => {
    const prices = await loadFacePrices(c, access.clinicId);
    const used = (
      await c.query(
        `select treatment_key, count(*)::int as used, count(*) filter (where fee is null)::int as unpriced
           from chart_marks where clinic_id = $1 and chart = 'aesthetic' and voided_at is null
          group by treatment_key`,
        [access.clinicId]
      )
    ).rows as { treatment_key: string; used: number; unpriced: number }[];
    return { prices, used };
  });

  return (
    <FacePrices
      slug={slug}
      currency={access.clinic.currency}
      prices={data.prices}
      usage={Object.fromEntries(data.used.map((u) => [u.treatment_key, { used: u.used, unpriced: u.unpriced }]))}
    />
  );
}
