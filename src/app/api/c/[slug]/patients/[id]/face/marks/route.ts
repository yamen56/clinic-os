import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { todaysVisit } from "@/lib/charts/dental/server";
import { toEvent } from "@/lib/charts/dental/db";
import { FACE_MARK_SELECT, loadFacePrices, toFaceMark } from "@/lib/charts/face/db";
import { FACE_TREATMENT_BY_KEY, feeOf, inFaceOrder, isZone, quantityOf } from "@/lib/charts/face/catalog";

/*
  Recording a treatment on the face chart: what was done, on which parts of
  the face, how much — done now, at today's visit.

  The browser chooses the id, so the dot it already drew and the row stored
  here are the same entry from the first moment. The treatment's name, its
  family and what its price counts come from the catalog here, never from the
  request; its price comes from the clinic's list, a snapshot so a later
  change to the list never rewrites a quote.
*/

const bodySchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  treatmentKey: z.string().min(1).max(64),
  areas: z
    .array(z.object({ zone: z.string().max(24), units: z.number().int().min(0).max(1000).optional() }))
    .min(1)
    .max(24),
  /** Syringes or threads, for a treatment priced by them. */
  count: z.number().int().min(1).max(100).default(1),
  performedBy: z.string().uuid().nullish(),
  note: z.string().max(2000).default(""),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts", { module: "aesthetic" });
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;

  const t = FACE_TREATMENT_BY_KEY.get(d.treatmentKey);
  if (!t) return NextResponse.json({ error: "unknown_treatment" }, { status: 400 });
  // Each area once, a real one, one this treatment is done on.
  const zones = d.areas.map((a) => a.zone);
  if (new Set(zones).size !== zones.length || !zones.every((z) => isZone(z) && t.fits.includes(z))) {
    return NextResponse.json({ error: "invalid_area" }, { status: 400 });
  }
  // Units only where the treatment is dosed in them.
  const areas = inFaceOrder(d.areas.map((a) => (t.units ? { zone: a.zone, units: a.units ?? 0 } : { zone: a.zone })));

  const result = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [id, access.clinicId]);
    if (!p.rowCount) return { error: "not_found" as const };

    // A foreign key does not see row security: the doctor is checked against this clinic by hand.
    if (d.performedBy) {
      const ok = await c.query(`select 1 from clinic_members where id = $1 and clinic_id = $2`, [d.performedBy, access.clinicId]);
      if (!ok.rowCount) return { error: "invalid_performer" as const };
    }

    const visit = await todaysVisit(c, access.clinicId, id, null, d.performedBy ?? null);
    const price = (await loadFacePrices(c, access.clinicId, t.key))[0] ?? null;
    const quantity = quantityOf(t, areas, d.count);
    await c.query(
      `insert into chart_marks (id, clinic_id, patient_id, chart, site, treatment_key, label, label_ar, look, kind, detail, status,
                                performed_by, recorded_by, done_at, appointment_id, fee, service_id, note, areas, quantity)
       values ($1, $2, $3, 'aesthetic', 'face', $4, $5, $6, $7, 'procedure', '{}', 'done',
               $8, $9, now(), $10, $11, $12, $13, $14, $15)`,
      [
        d.id,
        access.clinicId,
        id,
        t.key,
        t.en,
        t.ar,
        t.family,
        d.performedBy ?? null,
        access.session.user.id,
        visit,
        feeOf(price?.price ?? null, quantity),
        price?.serviceId ?? null,
        d.note,
        // jsonb from JS is stringified by hand, or an array goes out as a PG array literal.
        JSON.stringify(areas),
        quantity,
      ]
    );
    await c.query(`insert into chart_mark_events (id, clinic_id, mark_id, action, by_user) values ($1, $2, $3, 'created', $4)`, [
      d.eventId,
      access.clinicId,
      d.id,
      access.session.user.id,
    ]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "face.mark.create",
      entity: "patient",
      entityId: id,
      detail: { mark: d.id, treatment: t.key, areas: zones, quantity },
    });
    const mark = (await c.query(`${FACE_MARK_SELECT} where m.id = $1 and m.clinic_id = $2`, [d.id, access.clinicId])).rows[0];
    const events = await c.query(
      `select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user where e.mark_id = $1 and e.clinic_id = $2`,
      [d.id, access.clinicId]
    );
    return { mark: toFaceMark(mark), events: events.rows.map(toEvent) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ ok: true, ...result });
}
