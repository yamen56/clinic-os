import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { GENERAL_MARK_SELECT, toGeneralMark } from "@/lib/treatment/db";
import { visitFor } from "@/lib/treatment/server";

/*
  Recording a treatment that no chart draws: a consultation, a dressing, a
  session — a line of the clinic's price list, done at a visit, or planned
  for a later one.

  The browser chooses the id, so the line it already drew and the row stored
  here are the same entry from the first moment. The name and the price come
  from the price list here, never from the request: a snapshot, so a later
  change to the list never rewrites what was done or what it was quoted at.
  Only a treatment whose name was typed by hand has no price; reception
  prices that one on the invoice.

  Planned, it belongs to no visit yet and is on no bill: it waits on the
  patient's record until a visit marks it done (the PATCH beside this).

  A line a chart prices (a crown, a filler) is refused: it is recorded on its
  chart, and taking it here too is how one treatment gets billed twice.
*/

const bodySchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    serviceId: z.string().uuid().nullish(),
    /** The treatment's name, when it is not on the price list. */
    label: z.string().trim().min(1).max(120).nullish(),
    /** Done now, or planned for a later visit. */
    status: z.enum(["done", "planned"]).default("done"),
    /** The visit it was done at. Absent: today's, when the patient has one. */
    appointmentId: z.string().uuid().nullish(),
    performedBy: z.string().uuid().nullish(),
    note: z.string().max(2000).default(""),
  })
  .refine((d) => !!d.serviceId || !!d.label);

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;
  const me = access.session.user.id;
  const planned = d.status === "planned";

  const result = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [id, access.clinicId]);
    if (!p.rowCount) return { error: "not_found" as const };

    let label = d.label ?? "";
    let labelAr = label;
    let fee: number | null = null;
    if (d.serviceId) {
      const s = (
        await c.query(`select name, name_ar, price from services where id = $1 and clinic_id = $2 and active and chart_key is null`, [d.serviceId, access.clinicId])
      ).rows[0];
      if (!s) return { error: "unknown_service" as const };
      label = s.name;
      labelAr = s.name_ar || s.name;
      fee = Number(s.price);
    }
    // A foreign key does not see row security: the doctor is checked against this clinic by hand.
    if (d.performedBy) {
      const ok = await c.query(`select 1 from clinic_members where id = $1 and clinic_id = $2`, [d.performedBy, access.clinicId]);
      if (!ok.rowCount) return { error: "invalid_performer" as const };
    }

    let visit: string | null = null;
    let doneAt: Date | null = null;
    if (!planned) {
      const at = await visitFor(c, access.clinicId, id, d.appointmentId, d.performedBy ?? null);
      if ("error" in at) return { error: at.error };
      visit = at.visit;
      doneAt = at.doneAt;
    }

    await c.query(
      `insert into chart_marks (id, clinic_id, patient_id, chart, site, treatment_key, label, label_ar, look, kind, status,
                                performed_by, recorded_by, done_at, appointment_id, fee, service_id, note)
       values ($1, $2, $3, 'general', 'body', $4, $5, $6, 'general', 'procedure', $14,
               $7, $8, case when $14 = 'planned' then null else coalesce($9::timestamptz, now()) end, $10, $11, $12, $13)`,
      [
        d.id,
        access.clinicId,
        id,
        d.serviceId ? "general" : "general_other",
        label,
        labelAr,
        // Who will do a planned treatment is said when it is done.
        planned ? null : (d.performedBy ?? null),
        me,
        doneAt,
        visit,
        fee,
        d.serviceId ?? null,
        d.note,
        d.status,
      ]
    );
    await c.query(`insert into chart_mark_events (id, clinic_id, mark_id, action, by_user) values ($1, $2, $3, 'created', $4)`, [d.eventId, access.clinicId, d.id, me]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: me,
      impersonatedBy: access.session.impersonatedBy,
      action: planned ? "treatment.mark.plan" : "treatment.mark.create",
      entity: "patient",
      entityId: id,
      detail: { mark: d.id, treatment: label, ...(d.serviceId ? { service: d.serviceId } : {}), ...(visit ? { appointment: visit } : {}) },
    });
    const mark = (await c.query(`${GENERAL_MARK_SELECT} where m.id = $1 and m.clinic_id = $2`, [d.id, access.clinicId])).rows[0];
    return { mark: toGeneralMark(mark) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ ok: true, ...result });
}
