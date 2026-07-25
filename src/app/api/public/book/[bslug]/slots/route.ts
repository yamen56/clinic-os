import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { withSystem } from "@/lib/db";
import { loadPublicLink } from "@/lib/booking-public";
import { computeSlots } from "@/lib/slots";

export async function GET(req: Request, ctx: { params: Promise<{ bslug: string }> }) {
  const { bslug } = await ctx.params;
  const data = await loadPublicLink(bslug);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const url = new URL(req.url);
  const serviceId = url.searchParams.get("serviceId");
  const doctorId = url.searchParams.get("doctorId");
  const date = url.searchParams.get("date");
  if (!serviceId || !date) return NextResponse.json({ error: "missing" }, { status: 400 });
  if (!data.services.some((s) => s.id === serviceId))
    return NextResponse.json({ error: "bad_service" }, { status: 400 });

  const day = DateTime.fromISO(date, { zone: data.clinic.timezone });
  const today = DateTime.now().setZone(data.clinic.timezone).startOf("day");
  if (!day.isValid || day < today || day > today.plus({ days: data.link.max_days_ahead })) {
    return NextResponse.json({ slots: [] });
  }

  const slots = await withSystem((c) =>
    computeSlots(c, {
      clinicId: data.clinic.id,
      tz: data.clinic.timezone,
      clinicHours: data.clinic.working_hours,
      blockedDates: data.clinic.blocked_dates,
      serviceId,
      doctorMemberId: doctorId || null,
      dateISO: date,
      minNoticeMin: data.link.min_notice_min,
      granularityMin: data.link.slot_granularity_min,
      linkDoctorId: data.link.doctor_member_id,
    })
  );
  return NextResponse.json({ slots });
}
