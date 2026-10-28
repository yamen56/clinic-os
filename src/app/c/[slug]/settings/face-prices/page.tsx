import { redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadFacePrices } from "@/lib/charts/face/db";
import { loadStockProducts } from "@/lib/charts/face/stock";
import { FacePrices } from "./face-prices";

/*
  Face treatment prices: what each treatment on the face chart costs, in one
  place in Settings. The prices are services — the list the invoice builder
  reads — seen here by treatment, with how often each was recorded and how
  many of those waited with no price; under a treatment, the products used in
  it, each of which may have a price of its own.
*/
export default async function FacePricesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings.services");
  if (!access.clinic.features.aesthetic) redirect(`/c/${slug}/settings/services`);

  const data = await inClinic(access, async (c) => {
    const prices = await loadFacePrices(c, access.clinicId);
    const products = await loadStockProducts(c, access.clinicId, { activeOnly: true });
    const used = (
      await c.query(
        `select treatment_key, count(*)::int as used, count(*) filter (where fee is null)::int as unpriced
           from chart_marks where clinic_id = $1 and chart = 'aesthetic' and voided_at is null
          group by treatment_key`,
        [access.clinicId]
      )
    ).rows as { treatment_key: string; used: number; unpriced: number }[];
    return { prices, products, used };
  });

  return (
    <FacePrices
      slug={slug}
      currency={access.clinic.currency}
      prices={data.prices}
      products={data.products.map((p) => ({ id: p.id, name: p.name, company: p.company, treatments: p.treatments }))}
      usage={Object.fromEntries(data.used.map((u) => [u.treatment_key, { used: u.used, unpriced: u.unpriced }]))}
    />
  );
}
