import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { MARK_SELECT, toEvent, toMark } from "@/lib/charts/dental/db";
import { loadPrices } from "@/lib/charts/dental/billing-server";
import { pickPrice, variantOf } from "@/lib/charts/dental/pricing";

/*
  This patient's price for a treatment, set by hand.

  Yamen, 2026-10-15: "I choose the root canal treatment and it says $100. I
  don't want it to be $100 for this person, I want it to be $120." The price
  list stays as it is; only this patient's treatment changes, and its invoice
  line bills what was set. A price set by hand stays when the crown's type or
  the canal count changes, and goes back to the list's on "Use the list price"
  (fee: null).

  Charged per visit, the price set is each visit's. The doctor at the chair or
  the reception at the desk may set it, until any of it is on an invoice that
  stands: after that, the invoice decides.
*/

const bodySchema = z.object({ fee: z.number().min(0).max(1_000_000).nullable() });

type Params = { params: Promise<{ slug: string; id: string; markId: string }> };

export async function POST(req: Request, ctx: Params) {
  const { slug, id, markId } = await ctx.params;
  if (!isUuid(id) || !isUuid(markId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, ["patients.charts", "invoices"]);
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  // To the cent, as money is stored.
  const fee = parsed.data.fee === null ? null : Math.round(parsed.data.fee * 100) / 100;

  const result = await inClinic(access, async (c) => {
    const cur = (
      await c.query(`select * from chart_marks where id = $1 and patient_id = $2 and clinic_id = $3 for update`, [markId, id, access.clinicId])
    ).rows[0];
    if (!cur) return { error: "not_found" as const };
    if (cur.voided_at || cur.kind !== "procedure" || cur.status === "existing") return { error: "not_chargeable" as const };
    // A tooth of a full arch is priced as the arch.
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

    let reason: string;
    if (fee === null) {
      // Back to the list's price, charged the way it is charged now.
      const list = await loadPrices(c, access.clinicId, cur.treatment_key);
      const unit = list.find((p) => p.serviceId === cur.service_id)?.unit ?? null;
      const price = pickPrice(list, cur.treatment_key, variantOf(cur.treatment_key, cur.detail ?? {}), unit);
      await c.query(`update chart_marks set fee = $2, service_id = coalesce($3, service_id), fee_manual = false where id = $1`, [
        markId,
        price?.price ?? null,
        price?.serviceId ?? null,
      ]);
      reason = `list price ${price?.price ?? "none"}`;
    } else {
      // The service stays: it names the invoice line and says whether it is per visit.
      await c.query(`update chart_marks set fee = $2, fee_manual = true where id = $1`, [markId, fee]);
      reason = `set ${fee}${cur.fee == null ? "" : ` (was ${Number(cur.fee)})`}`;
    }
    const ev = (
      await c.query(`insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason) values ($1, $2, 'fee', $3, $4) returning id`, [
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
      action: "dental.mark.fee",
      entity: "patient",
      entityId: id,
      detail: { mark: markId, treatment: cur.treatment_key, fee, was: cur.fee == null ? null : Number(cur.fee) },
    });
    const mark = (await c.query(`${MARK_SELECT} where m.id = $1`, [markId])).rows[0];
    const event = (await c.query(`select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user where e.id = $1`, [ev.id]))
      .rows[0];
    return { mark: toMark(mark), event: toEvent(event) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true, ...result });
}
