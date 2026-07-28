import type { Metadata } from "next";
import { loadPublicLink } from "@/lib/booking-public";
import { BookingWizard } from "./booking-wizard";
import { CalendarX } from "lucide-react";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ bslug: string }>;
}): Promise<Metadata> {
  const { bslug } = await params;
  const data = await loadPublicLink(bslug);
  if (!data) return { title: "Makan Clinic Platform" };
  const name = data.clinic.name_ar || data.clinic.name;
  return {
    title: `${name} — حجز موعد`,
    description: `احجز موعدك في ${name} خلال دقيقة واحدة`,
  };
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
  );
}
