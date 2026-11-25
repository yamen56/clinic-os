import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { toEvent } from "@/lib/charts/dental/db";
import { LAB_STAGES, LAB_TRIPS, toLabCase, tripsOf } from "@/lib/charts/dental/labs";
import { labSpec } from "@/lib/charts/dental/lab-server";

/*
  A lab case, as it goes: back from the lab, called off, its cost or due date
  corrected. Its cost comes into the doctor's share, so once the lab has been
  paid for it (it points at the expense that paid it) the cost is settled and
  stays as it is. Every change is a line in the treatment's history.

  A bridge or a full arch that came back for a try-in goes again: the next trip
  of the same order, at the same price — whether or not the lab was paid.
*/

const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("received") }),
  // Back to "at the lab": a Received tapped by mistake.
  z.object({ op: z.literal("sent") }),
  z.object({ op: z.literal("cancel") }),
  z.object({ op: z.literal("cost"), cost: z.number().min(0).max(1_000_000) }),
  z.object({ op: z.literal("due"), dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
  z.object({ op: z.literal("note"), note: z.string().trim().max(1000) }),
  /** Back to the lab, for the next stage of the same order. */
  z.object({
    op: z.literal("resend"),
    stage: z.enum(LAB_STAGES),
    dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    note: z.string().trim().max(1000).optional(),
  }),
]);

const STAGE_WORDS: Record<(typeof LAB_STAGES)[number], string> = { framework: "the framework", bisque: "the porcelain", jig: "a verification jig", teeth: "a teeth try-in", finish: "finishing" };
const MAX_TRIPS = 20;

type Params = { params: Promise<{ slug: string; id: string; caseId: string }> };

export async function PATCH(req: Request, ctx: Params) {
  const { slug, id, caseId } = await ctx.params;
  if (!isUuid(id) || !isUuid(caseId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, ["patients.charts", "invoices"], { module: "dental" });
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;

  const result = await inClinic(access, async (c) => {
    const cur = (
      await c.query(
        `select lc.*, l.name as lab_name, m.treatment_key, m.site, m.group_id, m.detail
           from lab_cases lc join dental_labs l on l.id = lc.lab_id join chart_marks m on m.id = lc.mark_id
          where lc.id = $1 and lc.patient_id = $2 and lc.clinic_id = $3 for update of lc`,
        [caseId, id, access.clinicId]
      )
    ).rows[0];
    if (!cur) return { error: "not_found" as const };
    let set: string;
    let vals: unknown[];
    let reason: string;
    switch (d.op) {
      case "received":
        set = `status = 'received', received_at = now()`;
        vals = [];
        reason = `back from ${cur.lab_name}`;
        break;
      case "sent":
        set = `status = 'sent', received_at = null`;
        vals = [];
        reason = `at ${cur.lab_name} again`;
        break;
      case "cancel":
        if (cur.expense_id) return { error: "paid" as const };
        set = `status = 'cancelled'`;
        vals = [];
        reason = `lab work at ${cur.lab_name} cancelled`;
        break;
      case "cost": {
        if (cur.expense_id) return { error: "paid" as const };
        const cost = Math.round(d.cost * 100) / 100;
        set = `cost = $4`;
        vals = [cost];
        reason = `lab cost ${cost} (was ${Number(cur.cost)})`;
        break;
      }
      case "due":
        set = `due_on = $4`;
        vals = [d.dueOn];
        reason = d.dueOn ? `due back ${d.dueOn}` : "no due date";
        break;
      case "note":
        set = `note = $4`;
        vals = [d.note];
        reason = "lab note";
        break;
      case "resend": {
        // Only what is back goes again, and only work that goes more than once.
        if (cur.status !== "received") return { error: "not_back" as const };
        if (!(LAB_TRIPS[cur.treatment_key] ?? []).some((x) => x.offers.includes(d.stage))) return { error: "invalid_stage" as const };
        const before = tripsOf(toLabCase(cur));
        if (before.length >= MAX_TRIPS) return { error: "too_many" as const };
        const spec = await labSpec(c, access.clinicId, { id: cur.mark_id, site: cur.site, group_id: cur.group_id, treatment_key: cur.treatment_key, detail: cur.detail });
        set = `status = 'sent', received_at = null, stage = $4, due_on = $5, trips = $6::jsonb, spec = $7::jsonb,
               sent_on = ((now() at time zone (select timezone from clinics where id = $3)))::date, note = coalesce($8, note)`;
        vals = [d.stage, d.dueOn, JSON.stringify(before), JSON.stringify(spec), d.note ?? null];
        reason = `back to ${cur.lab_name} for ${STAGE_WORDS[d.stage]}`;
        break;
      }
    }
    const row = (await c.query(`update lab_cases set ${set} where id = $1 and patient_id = $2 and clinic_id = $3 returning *`, [caseId, id, access.clinicId, ...vals]))
      .rows[0];
    const ev = (
      await c.query(`insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason) values ($1, $2, 'lab', $3, $4) returning id`, [
        access.clinicId,
        cur.mark_id,
        access.session.user.id,
        reason,
      ])
    ).rows[0];
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: `lab_case.${d.op}`,
      entity: "patient",
      entityId: id,
      detail: { case: caseId, mark: cur.mark_id, ...(d.op === "cost" ? { cost: d.cost, was: Number(cur.cost) } : {}) },
    });
    const event = (await c.query(`select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user where e.id = $1`, [ev.id]))
      .rows[0];
    return { labCase: toLabCase(row), event: toEvent(event) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true, ...result });
}
