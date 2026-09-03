import type { Metadata } from "next";
import { loadPublicLink, type PublicLink } from "@/lib/booking-public";
import { appUrl } from "@/lib/urls";
import { BookingWizard } from "./booking-wizard";
import { CalendarX } from "lucide-react";
import { en } from "@/lib/i18n/en";
import { ar } from "@/lib/i18n/ar";
import { applyVocabulary } from "@/lib/i18n/vocab";
import { getLocale } from "@/lib/i18n";

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

  /*
    The workspace selling software is booking demos, not appointments, and this
    is the line that shows in a search result — the one place where calling a
    demo an appointment would cost a click before anybody has seen the page.
  */
  const agency = data.clinic.vocabulary === "agency";
  const title = agency
    ? ar
      ? `${name} — احجز عرضاً توضيحياً`
      : `Book a demo with ${name}`
    : ar
      ? `${name} — حجز موعد`
      : `Book an appointment at ${name}`;
  /*
    Kept near 150 characters: past that a search engine truncates mid-sentence,
    and the clinic's location is the part most likely to be cut.
  */
  const description = agency
    ? (ar
        ? `احجز عرضاً توضيحياً مع ${name} في الوقت الذي يناسبك، أونلاين وخلال دقيقة.`
        : `Book a demo with ${name} at a time that suits you — online, in under a minute.`
      ).slice(0, 155)
    : ar
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
 *
 * Which is also why the workspace selling software is not one. `MedicalClinic`
 * and `MedicalProcedure` are claims about what this business does, and a demo is
 * not a medical procedure — emitting it would be exactly the padding the rest of
 * this function avoids.
 */
function clinicJsonLd(data: PublicLink, bslug: string, base: string) {
  const ar = data.clinic.default_locale !== "en";
  const name = (ar ? data.clinic.name_ar : data.clinic.name) || data.clinic.name;
  const address = (ar ? data.clinic.address_ar : data.clinic.address) || data.clinic.address;

  const medical = data.clinic.vocabulary !== "agency";

  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": medical ? "MedicalClinic" : "Organization",
    name,
    url: `${base}/book/${bslug}`,
    inLanguage: ar ? "ar-JO" : "en",
  };
  if (data.clinic.phone_e164) node.telephone = data.clinic.phone_e164;
  // No `addressCountry`. It was hard-coded to JO, which is a claim about the
  // clinic that we have no column for and cannot make on its behalf.
  if (address) node.address = { "@type": "PostalAddress", streetAddress: address };
  if (data.clinic.google_maps_url) node.hasMap = data.clinic.google_maps_url;
  if (data.clinic.logo_path) node.image = `${base}/api/public/clinic-logo/${data.clinic.slug}`;
  if (data.services.length) {
    node.availableService = data.services.map((sv: PublicLink["services"][number]) => ({
      "@type": medical ? "MedicalProcedure" : "Service",
      name: (ar ? sv.name_ar : sv.name) || sv.name,
    }));
  }
  // The action a searcher is here to take, stated in the terms Google reads.
  node.potentialAction = {
    "@type": "ReserveAction",
    target: { "@type": "EntryPoint", urlTemplate: `${base}/book/${bslug}` },
    result: {
      "@type": "Reservation",
      name: medical
        ? ar
          ? "حجز موعد"
          : "Appointment booking"
        : ar
          ? "حجز اجتماع"
          : "Meeting booking",
    },
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
    /*
      Read in the visitor's own language. This branch was Arabic-only and
      hard-coded, even though `book.notFound` had existed in both dictionaries
      the whole time and simply was never used — so an English-speaking visitor
      following a dead link got a sentence they could not read, right-aligned.
    */
    const locale = await getLocale();
    return (
      <main
        dir={locale === "en" ? "ltr" : "rtl"}
        className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-paper p-6 text-center"
      >
        <CalendarX className="h-10 w-10 text-ink-300" />
        <p className="max-w-sm text-ink-500">{(locale === "en" ? en : ar).book.notFound}</p>
      </main>
    );
  }

  /*
    Both languages, merged through this workspace's vocabulary, resolved here
    because only the server knows which workspace the link belongs to. The wizard
    switches between them in the browser.
  */
  const words = {
    en: applyVocabulary(en, data.clinic.vocabulary, "en").book,
    ar: applyVocabulary(ar, data.clinic.vocabulary, "ar").book,
  };

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
        phone: data.clinic.phone_e164,
        tz: data.clinic.timezone,
        defaultLocale: data.clinic.default_locale,
        currency: data.clinic.currency,
      }}
      words={words}
      services={data.services.map((s) => ({
        id: s.id,
        name: s.name,
        nameAr: s.name_ar,
        durationMin: s.duration_min,
        price: Number(s.price),
        locationKind: s.location_kind,
      }))}
      doctors={data.doctors.map((d) => ({
        id: d.id,
        name: d.name,
        title: d.title,
        specialty: d.specialty,
      }))}
      questions={data.questions}
      copy={{
        headline: data.link.headline,
        headlineAr: data.link.headline_ar,
        intro: data.link.intro,
        introAr: data.link.intro_ar,
        successNote: data.link.success_note,
        successNoteAr: data.link.success_note_ar,
        showPrices: data.link.show_prices,
        allowAnyDoctor: data.link.allow_any_doctor,
        consentText: data.link.consent_text,
        consentTextAr: data.link.consent_text_ar,
        requireConsent: data.link.require_consent,
      }}
      maxDaysAhead={data.link.max_days_ahead}
      approvalMode={data.link.approval_mode}
      lockedDoctor={data.link.doctor_member_id}
    />
    </>
  );
}
