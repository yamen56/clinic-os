import { redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadPrices } from "@/lib/charts/dental/billing-server";
import { toCustomTreatment } from "@/lib/charts/dental/db";
import { priceFrom, variantOf } from "@/lib/charts/dental/pricing";
import { DentalPrices, type NeedsPrice, type Usage } from "./dental-prices";

/*
  Treatment prices: what each treatment on the dental chart costs, in one
  place in Settings.

  The prices are services — the same list the invoice builder and the booking
  page read — seen here by treatment, with what the clinic has actually been
  charting: how often each treatment is used, and which were charted with no
  price at all, first, so the gaps are the first thing the page asks about.
*/
export default async function TreatmentPricesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings.services");
  if (!access.clinic.features.dental) redirect(`/c/${slug}/settings/services`);

  const data = await inClinic(access, async (c) => {
    const prices = await loadPrices(c, access.clinicId);
    const free = (
      await c.query(`select id, name, name_ar, price from services where clinic_id = $1 and active and chart_key is null order by sort, name`, [access.clinicId])
    ).rows;
    const custom = (
      await c.query(
        `select t.*, u.full_name as creator_name from chart_treatments t left join users u on u.id = t.created_by
          where t.clinic_id = $1 and t.chart = 'dental' and t.archived_at is null order by t.created_at`,
        [access.clinicId]
      )
    ).rows.map(toCustomTreatment);
    /*
      What the clinic charts, counted as treatments — a bridge once, not per
      tooth, and never the parts of a full arch, which are priced as the whole.
    */
    const used = (
      await c.query(
        `select m.treatment_key, m.detail,
                count(distinct coalesce(m.group_id, m.id))::int as used,
                count(distinct coalesce(m.group_id, m.id)) filter (where m.fee is null)::int as unpriced
           from chart_marks m
          where m.clinic_id = $1 and m.chart = 'dental' and m.kind = 'procedure' and m.voided_at is null and m.status <> 'existing'
            and not (m.group_id is not null and m.site ~ '^[1-8][1-8]$'
                     and exists (select 1 from chart_marks p where p.group_id = m.group_id and p.site !~ '^[1-8][1-8]$'))
          group by m.treatment_key, m.detail`,
        [access.clinicId]
      )
    ).rows as { treatment_key: string; detail: Record<string, string> | null; used: number; unpriced: number }[];
    return { prices, free, custom, used };
  });

  // Per treatment: how often it was charted, and how many of those carry no price.
  const usage: Record<string, Usage> = {};
  // Per treatment and kind: charted with no price, and still nothing on the list to price it.
  const needs = new Map<string, NeedsPrice>();
  for (const u of data.used) {
    const detail = u.detail ?? {};
    const cur = usage[u.treatment_key] ?? { used: 0, unpriced: 0 };
    usage[u.treatment_key] = { used: cur.used + u.used, unpriced: cur.unpriced + u.unpriced };
    if (u.unpriced > 0 && !priceFrom(data.prices, u.treatment_key, detail)) {
      const variant = variantOf(u.treatment_key, detail);
      const k = `${u.treatment_key}:${variant ?? ""}`;
      const n = needs.get(k);
      needs.set(k, { key: u.treatment_key, variant, count: (n?.count ?? 0) + u.unpriced });
    }
  }

  return (
    <DentalPrices
      slug={slug}
      currency={access.clinic.currency}
      custom={JSON.parse(JSON.stringify(data.custom))}
      prices={data.prices}
      services={JSON.parse(JSON.stringify(data.free))}
      usage={usage}
      needs={[...needs.values()].sort((a, b) => b.count - a.count)}
    />
  );
}
