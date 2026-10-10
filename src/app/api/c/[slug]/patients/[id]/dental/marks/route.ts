import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { MARK_SELECT, resolveTreatment, toEvent, toMark } from "@/lib/charts/dental/db";

/*
  Recording on the dental chart: one entry, or several at once (a bridge's
  teeth, a brush stroke across an arch).

  The browser chooses the ids, so the tooth it already drew and the row stored
  here are the same entry from the first moment — no reconciling a temporary id
  afterwards. Everything about the treatment itself — its name, its drawing,
  whether it is a finding — comes from the catalog here, never from the request.
*/

const SITE = /^([1-8][1-8]|Q[1-4]|upper|lower|mouth)$/;

const markSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  site: z.string().regex(SITE),
  surfaces: z.array(z.enum(["M", "D", "O", "B", "L"])).max(5).default([]),
  treatmentKey: z.string().min(1).max(64),
  detail: z.record(z.string().max(24), z.string().max(24)).default({}),
  status: z.enum(["planned", "done", "existing"]),
  groupId: z.string().uuid().nullish(),
  role: z.enum(["abutment", "pontic"]).nullish(),
  performedBy: z.string().uuid().nullish(),
});
// A full arch is the most one tap records: the arch, six implants, fourteen
// bridge teeth and the teeth to take out first.
const bodySchema = z.object({ marks: z.array(markSchema).min(1).max(48) });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const result = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [id, access.clinicId]);
    if (!p.rowCount) return { error: "not_found" as const };

    // A foreign key does not see row security, so a member of another clinic
    // would satisfy it: the doctor is checked against this clinic by hand.
    const performers = [...new Set(parsed.data.marks.map((m) => m.performedBy).filter((x): x is string => !!x))];
    if (performers.length) {
      const ok = await c.query(`select count(*)::int as n from clinic_members where clinic_id = $1 and id = any($2::uuid[])`, [access.clinicId, performers]);
      if (ok.rows[0].n !== performers.length) return { error: "invalid_performer" as const };
    }

    // Every treatment resolved before anything is written: returning an error
    // half-way would commit the rows already inserted.
    const resolved = [];
    for (const m of parsed.data.marks) {
      const tr = await resolveTreatment(c, access.clinicId, m.treatmentKey);
      if (!tr) return { error: "unknown_treatment" as const };
      resolved.push({ m, tr });
    }

    const ids: string[] = [];
    for (const { m, tr } of resolved) {
      // A finding is what was found: it has no plan and no completion.
      const status = tr.kind === "finding" ? "existing" : m.status;
      await c.query(
        `insert into chart_marks (id, clinic_id, patient_id, site, surfaces, treatment_key, label, label_ar, abbr, look, kind,
                                  detail, status, group_id, role, performed_by, recorded_by, done_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, case when $13 = 'done' then now() end)`,
        [
          m.id,
          access.clinicId,
          id,
          m.site,
          tr.needsSurfaces ? m.surfaces : [],
          tr.key,
          tr.en,
          tr.ar,
          tr.abbr ?? null,
          tr.look,
          tr.kind,
          JSON.stringify(m.detail),
          status,
          m.groupId ?? null,
          m.role ?? null,
          m.performedBy ?? null,
          access.session.user.id,
        ]
      );
      await c.query(`insert into chart_mark_events (id, clinic_id, mark_id, action, by_user) values ($1, $2, $3, 'created', $4)`, [
        m.eventId,
        access.clinicId,
        m.id,
        access.session.user.id,
      ]);
      ids.push(m.id);
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "dental.mark.create",
      entity: "patient",
      entityId: id,
      detail: { marks: parsed.data.marks.map((m) => ({ site: m.site, treatment: m.treatmentKey, status: m.status })) },
    });
    const marks = await c.query(`${MARK_SELECT} where m.id = any($1::uuid[]) and m.clinic_id = $2 order by m.created_at`, [ids, access.clinicId]);
    const events = await c.query(
      `select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user
        where e.mark_id = any($1::uuid[]) and e.clinic_id = $2`,
      [ids, access.clinicId]
    );
    return { marks: marks.rows.map(toMark), events: events.rows.map(toEvent) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ ok: true, ...result });
}
