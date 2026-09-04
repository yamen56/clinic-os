import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { withSystem } from "@/lib/db";
import { loadPublicLink, rateLimit, clientIp } from "@/lib/booking-public";
import { takePublicSlot, overloaded, rateLimited } from "@/lib/public-guard";
import { computeSlots } from "@/lib/slots";

/**
 * The times left on one day.
 *
 * The most expensive thing an anonymous caller can ask this app to do, and
 * until now the only public endpoint with no limit on it at all — its cheaper
 * sibling `days` was guarded and this was not. Every call loads the service,
 * the doctors and the day's busy scan, then walks the grid. Left open it is a
 * one-line denial of service: a loop over `?date=` holds a database connection
 * per request, and twelve of those are every connection the process has.
 *
 * Two limits, because they stop different things. The per-caller counter stops
 * one machine; the pool allowance stops a thousand of them from taking the
 * connections the clinic's own staff are queueing for.
 */
export async function GET(req: Request, ctx: { params: Promise<{ bslug: string }> }) {
  const { bslug } = await ctx.params;
  if (!rateLimit(`slots:${bslug}:${clientIp(req)}`, 45, 10 * 60_000)) return rateLimited(600);

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

  // Claimed after the cheap checks and before the scan, so a bad date or an
  // unknown service never occupies an allowance somebody else could use.
  const lease = takePublicSlot();
  if (!lease) return overloaded();
  try {
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
  } finally {
    lease.release();
  }
}
