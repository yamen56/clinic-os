/**
 * Migration 0080 (one price for the whole treatment), rehearsed on fixtures.
 *
 * Runs the migration's SQL inside a transaction over rows made for it, checks
 * what became of each, and rolls everything back — so it can be run before
 * the migration is applied, or after, and leaves the database as it found it.
 *
 *   A  root canal priced only per visit (a stepped treatment) → retired; its
 *      unbilled treatment loses the price and waits for a whole one.
 *   B  crown priced both ways → the per-visit price retired; its unbilled
 *      treatment, typed by hand per visit, takes the whole price.
 *   C  orthodontic adjustment priced only per visit (one tap) → that price is
 *      its whole price now, named without "per visit"; its treatment keeps it.
 *   D  a root canal already billed per visit → left as it is.
 *
 * Usage: npx tsx scripts/qa-whole-price-migration.ts
 */
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
let passed = 0;
let failed = 0;
const check = (cond: unknown, m: string, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${m}`);
  } else {
    failed++;
    console.log(`  ✗ ${m}${detail ? ` — ${detail}` : ""}`);
  }
};

async function main() {
  const c = new Client({ connectionString: PG });
  await c.connect();
  const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
  const notices: string[] = [];
  c.on("notice", (n) => notices.push(n.message ?? ""));
  try {
    await q("begin");
    const [clinic] = await q(`select id from clinics order by created_at limit 1`);
    if (!clinic) throw new Error("no clinic in the local database");
    const [patient] = await q(
      `insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'QA 0080', '+962790080080', 'staff') returning id`,
      [clinic.id]
    );
    // A variant of its own keeps these rows clear of the clinic's real prices.
    const V = "qa0080";
    const svc = async (key: string, unit: string, price: number, name: string, nameAr: string, active = true) =>
      (
        await q(
          `insert into services (clinic_id, name, name_ar, duration_min, price, bookable_online, chart_key, chart_variant, price_unit, chart_owned, active)
           values ($1, $2, $3, 30, $4, false, $5, $6, $7, true, $8) returning id`,
          [clinic.id, name, nameAr, price, key, V, unit, active]
        )
      )[0].id as string;
    const A = await svc("rct", "session", 30, "Root canal treatment · per visit", "علاج عصب · لكل زيارة");
    const Bwhole = await svc("crown", "item", 100, "Crown", "تاج");
    const Bvisit = await svc("crown", "session", 40, "Crown · per visit", "تاج · لكل زيارة");
    const C = await svc("ortho_adjust", "session", 20, "Orthodontic adjustment · per visit", "شد التقويم · لكل زيارة");

    const mark = async (key: string, site: string, service: string, fee: number, manual = false) =>
      (
        await q(
          `insert into chart_marks (clinic_id, patient_id, site, treatment_key, label, label_ar, look, kind, status, detail, fee, fee_manual, service_id)
           values ($1, $2, $3, $4, $4, $4, 'dot', 'procedure', 'planned', '{}', $5, $6, $7) returning id`,
          [clinic.id, patient.id, site, key, fee, manual, service]
        )
      )[0].id as string;
    const mA = await mark("rct", "36", A, 30);
    const mB = await mark("crown", "16", Bvisit, 35, true);
    const mC = await mark("ortho_adjust", "mouth", C, 20);
    const mD = await mark("rct", "46", A, 30);
    // D is on an invoice that stands.
    const [inv] = await q(
      `insert into invoices (clinic_id, patient_id, seq, number, status, total, subtotal)
       values ($1, $2, (select coalesce(max(seq), 0) + 1000 from invoices where clinic_id = $1), 'QA-0080', 'sent', 60, 60) returning id`,
      [clinic.id, patient.id]
    );
    const [item] = await q(
      `insert into invoice_items (clinic_id, invoice_id, service_id, description, qty, unit_price, amount) values ($1, $2, $3, 'RCT', 2, 30, 60) returning id`,
      [clinic.id, inv.id, A]
    );
    await q(`insert into invoice_item_marks (invoice_item_id, mark_id, clinic_id) values ($1, $2, $3)`, [item.id, mD, clinic.id]);

    // The migration itself, as the runner applies it, inside this transaction.
    await q(readFileSync(join(process.cwd(), "migrations", "0080_whole_price_only.sql"), "utf8"));

    const service = async (id: string) => (await q(`select active, chart_key, price_unit, price::float as price, name, name_ar from services where id = $1`, [id]))[0];
    const markRow = async (id: string) => (await q(`select fee::float as fee, fee_manual, service_id from chart_marks where id = $1`, [id]))[0];
    const events = async (id: string) => (await q(`select reason from chart_mark_events where mark_id = $1 and action = 'fee'`, [id])).map((r) => r.reason as string);

    console.log("A — a root canal priced only per visit");
    const a = await service(A);
    check(a.active === false && a.chart_key === null, "its per-visit price is retired, off the list", JSON.stringify(a));
    const ma = await markRow(mA);
    check(ma.fee === null && ma.fee_manual === false, "its unbilled treatment loses the per-visit price, to wait for a whole one", JSON.stringify(ma));
    check((await events(mA)).some((r) => r.includes("no whole price")), "and its history says why");

    console.log("B — a crown priced both ways");
    const bv = await service(Bvisit);
    const bw = await service(Bwhole);
    check(bv.active === false && bv.chart_key === null && bw.active === true && bw.chart_key === "crown", "the per-visit price goes, the whole one stays");
    const mb = await markRow(mB);
    check(mb.fee === 100 && mb.service_id === Bwhole && mb.fee_manual === false, "the treatment typed per visit by hand takes the whole price, 100", JSON.stringify(mb));
    check((await events(mB)).some((r) => r.includes("whole price 100")), "and its history says so");

    console.log("C — an orthodontic adjustment priced only per visit");
    const cs = await service(C);
    check(
      cs.active === true && cs.price_unit === "item" && cs.price === 20 && cs.name === "Orthodontic adjustment" && cs.name_ar === "شد التقويم",
      "its price is its whole price now, named without 'per visit'",
      JSON.stringify(cs)
    );
    const mc = await markRow(mC);
    check(mc.fee === 20 && mc.service_id === C && (await events(mC)).length === 0, "and its treatment keeps it, untouched", JSON.stringify(mc));

    console.log("D — a root canal already billed per visit");
    const md = await markRow(mD);
    check(md.fee === 30 && md.service_id === A && (await events(mD)).length === 0, "it is left as billed", JSON.stringify(md));
    check(notices.some((n) => /0080: \d+ treatment\(s\) already billed per visit/.test(n)), "and the migration counts it", notices.join(" | "));
  } finally {
    await q("rollback").catch(() => {});
    await c.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
