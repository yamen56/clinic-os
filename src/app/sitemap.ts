import type { MetadataRoute } from "next";
import { withSystem } from "@/lib/db";
import { appUrl } from "@/lib/urls";

export const revalidate = 3600;

/**
 * Every booking page a clinic has switched on.
 *
 * The only URLs on this domain worth submitting. A clinic that publishes a
 * booking link wants to be found by the people who would use it, and this is
 * the one surface here that answers a search somebody actually types — the
 * clinic's name plus "حجز موعد".
 *
 * Inactive links are left out rather than listed and disallowed: a sitemap
 * saying "index this" about a page that has been turned off is a contradiction
 * a crawler resolves by trusting neither.
 *
 * The suspension filter has to match `loadPublicLink` exactly, for the same
 * reason. A suspended clinic's booking page renders "no longer active" and is
 * noindex, so listing it here would submit a page we simultaneously ask not to
 * be indexed — and the mismatch would only appear once a clinic stopped paying.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = appUrl();
  const rows = await withSystem(async (c) => {
    const r = await c.query(
      `select b.slug, greatest(b.updated_at, cl.updated_at) as touched
         from booking_links b
         join clinics cl on cl.id = b.clinic_id
        where b.active
          and cl.subscription_status <> 'suspended'
        order by touched desc
        limit 5000`
    );
    return r.rows as { slug: string; touched: Date }[];
  }).catch(() => [] as { slug: string; touched: Date }[]);

  return rows.map((r) => ({
    url: `${base}/book/${r.slug}`,
    lastModified: r.touched,
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));
}
