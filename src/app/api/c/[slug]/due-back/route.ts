import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { dismissDueBack, dueBackList } from "@/lib/due-back";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/uuid";

/** Due back, for the list above the waitlist — re-read when realtime says an appointment changed. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "calendar");
  if (!g.ok) return g.res;
  const due = await inClinic(g.access, (c) => dueBackList(c, g.access.clinicId));
  return NextResponse.json({ due });
}

/**
 * Take a patient off Due back (0116) — they said not now, went elsewhere, or
 * the desk has it in hand — or put them back with `undo`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "calendar");
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => ({}))) as { appointmentId?: string; undo?: boolean };
  if (!isUuid(body.appointmentId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const ok = await inClinic(g.access, async (c) => {
    const done = await dismissDueBack(c, g.access.clinicId, body.appointmentId!, g.access.session.user.id, body.undo === true);
    if (done) {
      await audit(c, {
        clinicId: g.access.clinicId,
        userId: g.access.session.user.id,
        impersonatedBy: g.access.session.impersonatedBy,
        action: body.undo ? "due_back.restore" : "due_back.dismiss",
        entity: "appointment",
        entityId: body.appointmentId!,
      });
    }
    return done;
  });
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}
