import type { Metadata } from "next";
import { cache } from "react";
import { CalendarX } from "lucide-react";
import { withSystem } from "@/lib/db";
import { rightsOf, rulesOf, visitFromToken } from "@/lib/patient-visit";
import { appUrl } from "@/lib/urls";
import { en } from "@/lib/i18n/en";
import { ar } from "@/lib/i18n/ar";
import { getLocale } from "@/lib/i18n";
import { VisitManager } from "./visit-manager";

/**
 * The patient's own page for one appointment (0115): see it, move it, cancel
 * it — within the clinic's rules, which the routes behind every button check
 * again. Reached only from the link in their WhatsApp.
 *
 * Reading it changes nothing. WhatsApp fetches a link to draw its preview, so a
 * GET here must never be the thing that confirms or cancels anything.
 */

const load = cache((token: string) =>
  withSystem(async (c) => {
    const v = await visitFromToken(c, token);
    if (!v) return null;
    return { v, rules: await rulesOf(c, v), rights: rightsOf(v) };
  })
);

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const d = await load(token);
  const robots = { index: false, follow: false };
  if (!d) return { title: "Clinicti", robots };
  const isAr = d.v.clinic.default_locale !== "en";
  const name = (isAr ? d.v.clinic.name_ar : null) || d.v.clinic.name;
  return { title: isAr ? `موعدك — ${name}` : `Your appointment — ${name}`, robots, referrer: "no-referrer" };
}

export default async function VisitPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const d = await load(token);

  if (!d) {
    const locale = await getLocale();
    return (
      <main
        dir={locale === "en" ? "ltr" : "rtl"}
        className="theme-light flex min-h-dvh flex-col items-center justify-center gap-3 bg-paper p-6 text-center"
        data-visit-missing
      >
        <CalendarX className="h-10 w-10 text-ink-300" />
        <p className="max-w-sm text-ink-500">{(locale === "en" ? en : ar).visit.notFound}</p>
      </main>
    );
  }

  const { v, rules, rights } = d;
  return (
    <VisitManager
      token={token}
      words={{ en: { book: en.book, visit: en.visit }, ar: { book: ar.book, visit: ar.visit } }}
      clinic={{
        name: v.clinic.name,
        nameAr: v.clinic.name_ar,
        slug: v.clinic.slug,
        hasLogo: !!v.clinic.logo_path,
        brandColor: v.clinic.brand_color,
        address: v.clinic.address,
        addressAr: v.clinic.address_ar,
        mapsUrl: v.clinic.google_maps_url,
        phone: v.clinic.phone_e164,
        waNumber: v.clinic.wa_number,
        tz: v.clinic.timezone,
        defaultLocale: v.clinic.default_locale === "en" ? "en" : "ar",
      }}
      visit={{
        status: v.status,
        startISO: new Date(v.starts_at).toISOString(),
        endISO: new Date(v.ends_at).toISOString(),
        firstName: v.patient_name.trim().split(/\s+/)[0] || v.patient_name,
        services: { en: v.service_name ?? "", ar: v.service_name_ar || v.service_name || "" },
        doctor: v.doctor_name,
        meetingUrl: v.meeting_url,
      }}
      rights={rights}
      cutoffHours={v.clinic.patient_changes_cutoff_hours}
      maxDaysAhead={rules.max_days_ahead}
      bookUrl={rules.slug ? `${appUrl()}/book/${rules.slug}` : null}
    />
  );
}
