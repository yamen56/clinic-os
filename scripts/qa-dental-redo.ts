/**
 * The dentist's second round of notes (2026-10-15), on the Dental chart tab:
 *
 * - a finding the work answered is drawn no more: caries under a composite
 *   filling goes, surface by surface, a lesion goes with the root canal — and
 *   is listed on its tooth as resolved, by what;
 * - a crown's type is chosen at its preparation, and prices it;
 * - this patient's price for a treatment can be set by hand, and the invoice
 *   bills it; "Use the list price" goes back;
 * - work done again (a redo): a crown remade twice, a root canal re-treated,
 *   a filling redone today — each pointing at the work it redoes;
 * - irrigation is no longer a step.
 *
 * The root canal's file sizes and correcting a recorded step are in
 * qa-treatment.ts, on its root canal.
 *
 * Run against a warm dev server (`npm run qa-warm` first).
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "dental-redo");

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

async function signIn(browser: Browser, email: string, viewport = { width: 1440, height: 1000 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page = await ctx.newPage();
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${BASE}/login`, { timeout: 180000 });
    await page.waitForLoadState("networkidle");
    if (!new URL(page.url()).pathname.includes("login")) return page;
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
      return page;
    } catch (e) {
      if (attempt >= 2) throw e;
      console.log(`  · sign-in for ${email} stalled; trying again`);
    }
  }
}

const chart = (p: Page) => p.locator("[data-dental-chart] svg[role='group']").first();
const panelOf = (p: Page) => p.locator("[data-dental-panel]").first();
const card = (p: Page) => p.locator("[data-procedure]");
async function openFile(p: Page, url: string) {
  await p.goto(url, { timeout: 120000 });
  await p.waitForSelector("[data-dental-chart] [data-tooth='16']", { timeout: 120000 });
  await p.waitForLoadState("networkidle");
}
async function putDown(p: Page) {
  for (let i = 0; i < 4 && (await p.locator("[role='dialog'][aria-modal='true']").count()); i++) {
    await p.keyboard.press("Escape");
    await p.waitForTimeout(250);
  }
}
async function tapTooth(p: Page, fdi: string) {
  await putDown(p);
  await chart(p).locator(`[data-tooth='${fdi}']`).first().click();
  await panelOf(p).waitFor({ timeout: 10000 });
}
/** A treatment's card, opened from its tooth. */
async function openOnTooth(p: Page, fdi: string, markId: string) {
  await tapTooth(p, fdi);
  await panelOf(p).locator(`[data-mark='${markId}'] [data-open-item]`).first().click();
  await p.locator(`[data-procedure='${markId}']`).waitFor({ timeout: 10000 });
}
const looksOf = async (p: Page, fdi: string) => (await chart(p).locator(`[data-tooth='${fdi}']`).first().getAttribute("data-looks")) ?? "";
async function until(fn: () => Promise<boolean>, ms = 15000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qaredo${tag}`;

  const [clinic] = await q(
    `insert into clinics (name, name_ar, slug, specialty, specialties, features, dental_billing_since)
     values ('QA Redo','إعادة',$1,'dental','{dental}','{"dental": true}', now() - interval '7 days') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const [user] = await q(`insert into users (email, password_hash, full_name, locale) values ($1,$2,'Dr. Rania Salem','en') returning id`, [
    `redo-doc-${tag}@test.local`,
    hash,
  ]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'doctor',true,'{"level":"full"}')`, [clinic.id, user.id]);
  const [patient] = await q(`insert into patients (clinic_id, full_name, birth_date, source) values ($1,'Sami Khoury','1984-02-10','staff') returning id`, [clinic.id]);
  // The list: a crown 100, zirconia 120, E-max 150; a root canal 100; a composite filling 40.
  for (const [key, variant, price, name] of [
    ["crown", null, 100, "Crown"],
    ["crown", "zirconia", 120, "Crown (Zirconia)"],
    ["crown", "emax", 150, "Crown (E-max)"],
    ["rct", null, 100, "Root canal treatment"],
    ["filling_composite", null, 40, "Composite filling"],
  ] as const) {
    await q(`insert into services (clinic_id, name, price, chart_key, chart_variant, chart_owned) values ($1,$2,$3,$4,$5,true)`, [clinic.id, name, price, key, variant]);
  }
  const fileUrl = `${BASE}/c/${slug}/patients/${patient.id}?tab=dental`;
  const api = `${BASE}/api/c/${slug}/patients/${patient.id}/dental`;
  const markOf = async (id: string) => (await q(`select *, fee::float as fee from chart_marks where id = $1`, [id]))[0];

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    const page = await signIn(browser, `redo-doc-${tag}@test.local`);
    page.on("pageerror", (e) => errors.push(e.message));
    await openFile(page, fileUrl);

    /** Entries recorded the way the chart records them. */
    const record = async (marks: { site: string; surfaces?: string[]; treatmentKey: string; status: "planned" | "done" | "existing"; detail?: Record<string, string> }[]) => {
      const body = { marks: marks.map((m) => ({ id: randomUUID(), eventId: randomUUID(), surfaces: [], detail: {}, ...m })) };
      const res = await page.request.post(`${api}/marks`, { data: body });
      if (!res.ok()) throw new Error(`record ${res.status()} ${await res.text()}`);
      return body.marks.map((m) => m.id);
    };

    /* ── A finding the work answered ─────────────────────────────────── */
    console.log("\nfindings the work answered");
    const [caries16] = await record([{ site: "16", surfaces: ["M", "O"], treatmentKey: "caries", status: "existing" }]);
    await record([{ site: "16", surfaces: ["O"], treatmentKey: "filling_composite", status: "done" }]);
    // An old filling, then caries found under it: the caries is new, nothing answered it.
    await record([{ site: "26", surfaces: ["O"], treatmentKey: "filling_composite", status: "existing" }]);
    await record([{ site: "26", surfaces: ["O"], treatmentKey: "caries_recurrent", status: "existing" }]);
    const [lesion46] = await record([{ site: "46", treatmentKey: "lesion", status: "existing" }]);
    const [rct46] = await record([{ site: "46", treatmentKey: "rct", status: "done", detail: { canals: "3" } }]);
    await openFile(page, fileUrl);
    check((await looksOf(page, "16")).includes("caries"), "caries on MO with a filling on O still shows: M is untreated", await looksOf(page, "16"));
    await tapTooth(page, "16");
    const panel = panelOf(page);
    check((await panel.locator(`[data-mark='${caries16}']`).first().innerText()).includes("O treated by Composite filling"), "its tooth says the O surface was treated, and by what");
    await record([{ site: "16", surfaces: ["M"], treatmentKey: "filling_composite", status: "done" }]);
    await openFile(page, fileUrl);
    check(!(await looksOf(page, "16")).includes("caries"), "a second filling on M: the caries is drawn no more", await looksOf(page, "16"));
    await tapTooth(page, "16");
    const resolved = panelOf(page).locator("[data-tooth-resolved]");
    check((await resolved.getAttribute("data-tooth-resolved")) === "1", "and is listed on the tooth as resolved");
    await resolved.locator("summary").click();
    check((await resolved.innerText()).includes("Resolved by Composite filling"), "by the filling that answered it");
    check((await panelOf(page).locator("[data-tooth-summary]").innerText()).includes("finding") === false, "the tooth's summary counts no open finding");
    await page.screenshot({ path: join(SHOTS, "resolved-caries.png") });
    check((await looksOf(page, "26")).includes("caries"), "caries found under an older filling is not answered by it");
    check(!(await looksOf(page, "46")).includes("lesion") && (await looksOf(page, "46")).includes("rct"), "a periapical lesion goes with the finished root canal");
    check(!!(await markOf(lesion46)) && !(await markOf(lesion46)).voided_at, "the finding stays in the record: nothing was voided");

    /* ── Irrigation, retired ─────────────────────────────────────────── */
    const [rctPlanned] = await record([{ site: "47", treatmentKey: "rct", status: "planned", detail: { canals: "2" } }]);
    const irr = await page.request.post(`${api}/marks/${rctPlanned}/steps`, { data: { id: randomUUID(), eventId: randomUUID(), step: "irrigation", data: {} } });
    check(irr.status() === 409, "irrigation can no longer be recorded as a step", String(irr.status()));

    /* ── A crown's type at its preparation, and this patient's price ─── */
    console.log("\na crown, its type and its price");
    await openFile(page, fileUrl);
    await tapTooth(page, "36");
    await panelOf(page).locator("[data-add-treatment]").click();
    const pane = panelOf(page).locator("[data-tooth-pane='add']");
    await pane.getByRole("radio", { name: "Planned" }).click();
    await pane.locator("input[type='search']").first().fill("crown");
    await pane.locator("[data-treatment='crown']").first().click();
    await card(page).waitFor({ timeout: 15000 });
    const crownId = (await card(page).getAttribute("data-procedure"))!;
    const prep = card(page).locator("[data-step-form='prep']");
    await prep.waitFor({ timeout: 10000 });
    check((await prep.locator("[data-step-detail='material']").innerText()).includes("Crown type"), "the preparation asks for the crown's type");
    check((await card(page).getByRole("button", { name: "Porcelain-fused-to-metal (PFM)" }).count()) === 1, "and the type is asked there only, not twice on the card");
    await prep.locator("[data-choice='material:emax']").click();
    await card(page).locator("[data-step-done='prep']").click();
    check(await until(async () => (await markOf(crownId)).detail.material === "emax"), "choosing E-max at the preparation makes the crown E-max");
    check(await until(async () => (await markOf(crownId)).fee === 150), "and prices it as E-max, 150", String((await markOf(crownId)).fee));
    check((await card(page).locator("[data-card-meta]").innerText()).includes("Crown type: E-max"), "the card says the crown's type");
    // Corrected: zirconia after all.
    await card(page).locator("[data-step-edit='prep']").click();
    await card(page).locator("[data-step-form='prep'] [data-choice='material:zirconia']").click();
    await card(page).locator("[data-step-save='prep']").click();
    check(await until(async () => (await markOf(crownId)).fee === 120 && (await markOf(crownId)).detail.material === "zirconia"), "correcting the preparation to zirconia re-prices it at 120");

    // This patient's price, by hand.
    const priceLine = card(page).locator(`[data-price-line='${crownId}']`);
    await priceLine.locator("[data-fee-edit]").click();
    await priceLine.locator("[data-fee-input]").fill("135");
    await priceLine.locator("[data-fee-save]").click();
    check(await until(async () => (await markOf(crownId)).fee === 135 && (await markOf(crownId)).fee_manual === true), "the doctor sets this patient's crown at 135");
    check(await until(async () => (await priceLine.locator("[data-fee-edited]").count()) === 1), "the price says it was set for this patient");
    check((await priceLine.locator("[data-fee-edited]").innerText()).includes("list"), "beside what the list says");
    check(
      (await q(`select price::float as price from services where clinic_id = $1 and chart_key = 'crown' and chart_variant = 'zirconia'`, [clinic.id]))[0].price === 120,
      "the price list is not touched"
    );
    await card(page).locator("[data-step-edit='prep']").click();
    await card(page).locator("[data-step-form='prep'] [data-choice='material:emax']").click();
    await card(page).locator("[data-step-save='prep']").click();
    check(await until(async () => (await markOf(crownId)).detail.material === "emax"), "the type changes again…");
    check((await markOf(crownId)).fee === 135, "…and the price set by hand stays");
    const lines = async () =>
      ((await (await page.request.get(`${api}/billable`)).json()) as { lines: { markId: string; unitPrice: number }[] }).lines;
    check(await until(async () => (await lines()).find((l) => l.markId === crownId)?.unitPrice === 135), "the invoice line bills 135", JSON.stringify(await lines()));
    await priceLine.locator("[data-fee-reset]").click();
    check(await until(async () => (await markOf(crownId)).fee === 150 && (await markOf(crownId)).fee_manual === false), "Use the list price goes back to the list's E-max, 150");
    await page.screenshot({ path: join(SHOTS, "crown-card.png") });

    /* ── Redo ────────────────────────────────────────────────────────── */
    console.log("\nwork done again");
    await card(page).locator("[data-finish-now]").click();
    await page.locator("[role='dialog'] button", { hasText: "Finish now" }).last().click();
    check(await until(async () => (await markOf(crownId)).status === "done"), "the crown is finished");
    await card(page).locator("[data-redo-item]").click();
    const sheet = page.locator("[data-redo-sheet]");
    await sheet.waitFor({ timeout: 10000 });
    check((await sheet.locator(`[data-redo-option='${crownId}']`).getAttribute("aria-checked")) === "true", "Redo on the crown's card chooses that crown");
    await sheet.locator("[data-redo-why]").fill("Crown cracked");
    await page.screenshot({ path: join(SHOTS, "redo-sheet.png") });
    await sheet.locator("[data-redo-start]").click();
    const redo1 = await until(async () => (await q(`select id from chart_marks where redo_of = $1`, [crownId])).length === 1);
    const [r1] = await q(`select *, fee::float as fee from chart_marks where redo_of = $1`, [crownId]);
    check(redo1 && r1.treatment_key === "crown" && r1.status === "planned" && r1.site === "36", "a redo is a new crown on 36, planned");
    check(r1?.detail?.material === "emax" && r1?.note === "Redo: Crown cracked", "of the same type, with what was wrong", JSON.stringify([r1?.detail, r1?.note]));
    check((await q(`select 1 from chart_mark_events where mark_id = $1 and action = 'redone'`, [crownId])).length === 1, "the old crown's history says it was taken up again");
    check((await markOf(crownId)).status === "done" && !(await markOf(crownId)).voided_at, "and the old crown stays as it was: done");
    await page.locator(`[data-procedure='${r1.id}']`).waitFor({ timeout: 10000 });
    check((await card(page).locator(`[data-redo-of='${crownId}']`).count()) === 1, "the redo opens at once, pointing at the crown it redoes");
    // Done again, and again.
    await card(page).locator("[data-finish-now]").click();
    await page.locator("[role='dialog'] button", { hasText: "Finish now" }).last().click();
    await until(async () => (await markOf(r1.id)).status === "done");
    await card(page).locator("[data-redo-item]").click();
    await page.locator("[data-redo-sheet] [data-redo-start]").click();
    check(await until(async () => (await q(`select 1 from chart_marks where redo_of = $1`, [r1.id])).length === 1), "a crown can be redone a second time");
    const [r2] = await q(`select id from chart_marks where redo_of = $1`, [r1.id]);
    await page.locator(`[data-procedure='${r2.id}']`).waitFor({ timeout: 10000 });
    check((await card(page).locator("[data-redo-links]").innerText()).includes("Redo 2"), "the second redo says so");
    await page.screenshot({ path: join(SHOTS, "redo-card.png") });

    // A root canal, from the tooth: done again as a retreatment.
    await tapTooth(page, "46");
    await panelOf(page).locator("[data-tooth-redo]").click();
    await page.locator("[data-redo-sheet]").waitFor({ timeout: 10000 });
    await page.locator(`[data-redo-sheet] [data-redo-option='${rct46}']`).click();
    check((await page.locator("[data-redo-sheet] [data-redo-as]").getAttribute("data-redo-as")) === "rct_retreat", "a root canal is redone as a retreatment");
    await page.locator("[data-redo-sheet] [data-redo-start]").click();
    check(
      await until(async () => (await q(`select treatment_key, status, detail from chart_marks where redo_of = $1`, [rct46]))[0]?.treatment_key === "rct_retreat"),
      "the retreatment is planned on 46, pointing at the root canal"
    );
    const [retreat] = await q(`select detail from chart_marks where redo_of = $1`, [rct46]);
    check(retreat?.detail?.canals === "3", "with its canals");

    // A filling, redone today.
    const [filling16] = (await q(`select id from chart_marks where site = '16' and treatment_key = 'filling_composite' and 'M' = any(surfaces) and patient_id = $1`, [patient.id])).map((r) => r.id);
    await tapTooth(page, "16");
    await panelOf(page).locator("[data-tooth-redo]").click();
    await page.locator(`[data-redo-sheet] [data-redo-option='${filling16}']`).click();
    await page.locator("[data-redo-sheet] [data-redo-now]").click();
    check(
      await until(async () => (await q(`select status, surfaces from chart_marks where redo_of = $1`, [filling16]))[0]?.status === "done"),
      "a filling with no steps can be redone today in one tap"
    );
    const [refill] = await q(`select surfaces from chart_marks where redo_of = $1`, [filling16]);
    check(refill?.surfaces?.join("") === "M", "on the same surface");

    // An emergency on a tooth with nothing under way keeps what brought them in.
    await tapTooth(page, "11");
    await panelOf(page).locator("[data-tooth-emergency]").click();
    const es = page.locator("[data-emergency-sheet]");
    await es.waitFor({ timeout: 10000 });
    await es.locator("[data-emergency-complaint]").fill("Knocked it on a door");
    await es.locator("[data-record-emergency]").click();
    check(
      await until(async () => ((await q(`select note from chart_marks where patient_id = $1 and site = '11' and treatment_key = 'emergency_exam'`, [patient.id]))[0]?.note ?? "").includes("Knocked it on a door")),
      "an emergency visit's complaint is kept with it"
    );

    /* ── On a phone and an upright iPad: nothing runs off the side ────── */
    console.log("\nsmall screens");
    for (const [name, viewport] of [
      ["phone", { width: 390, height: 844 }],
      ["ipad", { width: 820, height: 1180 }],
    ] as const) {
      const small = await signIn(browser, `redo-doc-${tag}@test.local`, viewport);
      small.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
      await openFile(small, fileUrl);
      const wide = async () => small.evaluate("document.documentElement.scrollWidth - window.innerWidth");
      // The root canal on 47, its shaping step open: a row of file chips per canal.
      await openOnTooth(small, "47", rctPlanned);
      await card(small).locator("[data-step='shaping'] button").first().click();
      const chips = card(small).locator("[data-step-form='shaping'] [data-canal-files]").first();
      await chips.waitFor({ timeout: 10000 });
      check((await chips.locator("[data-file-size]").count()) === 6, `${name}: the shaping step shows the six files on each canal`);
      const box = await chips.boundingBox();
      check(!!box && box.x >= 0 && box.x + box.width <= viewport.width, `${name}: the file chips stay on the screen`, JSON.stringify(box));
      await card(small).locator("[data-step-form='shaping']").screenshot({ path: join(SHOTS, `${name}-shaping.png`) });
      // The price editor open.
      await card(small).locator("[data-fee-edit]").first().click();
      await small.waitForTimeout(200);
      const form = await card(small).locator("[data-fee-form]").boundingBox();
      check(!!form && form.x >= 0 && form.x + form.width <= viewport.width + 1, `${name}: the price editor fits`, JSON.stringify(form));
      await card(small).locator("[data-price-line]").first().screenshot({ path: join(SHOTS, `${name}-price-edit.png`) });
      check(((await wide()) as number) <= 0, `${name}: the tooth window does not scroll sideways`, String(await wide()));
      // The redo sheet from the tooth.
      await putDown(small);
      await tapTooth(small, "16");
      await panelOf(small).locator("[data-tooth-redo]").click();
      await small.locator("[data-redo-sheet]").waitFor({ timeout: 10000 });
      await small.waitForTimeout(400);
      await small.screenshot({ path: join(SHOTS, `${name}-redo-sheet.png`) });
      check(((await wide()) as number) <= 0, `${name}: the redo sheet does not scroll sideways`);
      await small.context().close();
    }

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await q(`delete from clinics where id = $1`, [clinic.id]);
    await q(`delete from users where email like $1`, [`redo-%-${tag}@test.local`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed · screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
