import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { MARK_SELECT, resolveTreatment, toEvent, toMark } from "@/lib/charts/dental/db";
import { todaysVisit } from "@/lib/charts/dental/server";
import { priceFor } from "@/lib/charts/dental/billing-server";
import { variantOf } from "@/lib/charts/dental/pricing";

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
  /** Done at an emergency visit. */
  emergency: z.boolean().default(false),
  /** Said when it was recorded: what brought them in, what is wrong with the work redone. */
  note: z.string().max(2000).default(""),
  /** The earlier work on this patient it does again: a crown remade, a root canal re-treated. */
  redoOf: z.string().uuid().nullish(),
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

    /*
      A redo points at work of this patient's that stands: done here or
      already there, not voided. Checked by hand — a foreign key does not see
      row security, and another patient's crown is not this one's to redo.
    */
    const redoOf = [...new Set(parsed.data.marks.map((m) => m.redoOf).filter((x): x is string => !!x))];
    if (redoOf.length) {
      const ok = await c.query(
        `select count(*)::int as n from chart_marks
          where id = any($1::uuid[]) and patient_id = $2 and clinic_id = $3
            and voided_at is null and kind = 'procedure' and status <> 'planned'`,
        [redoOf, id, access.clinicId]
      );
      if (ok.rows[0].n !== redoOf.length) return { error: "invalid_redo" as const };
    }

    // Work recorded as done is done at today's visit, when there is one.
    const visit = parsed.data.marks.some((m) => m.status === "done") ? await todaysVisit(c, access.clinicId, id, null, performers[0] ?? null) : null;

    // Every treatment resolved before anything is written: returning an error
    // half-way would commit the rows already inserted.
    const resolved = [];
    for (const m of parsed.data.marks) {
      const tr = await resolveTreatment(c, access.clinicId, m.treatmentKey);
      if (!tr) return { error: "unknown_treatment" as const };
      resolved.push({ m, tr });
    }

    /*
      The price each treatment starts at, from the clinic's list — a snapshot,
      so changing the list later never rewrites a quote. Findings and work done
      elsewhere cost nothing here, and the parts of a full arch are priced as
      the arch, not one by one.
    */
    const archGroups = new Set(parsed.data.marks.filter((m) => m.groupId && !/^[1-8][1-8]$/.test(m.site)).map((m) => m.groupId));
    const ids: string[] = [];
    for (const { m, tr } of resolved) {
      // A finding is what was found: it has no plan and no completion.
      const status = tr.kind === "finding" ? "existing" : m.status;
      const archPart = !!m.groupId && archGroups.has(m.groupId) && /^[1-8][1-8]$/.test(m.site);
      const price = tr.kind === "procedure" && status !== "existing" && !archPart ? await priceFor(c, access.clinicId, tr.key, variantOf(tr.key, m.detail)) : null;
      await c.query(
        `insert into chart_marks (id, clinic_id, patient_id, site, surfaces, treatment_key, label, label_ar, abbr, look, kind,
                                  detail, status, group_id, role, performed_by, recorded_by, done_at, emergency, appointment_id,
                                  fee, service_id, redo_of, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, case when $13 = 'done' then now() end, $18,
                 case when $13 = 'done' then $19::uuid end, $20, $21, $22, $23)`,
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
          m.emergency,
          visit,
          price?.price ?? null,
          price?.serviceId ?? null,
          m.redoOf ?? null,
          m.note,
        ]
      );
      // The old work's history says it was taken up again, and when.
      if (m.redoOf) {
        await c.query(`insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason) values ($1, $2, 'redone', $3, $4)`, [
          access.clinicId,
          m.redoOf,
          access.session.user.id,
          m.id,
        ]);
      }
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
      detail: { marks: parsed.data.marks.map((m) => ({ site: m.site, treatment: m.treatmentKey, status: m.status, ...(m.redoOf ? { redoOf: m.redoOf } : {}) })) },
    });
    const marks = await c.query(`${MARK_SELECT} where m.id = any($1::uuid[]) and m.clinic_id = $2 order by m.created_at`, [ids, access.clinicId]);
    // Its own lines, and the "redone" line on the work it redoes.
    const events = await c.query(
      `select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user
        where e.clinic_id = $2 and (e.mark_id = any($1::uuid[]) or (e.action = 'redone' and e.reason = any($3::text[])))`,
      [ids, access.clinicId, ids]
    );
    return { marks: marks.rows.map(toMark), events: events.rows.map(toEvent) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ ok: true, ...result });
}
