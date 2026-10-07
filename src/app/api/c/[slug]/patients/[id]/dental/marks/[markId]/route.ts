import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { MARK_SELECT, resolveTreatment, toEvent, toMark } from "@/lib/charts/dental/db";

/*
  Changing an entry on the chart. Every change a reader would care about —
  done, voided, the note, the doctor — is its own line in the entry's history,
  written in the same transaction. Two are not: a detail (the material, the
  canal count) is part of saying what the entry is, and extending a filling
  painted a moment ago with the brush is still the same stroke.

  A voided entry takes no further change. It stays, with who voided it and why.
*/

const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("done"), eventId: z.string().uuid() }),
  z.object({ op: z.literal("void"), eventId: z.string().uuid(), reason: z.string().trim().min(1).max(300) }),
  z.object({ op: z.literal("note"), eventId: z.string().uuid(), note: z.string().max(2000) }),
  z.object({ op: z.literal("performer"), eventId: z.string().uuid(), performerId: z.string().uuid() }),
  z.object({ op: z.literal("detail"), key: z.string().max(24), value: z.string().max(24) }),
  z.object({ op: z.literal("surfaces"), surfaces: z.array(z.enum(["M", "D", "O", "B", "L"])).min(1).max(5) }),
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
      await c.query(`select * from chart_marks where id = $1 and patient_id = $2 and clinic_id = $3 for update`, [markId, id, access.clinicId])
    ).rows[0];
    if (!cur) return { error: "not_found" as const };
    if (cur.voided_at) return { error: "voided" as const };

    let event: { id: string; action: string; reason?: string } | null = null;
    switch (b.op) {
      case "done":
        if (cur.status !== "planned") return { error: "not_planned" as const };
        await c.query(`update chart_marks set status = 'done', done_at = now() where id = $1`, [markId]);
        event = { id: b.eventId, action: "done" };
        break;
      case "void":
        await c.query(`update chart_marks set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1`, [markId, me, b.reason]);
        event = { id: b.eventId, action: "void", reason: b.reason };
        break;
      case "note":
        await c.query(`update chart_marks set note = $2 where id = $1`, [markId, b.note]);
        event = { id: b.eventId, action: "note" };
        break;
      case "performer": {
        const ok = await c.query(`select 1 from clinic_members where id = $1 and clinic_id = $2`, [b.performerId, access.clinicId]);
        if (!ok.rowCount) return { error: "invalid_performer" as const };
        await c.query(`update chart_marks set performed_by = $2 where id = $1`, [markId, b.performerId]);
        event = { id: b.eventId, action: "performer" };
        break;
      }
      case "detail": {
        // Only a detail the treatment actually has, with one of its own options.
        const tr = await resolveTreatment(c, access.clinicId, cur.treatment_key);
        const field = tr?.details?.find((d) => d.key === b.key);
        if (!field || !field.options.some((o) => o.key === b.value)) return { error: "invalid_detail" as const };
        await c.query(`update chart_marks set detail = detail || jsonb_build_object($2::text, $3::text) where id = $1`, [markId, b.key, b.value]);
        break;
      }
      case "surfaces": {
        // The brush extending its own stroke: only the person who painted it, only just now.
        const fresh = await c.query(
          `select 1 from chart_marks where id = $1 and recorded_by = $2 and created_at > now() - interval '2 minutes'`,
          [markId, me]
        );
        if (!fresh.rowCount) return { error: "too_late" as const };
        await c.query(`update chart_marks set surfaces = $2 where id = $1`, [markId, b.surfaces]);
        break;
      }
    }
    if (event) {
      await c.query(`insert into chart_mark_events (id, clinic_id, mark_id, action, by_user, reason) values ($1, $2, $3, $4, $5, $6)`, [
        event.id,
        access.clinicId,
        markId,
        event.action,
        me,
        event.reason ?? null,
      ]);
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: me,
      impersonatedBy: access.session.impersonatedBy,
      action: `dental.mark.${b.op}`,
      entity: "patient",
      entityId: id,
      detail: { mark: markId, site: cur.site, treatment: cur.treatment_key },
    });
    const mark = (await c.query(`${MARK_SELECT} where m.id = $1`, [markId])).rows[0];
    const ev = event
      ? (await c.query(`select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user where e.id = $1`, [event.id])).rows[0]
      : null;
    return { mark: toMark(mark), event: ev ? toEvent(ev) : null };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true, ...result });
}

/*
  Undo: a mis-tap taken back. Allowed only to the person who recorded it, only
  within two minutes, and only while nothing else has happened to it — after
  that it is a clinical record, and leaves the chart by being voided. The audit
  log keeps that it was made and taken back.
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
        `select m.site, m.treatment_key,
                (select count(*)::int from chart_mark_events e where e.mark_id = m.id and e.action <> 'created') as changes
           from chart_marks m
          where m.id = $1 and m.patient_id = $2 and m.clinic_id = $3
            and m.recorded_by = $4 and m.created_at > now() - interval '2 minutes'`,
        [markId, id, access.clinicId, access.session.user.id]
      )
    ).rows[0];
    if (!cur || cur.changes > 0) return { error: "too_late" as const };
    await c.query(`delete from chart_marks where id = $1`, [markId]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "dental.mark.undo",
      entity: "patient",
      entityId: id,
      detail: { mark: markId, site: cur.site, treatment: cur.treatment_key },
    });
    return { ok: true as const };
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
