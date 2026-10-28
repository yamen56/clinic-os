import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { toEvent } from "@/lib/charts/dental/db";
import { loadBilled } from "@/lib/charts/dental/billing-server";
import { FACE_MARK_SELECT, loadFacePrices, toFaceMark } from "@/lib/charts/face/db";
import { FACE_TREATMENT_BY_KEY, feeOf, pickFacePrice } from "@/lib/charts/face/catalog";
import { dropStock, returnStock } from "@/lib/charts/face/stock";
import { PACKAGE_KEY } from "@/lib/charts/face/packages";

/*
  Changing a treatment on the face chart. Each change is its own line in the
  treatment's history, written in the same transaction; a voided treatment
  takes no further change and stays, with who voided it and why.

  The price is the one change reception may make too (`invoices`), as on the
  dental chart: this patient's price set by hand, or back to the list's —
  until it is billed.

  Voided, a treatment gives its product back to the batches it came from,
  and a package session back to its package. A package itself is voided only
  while none of its sessions is used.
*/

const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("void"), eventId: z.string().uuid(), reason: z.string().trim().max(300).optional() }),
  z.object({ op: z.literal("note"), eventId: z.string().uuid(), note: z.string().max(2000) }),
  z.object({ op: z.literal("performer"), eventId: z.string().uuid(), performerId: z.string().uuid() }),
  z.object({ op: z.literal("fee"), eventId: z.string().uuid(), fee: z.number().min(0).max(1_000_000).nullable() }),
]);

type Params = { params: Promise<{ slug: string; id: string; markId: string }> };

export async function PATCH(req: Request, ctx: Params) {
  const { slug, id, markId } = await ctx.params;
  if (!isUuid(id) || !isUuid(markId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, ["patients.charts", "invoices"], { module: "aesthetic" });
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;
  if (b.op !== "fee" && !can(access, "patients.charts")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const me = access.session.user.id;

  const result = await inClinic(access, async (c) => {
    const cur = (
      await c.query(`select * from chart_marks where id = $1 and patient_id = $2 and clinic_id = $3 and chart = 'aesthetic' for update`, [
        markId,
        id,
        access.clinicId,
      ])
    ).rows[0];
    if (!cur) return { error: "not_found" as const };
    if (cur.voided_at) return { error: "voided" as const };

    // Sessions taken from a package this entry sold.
    const sessionsUsed =
      cur.treatment_key === PACKAGE_KEY
        ? Number(
            (
              await c.query(
                `select count(*)::int as n from chart_marks s join patient_package_items i on i.id = s.package_item_id
                   join patient_packages pp on pp.id = i.patient_package_id
                  where pp.sale_mark_id = $1 and s.voided_at is null`,
                [markId]
              )
            ).rows[0].n
          )
        : 0;

    let reason: string | null = null;
    switch (b.op) {
      case "void":
        if (sessionsUsed > 0) return { error: "package_used" as const };
        await returnStock(c, access.clinicId, markId, me);
        await c.query(`update chart_marks set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1`, [markId, me, b.reason || null]);
        reason = b.reason || null;
        break;
      case "note":
        await c.query(`update chart_marks set note = $2 where id = $1`, [markId, b.note]);
        break;
      case "performer": {
        const ok = await c.query(`select 1 from clinic_members where id = $1 and clinic_id = $2`, [b.performerId, access.clinicId]);
        if (!ok.rowCount) return { error: "invalid_performer" as const };
        await c.query(`update chart_marks set performed_by = $2 where id = $1`, [markId, b.performerId]);
        // A package session earns its new doctor, at their deal.
        if (cur.package_item_id) {
          await c.query(
            `update chart_marks m set commission_percent = cm.commission_percent, costs_rule = cm.costs_rule
               from clinic_members cm where m.id = $1 and cm.id = $2`,
            [markId, b.performerId]
          );
        }
        break;
      }
      case "fee": {
        // A session from a package was paid for in the package.
        if (cur.package_item_id) return { error: "package" as const };
        // Once on an invoice that stands, the invoice is the price.
        if ((await loadBilled(c, access.clinicId, [markId])).some((x) => x.qty > 0)) return { error: "billed" as const };
        if (b.fee === null) {
          const t = FACE_TREATMENT_BY_KEY.get(cur.treatment_key);
          const used = (await c.query(`select product_id from chart_mark_products where mark_id = $1 limit 1`, [markId])).rows[0]?.product_id ?? null;
          const price = t ? pickFacePrice(await loadFacePrices(c, access.clinicId, t.key), t.key, used) : null;
          const fee = feeOf(price?.price ?? null, Number(cur.quantity ?? 1));
          await c.query(`update chart_marks set fee = $2, fee_manual = false, service_id = coalesce($3, service_id) where id = $1`, [
            markId,
            fee,
            price?.serviceId ?? null,
          ]);
          reason = fee == null ? null : String(fee);
        } else {
          await c.query(`update chart_marks set fee = $2, fee_manual = true where id = $1`, [markId, b.fee]);
          reason = String(b.fee);
        }
        break;
      }
    }
    await c.query(`insert into chart_mark_events (id, clinic_id, mark_id, action, by_user, reason) values ($1, $2, $3, $4, $5, $6)`, [
      b.eventId,
      access.clinicId,
      markId,
      b.op,
      me,
      reason,
    ]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: me,
      impersonatedBy: access.session.impersonatedBy,
      action: `face.mark.${b.op}`,
      entity: "patient",
      entityId: id,
      detail: { mark: markId, treatment: cur.treatment_key, ...(b.op === "fee" ? { fee: b.fee } : {}) },
    });
    const mark = (await c.query(`${FACE_MARK_SELECT} where m.id = $1`, [markId])).rows[0];
    const ev = (await c.query(`select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user where e.id = $1`, [b.eventId])).rows[0];
    return { mark: toFaceMark(mark), event: toEvent(ev) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true, ...result });
}

/*
  Undo: a mis-tap taken back. Only by the person who recorded it, within two
  minutes, while nothing else has happened to it and it is on no invoice —
  after that it is a clinical record, and leaves the chart by being voided.
*/
export async function DELETE(_req: Request, ctx: Params) {
  const { slug, id, markId } = await ctx.params;
  if (!isUuid(id) || !isUuid(markId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts", { module: "aesthetic" });
  if (!g.ok) return g.res;
  const access = g.access;

  const result = await inClinic(access, async (c) => {
    const cur = (
      await c.query(
        `select m.treatment_key,
                (select count(*)::int from chart_mark_events e where e.mark_id = m.id and e.action <> 'created') as changes,
                exists (select 1 from invoice_item_marks iim where iim.mark_id = m.id) as billed,
                -- A package sold a moment ago whose first session is already recorded is no mis-tap.
                exists (select 1 from patient_packages pp join patient_package_items i on i.patient_package_id = pp.id
                          join chart_marks s on s.package_item_id = i.id where pp.sale_mark_id = m.id) as used
           from chart_marks m
          where m.id = $1 and m.patient_id = $2 and m.clinic_id = $3 and m.chart = 'aesthetic'
            and m.recorded_by = $4 and m.created_at > now() - interval '2 minutes'`,
        [markId, id, access.clinicId, access.session.user.id]
      )
    ).rows[0];
    if (!cur || cur.changes > 0 || cur.billed || cur.used) return { error: "too_late" as const };
    await dropStock(c, access.clinicId, markId);
    await c.query(`delete from chart_marks where id = $1`, [markId]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "face.mark.undo",
      entity: "patient",
      entityId: id,
      detail: { mark: markId, treatment: cur.treatment_key },
    });
    return { ok: true as const };
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
