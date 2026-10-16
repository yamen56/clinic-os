import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { dayRangeUtc } from "@/lib/dates";

/**
 * The caller's own patients who are in the waiting room right now: arrived
 * today, not yet called in. What the doctor's arrival chime watches.
 *
 * Only ever the caller's own appointments — a doctor's screen chimes for the
 * doctor's patients — so a member who is not a doctor gets an empty list.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "calendar");
  if (!g.ok) return g.res;
  const access = g.access;
  const serverNow = new Date().toISOString();
  if (!access.memberId) return NextResponse.json({ arrivals: [], serverNow });

  const range = dayRangeUtc(access.clinic.timezone);
  const arrivals = await inClinic(access, async (c) =>
    (
      await c.query(
        `select a.id, a.arrived_at, a.starts_at, p.full_name as patient_name,
                rm.name as room_name, rm.name_ar as room_name_ar
           from appointments a
           join patients p on p.id = a.patient_id
           left join clinic_rooms rm on rm.id = a.room_id
          where a.clinic_id = $1 and a.doctor_member_id = $2
            and a.starts_at >= $3 and a.starts_at < $4
            and a.status in ('pending_approval', 'scheduled', 'confirmed')
            and a.arrived_at is not null and a.seated_at is null
          order by a.arrived_at`,
        [access.clinicId, access.memberId, range.start, range.end]
      )
    ).rows
  );
  return NextResponse.json({ arrivals, serverNow });
}
