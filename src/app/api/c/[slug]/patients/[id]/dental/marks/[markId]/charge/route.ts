import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { MARK_SELECT, toMark } from "@/lib/charts/dental/db";
import { priceFor } from "@/lib/charts/dental/billing-server";
import { variantOf } from "@/lib/charts/dental/pricing";

/*
  How a patient pays for a treatment: once for the whole of it, or for each
  visit (Yamen, 2026-10-12). Both prices come from the clinic's list — this
  only chooses which one this patient's treatment is charged by, so the doctor
  never types a price.

  The doctor at the chair or the reception at the desk may choose, until any
  of it is on an invoice that stands: after that, what was billed decides.
*/

const bodySchema = z.object({ unit: z.enum(["item", "session"]) });

type Params = { params: Promise<{ slug: string; id: string; markId: string }> };

export async function POST(req: Request, ctx: Params) {
  const { slug, id, markId } = await ctx.params;
  if (!isUuid(id) || !isUuid(markId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, ["patients.charts", "invoices"]);
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { unit } = parsed.data;

  const result = await inClinic(access, async (c) => {
    const cur = (
      await c.query(`select * from chart_marks where id = $1 and patient_id = $2 and clinic_id = $3 for update`, [markId, id, access.clinicId])
    ).rows[0];
    if (!cur) return { error: "not_found" as const };
    if (cur.voided_at || cur.kind !== "procedure" || cur.status === "existing") return { error: "not_chargeable" as const };
    // A tooth of a full arch is charged as the arch.
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

    const price = await priceFor(c, access.clinicId, cur.treatment_key, variantOf(cur.treatment_key, cur.detail ?? {}), unit);
    if (!price) return { error: "no_price" as const };
    await c.query(`update chart_marks set fee = $2, service_id = $3, fee_manual = false where id = $1`, [markId, price.price, price.serviceId]);
    // A line in the treatment's record; the chart's history leaves prices out.
    await c.query(`insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason) values ($1, $2, 'fee', $3, $4)`, [
      access.clinicId,
      markId,
      access.session.user.id,
      `${unit === "session" ? "per visit" : "whole treatment"} ${price.price}`,
    ]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "dental.mark.charge",
      entity: "patient",
      entityId: id,
      detail: { mark: markId, treatment: cur.treatment_key, unit, price: price.price },
    });
    const mark = (await c.query(`${MARK_SELECT} where m.id = $1`, [markId])).rows[0];
    return { mark: toMark(mark) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true, ...result });
}
