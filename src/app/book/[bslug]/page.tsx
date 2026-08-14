import type { Metadata } from "next";
import { loadPublicLink, type PublicLink } from "@/lib/booking-public";
import { appUrl } from "@/lib/urls";
import { BookingWizard } from "./booking-wizard";
import { CalendarX } from "lucide-react";

/**
 * The one page on this domain that is meant to be found.
 *
 * Everything else here is noindex by default (see the root layout), so this
 * opts itself back in. It is also the only page whose search result belongs to
 * somebody other than us: a patient searching the clinic's name should land on
 * the clinic's booking page, which means the title leads with the clinic and
 * the description says what can be done here rather than what we are.
 *
 * A link that has been switched off returns no metadata worth having, and
 * stays noindex — the page renders "no longer active", and a search result
 * pointing at that is worse than no result.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ bslug: string }>;
}): Promise<Metadata> {
  const { bslug } = await params;
  const data = await loadPublicLink(bslug);
  if (!data) return { title: "Clinicti", robots: { index: false, follow: false } };

  const ar = data.clinic.default_locale !== "en";
  const name = (ar ? data.clinic.name_ar : data.clinic.name) || data.clinic.name;
  const where = (ar ? data.clinic.address_ar : data.clinic.address) || "";

  const title = ar ? `${name} — حجز موعد` : `Book an appointment at ${name}`;
  /*
    Kept near 150 characters: past that a search engine truncates mid-sentence,
    and the clinic's location is the part most likely to be cut.
  */
  const description = ar
    ? `احجز موعدك في ${name}${where ? ` — ${where}` : ""} أونلاين خلال دقيقة، بدون اتصال أو انتظار.`.slice(0, 155)
    : `Book your appointment at ${name}${where ? ` — ${where}` : ""} online in under a minute. No phone call, no waiting.`.slice(0, 155);

  return {
    title,
    description,
    alternates: { canonical: `/book/${bslug}` },
    robots: { index: true, follow: true },
    openGraph: {
      title,
      description,
      url: `/book/${bslug}`,
      siteName: "Clinicti",
      type: "website",
      locale: ar ? "ar_JO" : "en_US",
    },
    twitter: { card: "summary", title, description },
  };
}


/**
 * Structured data for the clinic behind this booking page.
 *
 * A `MedicalClinic` node is what lets a result carry the address, the phone
 * number and the services rather than a bare blue link. Every field is emitted
 * only when the clinic actually filled it in: structured data that claims more
 * than the page shows is the specific thing search engines discount, so a half
 * empty node beats a padded one.
 */
function clinicJsonLd(data: PublicLink, bslug: string, base: string) {
  const ar = data.clinic.default_locale !== "en";
  const name = (ar ? data.clinic.name_ar : data.clinic.name) || data.clinic.name;
  const address = (ar ? data.clinic.address_ar : data.clinic.address) || data.clinic.address;

  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "MedicalClinic",
    name,
    url: `${base}/book/${bslug}`,
    inLanguage: ar ? "ar-JO" : "en",
  };
  if (data.clinic.phone_e164) node.telephone = data.clinic.phone_e164;
  if (address) node.address = { "@type": "PostalAddress", streetAddress: address, addressCountry: "JO" };
  if (data.clinic.google_maps_url) node.hasMap = data.clinic.google_maps_url;
  if (data.clinic.logo_path) node.image = `${base}/api/public/clinic-logo/${data.clinic.slug}`;
  if (data.services.length) {
    node.availableService = data.services.map((sv: PublicLink["services"][number]) => ({
      "@type": "MedicalProcedure",
      name: (ar ? sv.name_ar : sv.name) || sv.name,
    }));
  }
  // The action a searcher is here to take, stated in the terms Google reads.
  node.potentialAction = {
    "@type": "ReserveAction",
    target: { "@type": "EntryPoint", urlTemplate: `${base}/book/${bslug}` },
    result: { "@type": "Reservation", name: ar ? "حجز موعد" : "Appointment booking" },
  };
  return node;
}

export default async function PublicBookingPage({
  params,
}: {
  params: Promise<{ bslug: string }>;
}) {
  const { bslug } = await params;
  const data = await loadPublicLink(bslug);

  if (!data) {
    return (
      <main dir="rtl" className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-paper p-6 text-center">
        <CalendarX className="h-10 w-10 text-ink-300" />
        <p className="max-w-sm text-ink-500">صفحة الحجز هذه غير موجودة أو لم تعد نشطة.</p>
      </main>
    );
  }

  return (
    <>
      <script
        type="application/ld+json"
        // Server-rendered from our own query, never from user input rendered as markup.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(clinicJsonLd(data, bslug, appUrl())) }}
      />
    <BookingWizard
      bslug={bslug}
      clinic={{
        name: data.clinic.name,
        nameAr: data.clinic.name_ar,
        slug: data.clinic.slug,
        hasLogo: !!data.clinic.logo_path,
        brandColor: data.clinic.brand_color,
        address: data.clinic.address,
        addressAr: data.clinic.address_ar,
        mapsUrl: data.clinic.google_maps_url,
        tz: data.clinic.timezone,
        defaultLocale: data.clinic.default_locale,
      }}
      services={data.services.map((s) => ({
        id: s.id,
        name: s.name,
        nameAr: s.name_ar,
        durationMin: s.duration_min,
        price: Number(s.price),
      }))}
      doctors={data.doctors.map((d) => ({
        id: d.id,
        name: d.name,
        title: d.title,
        specialty: d.specialty,
      }))}
      maxDaysAhead={data.link.max_days_ahead}
      approvalMode={data.link.approval_mode}
      lockedDoctor={data.link.doctor_member_id}
    />
    </>
  );
}
