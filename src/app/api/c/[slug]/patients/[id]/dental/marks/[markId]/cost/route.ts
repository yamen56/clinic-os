import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { MARK_SELECT, toEvent, toMark } from "@/lib/charts/dental/db";

/*
  What this patient's treatment used in materials, set by hand.

  A treatment's materials cost what its price on the list says (Treatment
  prices → Materials), and that cost comes into the doctor's share by the
  doctor's deal (0081). For one patient it can differ — a second graft, a
  longer implant — so it can be set here, and "Use the list's" (null) goes
  back. Like the price, it can change until the treatment is on an invoice
  that stands: at billing it is frozen beside the doctor's rate.
*/

const bodySchema = z.object({ materialCost: z.number().min(0).max(1_000_000).nullable() });

type Params = { params: Promise<{ slug: string; id: string; markId: string }> };

export async function POST(req: Request, ctx: Params) {
  const { slug, id, markId } = await ctx.params;
  if (!isUuid(id) || !isUuid(markId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, ["patients.charts", "invoices"]);
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const cost = parsed.data.materialCost === null ? null : Math.round(parsed.data.materialCost * 100) / 100;

  const result = await inClinic(access, async (c) => {
    const cur = (
      await c.query(`select * from chart_marks where id = $1 and patient_id = $2 and clinic_id = $3 for update`, [markId, id, access.clinicId])
    ).rows[0];
    if (!cur) return { error: "not_found" as const };
    if (cur.voided_at || cur.kind !== "procedure" || cur.status === "existing") return { error: "not_chargeable" as const };
    // A tooth of a full arch is costed as the arch.
    if (cur.group_id && /^[1-8][1-8]$/.test(cur.site)) {
      const arch = await c.query(`select 1 from chart_marks where group_id = $1 and clinic_id = $2 and site !~ '^[1-8][1-8]$'`, [cur.group_id, access.clinicId]);
      if (arch.rowCount) return { error: "not_chargeable" as const };
    }
    const billed = await c.query(
      `select 1 from invoice_item_marks iim
         join invoice_items ii on ii.id = iim.invoice_item_id
         join invoices i on i.id = ii.invoice_id
        where iim.mark_id = $1 and iim.clinic_id = $2 and i.status <> 'void' and i.credit_note_of is null
        limit 1`,
      [markId, access.clinicId]
    );
    if (billed.rowCount) return { error: "billed" as const };

    await c.query(`update chart_marks set material_cost = $2 where id = $1`, [markId, cost]);
    const was = cur.material_cost == null ? null : Number(cur.material_cost);
    const reason = cost === null ? "materials: the list's" : `materials ${cost}${was == null ? "" : ` (was ${was})`}`;
    const ev = (
      await c.query(`insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason) values ($1, $2, 'cost', $3, $4) returning id`, [
        access.clinicId,
        markId,
        access.session.user.id,
        reason,
      ])
    ).rows[0];
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "dental.mark.material_cost",
      entity: "patient",
      entityId: id,
      detail: { mark: markId, treatment: cur.treatment_key, materialCost: cost, was },
    });
    const mark = (await c.query(`${MARK_SELECT} where m.id = $1`, [markId])).rows[0];
    const event = (await c.query(`select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user where e.id = $1`, [ev.id]))
      .rows[0];
    return { mark: toMark(mark), event: toEvent(event) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true, ...result });
}
