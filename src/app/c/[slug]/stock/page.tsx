import { redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { DateTime } from "luxon";
import { loadCompanies, loadStockProducts } from "@/lib/charts/face/stock";
import { StockClient } from "./stock-client";

/*
  Products and stock: what the face chart uses. The companies the clinic buys
  from and their products, every delivery in, what is left of each batch and
  when it expires, and what was used with nothing on hand.
*/
export default async function StockPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "stock");
  if (!access.clinic.features.aesthetic) redirect(`/c/${slug}`);
  const data = await inClinic(access, async (c) => ({
    products: await loadStockProducts(c, access.clinicId, { withBatches: true }),
    companies: await loadCompanies(c, access.clinicId),
  }));
  return (
    <StockClient
      slug={slug}
      currency={access.clinic.currency}
      today={DateTime.now().setZone(access.clinic.timezone).toISODate()!}
      products={data.products}
      companies={data.companies}
    />
  );
}
