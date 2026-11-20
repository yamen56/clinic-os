import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { GENERAL_MARK_SELECT, toGeneralMark } from "@/lib/treatment/db";
import { visitFor } from "@/lib/treatment/server";
import { redateMarks } from "@/lib/charts/redate";

/*
  Changing a recorded treatment. Each change is its own line in the
  treatment's history, written in the same transaction; a voided treatment
  takes no further change and stays, with who voided it.
*/

const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("void"), eventId: z.string().uuid(), reason: z.string().trim().max(300).optional() }),
  z.object({ op: z.literal("note"), eventId: z.string().uuid(), note: z.string().max(2000) }),
  z.object({ op: z.literal("performer"), eventId: z.string().uuid(), performerId: z.string().uuid() }),
  /** A planned treatment, done: at the visit named, or today's. */
  z.object({ op: z.literal("done"), eventId: z.string().uuid(), appointmentId: z.string().uuid().nullish(), performerId: z.string().uuid().nullish() }),
  /** Done on another day than it was recorded (2026-11-20): see redateMarks. */
  z.object({ op: z.literal("date"), eventId: z.string().uuid(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

type Params = { params: Promise<{ slug: string; id: string; markId: string }> };

export async function PATCH(req: Request, ctx: Params) {
  const { slug, id, markId } = await ctx.params;
  if (!isUuid(id) || !isUuid(markId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;
  const me = access.session.user.id;

  const result = await inClinic(access, async (c) => {
    const cur = (
      await c.query(`select id, label, status, voided_at from chart_marks where id = $1 and patient_id = $2 and clinic_id = $3 and chart = 'general' for update`, [
        markId,
        id,
        access.clinicId,
      ])
    ).rows[0];
    if (!cur) return { error: "not_found" as const };
    if (cur.voided_at) return { error: "voided" as const };

    let reason: string | null = null;
    switch (b.op) {
      case "void":
        await c.query(`update chart_marks set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1`, [markId, me, b.reason || null]);
        reason = b.reason || null;
        break;
      case "note":
        await c.query(`update chart_marks set note = $2 where id = $1`, [markId, b.note]);
        break;
      case "performer": {
        const ok = await c.query(`select 1 from clinic_members where id = $1 and clinic_id = $2`, [b.performerId, access.clinicId]);
        if (!ok.rowCount) return { error: "invalid_performer" as const };
        await c.query(`update chart_marks set performed_by = $2 where id = $1`, [markId, b.performerId]);
        break;
      }
      case "done": {
        // Two screens tapping the same planned treatment: the second is told, and records nothing twice.
        if (cur.status !== "planned") return { error: "not_planned" as const };
        if (b.performerId) {
          const ok = await c.query(`select 1 from clinic_members where id = $1 and clinic_id = $2`, [b.performerId, access.clinicId]);
          if (!ok.rowCount) return { error: "invalid_performer" as const };
        }
        const at = await visitFor(c, access.clinicId, id, b.appointmentId, b.performerId ?? null);
        if ("error" in at) return { error: at.error };
        await c.query(
          `update chart_marks set status = 'done', done_at = coalesce($2::timestamptz, now()), appointment_id = $3, performed_by = coalesce($4, performed_by) where id = $1`,
          [markId, at.doneAt, at.visit, b.performerId ?? null]
        );
        break;
      }
      case "date": {
        if (cur.status !== "done") return { error: "not_done" as const };
        const r = await redateMarks(c, access.clinicId, id, [markId], b.day, access.clinic.timezone);
        if (!r.ok) return { error: r.error };
        reason = b.day;
        break;
      }
    }
    await c.query(`insert into chart_mark_events (id, clinic_id, mark_id, action, by_user, reason) values ($1, $2, $3, $4, $5, $6)`, [
      b.eventId,
      access.clinicId,
      markId,
      b.op,
      me,
      reason,
    ]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: me,
      impersonatedBy: access.session.impersonatedBy,
      action: `treatment.mark.${b.op}`,
      entity: "patient",
      entityId: id,
      detail: { mark: markId, treatment: cur.label },
    });
    const mark = (await c.query(`${GENERAL_MARK_SELECT} where m.id = $1`, [markId])).rows[0];
    return { mark: toGeneralMark(mark) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true, ...result });
}

/*
  Undo: a mis-tap taken back. Only by the person who recorded it, within two
  minutes, while nothing else has happened to it and it is on no invoice —
  after that it is a clinical record, and leaves by being voided.
*/
export async function DELETE(_req: Request, ctx: Params) {
  const { slug, id, markId } = await ctx.params;
  if (!isUuid(id) || !isUuid(markId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;

  const result = await inClinic(access, async (c) => {
    const cur = (
      await c.query(
        `select m.label,
                (select count(*)::int from chart_mark_events e where e.mark_id = m.id and e.action <> 'created') as changes,
                exists (select 1 from invoice_item_marks iim where iim.mark_id = m.id) as billed
           from chart_marks m
          where m.id = $1 and m.patient_id = $2 and m.clinic_id = $3 and m.chart = 'general'
            and m.recorded_by = $4 and m.created_at > now() - interval '2 minutes'`,
        [markId, id, access.clinicId, access.session.user.id]
      )
    ).rows[0];
    if (!cur || cur.changes > 0 || cur.billed) return { error: "too_late" as const };
    await c.query(`delete from chart_marks where id = $1`, [markId]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "treatment.mark.undo",
      entity: "patient",
      entityId: id,
      detail: { mark: markId, treatment: cur.label },
    });
    return { ok: true as const };
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
