import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { computeDayCounts, computeSlots, type SlotResult } from "@/lib/slots";
import { isUuid } from "@/lib/uuid";

/**
 * The next free times for a service (and optionally a doctor), for staff:
 * "find a slot" on a waitlist entry and "suggest times" in the booking panel.
 *
 * The same engine as the public booking page — clinic and doctor hours,
 * blocked dates, existing appointments, buffers and rooms — but with no notice
 * period and a quarter-hour step, because the desk books for the next free
 * quarter hour, not the next half hour two hours out.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "calendar");
  if (!g.ok) return g.res;
  const access = g.access;
  const url = new URL(req.url);
  const serviceId = url.searchParams.get("service");
  const doctorId = url.searchParams.get("doctor");
  if (!isUuid(serviceId)) return NextResponse.json({ error: "service_required" }, { status: 400 });
  if (doctorId && !isUuid(doctorId)) return NextResponse.json({ error: "bad_doctor" }, { status: 400 });
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 6, 1), 20);
  const tz = access.clinic.timezone;
  const fromParam = url.searchParams.get("from");
  const today = DateTime.now().setZone(tz).startOf("day");
  const from =
    fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam)
      ? DateTime.max(DateTime.fromISO(fromParam, { zone: tz }), today)
      : today;

  const slots = await inClinic(access, async (c) => {
    const clinic = (
      await c.query(`select working_hours, blocked_dates from clinics where id = $1`, [access.clinicId])
    ).rows[0];
    const opts = {
      clinicId: access.clinicId,
      tz,
      clinicHours: clinic.working_hours,
      blockedDates: clinic.blocked_dates,
      serviceId,
      doctorMemberId: doctorId || null,
      minNoticeMin: 0,
      granularityMin: 15,
      linkDoctorIds: [] as string[],
    };
    // Which days have anything at all, in one pass, then the times on the
    // first few of them — rather than walking day by day.
    const counts = await computeDayCounts(c, { ...opts, fromISO: from.toISODate()!, days: 45 });
    const days = Object.keys(counts).filter((d) => counts[d] > 0).sort();
    const out: SlotResult[] = [];
    for (const day of days) {
      if (out.length >= limit) break;
      out.push(...(await computeSlots(c, { ...opts, dateISO: day })).slice(0, limit - out.length));
    }
    return out;
  });
  return NextResponse.json({ slots });
}
