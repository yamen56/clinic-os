import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { todaysVisit } from "@/lib/charts/dental/server";
import { toEvent } from "@/lib/charts/dental/db";
import { FACE_MARK_SELECT, loadFacePrices, toFaceMark } from "@/lib/charts/face/db";
import { pickFacePrice } from "@/lib/charts/face/catalog";
import { PACKAGE_KEY, loadPatientPackages, splitPrice } from "@/lib/charts/face/packages";

/*
  Selling a package to the patient: one of the clinic's plans, as it stands
  today, written down as theirs — its name, its price, when it runs out, and
  each item's share of the price.

  The sale is a face chart entry at the package's price, so reception bills
  it from Ready to bill like any other work, the patient pays it off over the
  visits like any other invoice, and voiding it before any session is used
  takes the package away. It names no doctor: the doctors earn per session
  done (earnings.ts), not the one who sold it.

  The desk sells as well as the doctor, so either capability will do.
*/

const bodySchema = z.object({
  /** The sale's chart entry, chosen by the browser like any other. */
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  planId: z.string().uuid(),
  note: z.string().max(2000).default(""),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, ["patients.charts", "invoices"], { module: "aesthetic" });
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;

  const result = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [id, access.clinicId]);
    if (!p.rowCount) return { error: "not_found" as const };
    const plan = (
      await c.query(
        `select p.id, p.name, p.name_ar, p.price::float as price, p.valid_months,
                ((now() at time zone cl.timezone)::date + make_interval(months => p.valid_months))::date::text as expires_on
           from package_plans p join clinics cl on cl.id = p.clinic_id
          where p.id = $1 and p.clinic_id = $2 and p.active`,
        [d.planId, access.clinicId]
      )
    ).rows[0];
    if (!plan) return { error: "invalid_plan" as const };
    const items = (await c.query(`select treatment_key, sessions from package_plan_items where plan_id = $1 order by sort`, [plan.id])).rows as {
      treatment_key: string;
      sessions: number;
    }[];
    if (!items.length) return { error: "invalid_plan" as const };

    const prices = await loadFacePrices(c, access.clinicId);
    const values = splitPrice(
      plan.price,
      items.map((i) => ({ treatmentKey: i.treatment_key, sessions: i.sessions })),
      (key) => pickFacePrice(prices, key, null)?.price ?? null
    );
    const visit = await todaysVisit(c, access.clinicId, id, null, null);
    await c.query(
      `insert into chart_marks (id, clinic_id, patient_id, chart, site, treatment_key, label, label_ar, look, kind, detail, status,
                                recorded_by, done_at, appointment_id, fee, note, areas, quantity)
       values ($1, $2, $3, 'aesthetic', 'face', $4, $5, $6, 'package', 'procedure', '{}', 'done', $7, now(), $8, $9, $10, '[]', 1)`,
      [d.id, access.clinicId, id, PACKAGE_KEY, plan.name, plan.name_ar || plan.name, access.session.user.id, visit, plan.price, d.note]
    );
    const pkg = (
      await c.query(
        `insert into patient_packages (clinic_id, patient_id, plan_id, name, name_ar, price, expires_on, sale_mark_id, sold_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [access.clinicId, id, plan.id, plan.name, plan.name_ar, plan.price, plan.valid_months ? plan.expires_on : null, d.id, access.session.user.id]
      )
    ).rows[0];
    for (const [i, it] of items.entries()) {
      await c.query(
        `insert into patient_package_items (clinic_id, patient_package_id, treatment_key, sessions, value, sort) values ($1, $2, $3, $4, $5, $6)`,
        [access.clinicId, pkg.id, it.treatment_key, it.sessions, values[i], i]
      );
    }
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
      action: "face.package.sell",
      entity: "patient",
      entityId: id,
      detail: { package: pkg.id, plan: plan.id, price: plan.price },
    });
    const mark = (await c.query(`${FACE_MARK_SELECT} where m.id = $1`, [d.id])).rows[0];
    const events = await c.query(`select e.*, u.full_name as by_name from chart_mark_events e left join users u on u.id = e.by_user where e.mark_id = $1`, [d.id]);
    const packages = await loadPatientPackages(c, access.clinicId, id);
    return { mark: toFaceMark(mark), events: events.rows.map(toEvent), package: packages.find((x) => x.id === pkg.id)! };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ ok: true, ...result });
}
