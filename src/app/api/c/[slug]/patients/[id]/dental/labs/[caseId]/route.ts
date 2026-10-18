import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { toEvent } from "@/lib/charts/dental/db";
import { toLabCase } from "@/lib/charts/dental/labs";

/*
  A lab case, as it goes: back from the lab, called off, its cost or due date
  corrected. Its cost comes into the doctor's share, so once the lab has been
  paid for it (it points at the expense that paid it) the cost is settled and
  stays as it is. Every change is a line in the treatment's history.
*/

const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("received") }),
  // Back to "at the lab": a Received tapped by mistake.
  z.object({ op: z.literal("sent") }),
  z.object({ op: z.literal("cancel") }),
  z.object({ op: z.literal("cost"), cost: z.number().min(0).max(1_000_000) }),
  z.object({ op: z.literal("due"), dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
  z.object({ op: z.literal("note"), note: z.string().trim().max(1000) }),
]);

type Params = { params: Promise<{ slug: string; id: string; caseId: string }> };

export async function PATCH(req: Request, ctx: Params) {
  const { slug, id, caseId } = await ctx.params;
  if (!isUuid(id) || !isUuid(caseId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, ["patients.charts", "invoices"]);
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;

  const result = await inClinic(access, async (c) => {
    const cur = (
      await c.query(
        `select lc.*, l.name as lab_name from lab_cases lc join dental_labs l on l.id = lc.lab_id
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
