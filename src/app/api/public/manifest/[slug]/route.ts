import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { whiteLabelSql } from "@/lib/white-label";

/**
 * The installed app's manifest for one clinic (2026-11-27).
 *
 * A Clinic Pro clinic (`branding`) installs as itself: its name under the
 * icon, its logo as the icon, its colour behind the splash, and it opens on
 * its own workspace. Every other clinic gets Clinicti's manifest, unchanged.
 *
 * Public, because a browser fetches a manifest without the session cookie;
 * it says nothing a clinic's booking page does not already show.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const cl = await withSystem(async (c) =>
    (
      await c.query(
        `select cl.slug, coalesce(nullif(cl.name_ar, ''), cl.name) as name, cl.name as name_en, cl.logo_path,
                cl.brand_color, cl.default_locale, ${whiteLabelSql()} as white_label
           from clinics cl where cl.slug = $1 and cl.deleted_at is null`,
        [String(slug).slice(0, 60)]
      )
    ).rows[0]
  ).catch(() => null);
  if (!cl || !cl.white_label) return NextResponse.redirect(new URL("/manifest.webmanifest", _req.url), 302);

  const name = cl.default_locale === "en" ? cl.name_en : cl.name;
  const logo = cl.logo_path ? `/api/public/clinic-logo/${cl.slug}` : null;
  return NextResponse.json(
    {
      name,
      short_name: String(name).slice(0, 24),
      id: `/c/${cl.slug}`,
      start_url: `/c/${cl.slug}`,
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#ffffff",
      theme_color: cl.brand_color || "#0b1220",
      dir: "auto",
      lang: cl.default_locale === "en" ? "en" : "ar",
      categories: ["medical", "business", "productivity"],
      icons: logo
        ? [{ src: logo, sizes: "any", purpose: "any" }]
        : [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          ],
    },
    { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=300" } }
  );
}
