import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { withSystem } from "@/lib/db";
import { loadPublicLink, rateLimit, clientIp } from "@/lib/booking-public";
import { computeDayCounts } from "@/lib/slots";

/**
 * How many times are left on each day of the visible strip.
 *
 * The page asks for this once when a service is chosen, then greys out the days
 * with nothing on them and lands the patient on the first day that has
 * something. It is one request for the whole window, not one per day — see
 * `computeDayCounts`.
 */
export async function GET(req: Request, ctx: { params: Promise<{ bslug: string }> }) {
  const { bslug } = await ctx.params;
  // Cheaper per call than the slot scan but wider, so it gets its own bucket.
  if (!rateLimit(`days:${bslug}:${clientIp(req)}`, 60, 10 * 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const data = await loadPublicLink(bslug);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const url = new URL(req.url);
  const serviceId = url.searchParams.get("serviceId");
  const doctorId = url.searchParams.get("doctorId");
  if (!serviceId) return NextResponse.json({ error: "missing" }, { status: 400 });
  if (!data.services.some((s) => s.id === serviceId))
    return NextResponse.json({ error: "bad_service" }, { status: 400 });

  const today = DateTime.now().setZone(data.clinic.timezone).startOf("day");
  const counts = await withSystem((c) =>
    computeDayCounts(c, {
      clinicId: data.clinic.id,
      tz: data.clinic.timezone,
      clinicHours: data.clinic.working_hours,
      blockedDates: data.clinic.blocked_dates,
      serviceId,
      doctorMemberId: doctorId || null,
      minNoticeMin: data.link.min_notice_min,
      granularityMin: data.link.slot_granularity_min,
      linkDoctorId: data.link.doctor_member_id,
      fromISO: today.toISODate()!,
      days: Math.min(data.link.max_days_ahead, 60),
    })
  );
  return NextResponse.json({ counts });
}
