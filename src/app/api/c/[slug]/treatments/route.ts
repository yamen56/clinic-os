import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { consultationService, coordinatorStats, openTreatments } from "@/lib/courses";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/uuid";

/*
  The treatment coordinator's list for reception (a test, behind the opt-in
  `coordinator` feature): who is part-way through a treatment and what the
  system did about it. It takes the Due back list's place while the feature is
  on — the finish sheet's next visits are one of its sources.
*/

/** How long a stalled one stays on the list: after that it is history, not a call to make. */
const STALLED_SHOWN_DAYS = 120;

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "calendar", { module: "coordinator" });
  if (!g.ok) return g.res;
  const out = await inClinic(g.access, async (c) => {
    const tz = g.access.clinic.timezone;
    const today = DateTime.now().setZone(tz).startOf("day");
    const all = await openTreatments(c, g.access.clinicId, { aheadDays: 7 });
    const oldest = today.minus({ days: STALLED_SHOWN_DAYS }).toISODate()!;
    const soon = today.plus({ days: 21 }).toISO()!;
    const treatments = all.filter(
      (t) =>
        t.state === "due" ||
        (t.state === "stalled" && t.dueOn >= oldest) ||
        (t.state === "auto_booked" && !!t.bookedAt && t.bookedAt <= soon)
    );
    return {
      treatments,
      stats: await coordinatorStats(c, g.access.clinicId),
      consultation: await consultationService(c, g.access.clinicId),
    };
  });
  return NextResponse.json(out);
}

/** Stop following: the treatments this patient has under way are left alone from now on. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "calendar", { module: "coordinator" });
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => ({}))) as { patientId?: unknown };
  const patientId = typeof body.patientId === "string" && isUuid(body.patientId) ? body.patientId : null;
  if (!patientId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const id = await inClinic(g.access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2`, [patientId, g.access.clinicId]);
    if (!p.rowCount) return null;
    const r = await c.query(
      `insert into treatment_follow_stops (clinic_id, patient_id, stopped_by) values ($1, $2, $3) returning id`,
      [g.access.clinicId, patientId, g.access.session.user.id]
    );
    await audit(c, {
      clinicId: g.access.clinicId,
      userId: g.access.session.user.id,
      action: "treatment.stop_following",
      entity: "patient",
      entityId: patientId,
    });
    return r.rows[0].id as string;
  });
  if (!id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ id });
}

/** Undo of Stop following, from its toast. */
export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "calendar", { module: "coordinator" });
  if (!g.ok) return g.res;
  const id = new URL(req.url).searchParams.get("id");
  if (!isUuid(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  await inClinic(g.access, (c) =>
    c.query(`delete from treatment_follow_stops where id = $1 and clinic_id = $2 and created_at > now() - interval '1 hour'`, [
      id,
      g.access.clinicId,
    ])
  );
  return NextResponse.json({ ok: true });
}
