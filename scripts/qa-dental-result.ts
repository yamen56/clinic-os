/**
 * The dental chart drawn as rendered teeth, and the mouth after the plan.
 *
 * Yamen, 2026-11-03: "make the dental chart tooth look more realistic kind of
 * like the face chart" and "make the whole mouth treatment appear … like he
 * did those whole treatment in this time" — answered: the finished result.
 *
 * - The teeth and gum are the baked pictures (public/charts/teeth), every one
 *   of them served and decodable; work in a material is the tooth's picture
 *   in that material.
 * - See the result: every planned treatment drawn done — the filling where the
 *   caries was (and the caries gone), the extracted tooth gone, the implant in
 *   the gap, the crown on the root-filled tooth — with no planned outline
 *   left; the time bar says After the plan and how many; a tooth reads only;
 *   nothing is written; Back to today puts the chart back.
 * - The time bar reaches it too, one step past Today.
 *
 * Run against a warm server. Screenshots in scripts/qa-shots/dental-result/.
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "dental-result");

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

async function signIn(browser: Browser, email: string, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { timeout: 180000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
  return page;
}
const chart = (p: Page) => p.locator("[data-dental-chart] svg[role='group']").first();
const looksOf = async (p: Page, fdi: string) => (await chart(p).locator(`[data-tooth='${fdi}']`).first().getAttribute("data-looks")) ?? "";
const goneOf = async (p: Page, fdi: string) => (await chart(p).locator(`[data-tooth='${fdi}']`).first().getAttribute("data-gone")) === "true";
async function openFile(p: Page, url: string) {
  await p.goto(url, { timeout: 120000 });
  await p.waitForSelector("[data-dental-chart] [data-tooth='16']", { timeout: 120000 });
  await p.waitForLoadState("networkidle");
}
async function until(fn: () => Promise<boolean>, ms = 15000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
/** Outlines dashed the way planned work is (edge() in tooth-art: "3 2"). */
const plannedEdges = (p: Page) =>
  p.evaluate(`[...document.querySelectorAll("[data-dental-chart] svg[role='group'] [style*='stroke-dasharray']")].filter((e) => getComputedStyle(e).strokeDasharray.replace(/px/g, "").replace(/[ ,]+/g, " ").trim() === "3 2").length`) as Promise<number>;

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qaresult${tag}`;
  const [clinic] = await q(
    `insert into clinics (name, name_ar, slug, specialty, specialties, features) values ('QA Result','النتيجة',$1,'dental','{dental}','{"dental": true}') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const email = `result-doc-${tag}@test.local`;
  const [user] = await q(`insert into users (email, password_hash, full_name, locale) values ($1,$2,'Dr. Lina Haddad','en') returning id`, [email, hash]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'doctor',true,'{"level":"full"}')`, [clinic.id, user.id]);
  const [patient] = await q(`insert into patients (clinic_id, full_name, birth_date, source) values ($1,'Omar Nasser','1980-05-02','staff') returning id`, [clinic.id]);
  const fileUrl = `${BASE}/c/${slug}/patients/${patient.id}?tab=dental`;
  const api = `${BASE}/api/c/${slug}/patients/${patient.id}/dental`;
  const plannedInDb = async () => Number((await q(`select count(*) from chart_marks where patient_id = $1 and status = 'planned' and voided_at is null`, [patient.id]))[0].count);

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    const page = await signIn(browser, email, { width: 1440, height: 1000 });
    page.on("pageerror", (e) => errors.push(e.message));
    const record = async (marks: { site: string; surfaces?: string[]; treatmentKey: string; status: "planned" | "done" | "existing"; detail?: Record<string, string> }[]) => {
      const body = { marks: marks.map((m) => ({ id: randomUUID(), eventId: randomUUID(), surfaces: [], detail: {}, ...m })) };
      const res = await page.request.post(`${api}/marks`, { data: body });
      if (!res.ok()) throw new Error(`record ${res.status()} ${await res.text()}`);
    };
    // A mouth with history and a plan.
    await record([{ site: "16", surfaces: ["O", "M"], treatmentKey: "caries", status: "existing" }]);
    await record([{ site: "16", surfaces: ["O", "M"], treatmentKey: "filling_composite", status: "planned" }]);
    await record([{ site: "26", surfaces: ["O"], treatmentKey: "filling_amalgam", status: "existing" }]);
    await record([{ site: "25", treatmentKey: "crown", status: "existing", detail: { material: "gold" } }]);
    await record([{ site: "36", treatmentKey: "rct", status: "done", detail: { canals: "3" } }]);
    await record([{ site: "36", treatmentKey: "crown", status: "planned", detail: { material: "zirconia" } }]);
    await record([{ site: "46", treatmentKey: "missing", status: "existing" }]);
    await record([{ site: "46", treatmentKey: "implant", status: "planned" }]);
    await record([{ site: "18", treatmentKey: "extraction", status: "planned" }]);
    await record([{ site: "11", treatmentKey: "veneer", status: "planned", detail: { material: "porcelain" } }]);
    await record([{ site: "14", surfaces: ["O"], treatmentKey: "filling_composite", status: "done" }]);
    // The gum: what was found, and the cleaning and deep scaling planned for it.
    await record([{ site: "21", treatmentKey: "gingivitis", status: "existing" }]);
    await record([{ site: "22", treatmentKey: "bleeding_gums", status: "existing" }]);
    await record([{ site: "31", treatmentKey: "calculus", status: "existing" }]);
    await record([{ site: "17", treatmentKey: "pocket", status: "existing", detail: { depth: "6" } }]);
    await record([{ site: "mouth", treatmentKey: "scaling", status: "planned" }]);
    await record([{ site: "Q1", treatmentKey: "srp", status: "planned" }]);
    const plannedBefore = await plannedInDb();

    /* ── The teeth are the rendered pictures ─────────────────────────── */
    console.log("Rendered teeth");
    await openFile(page, fileUrl);
    const hrefs = (await chart(page).locator("image").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))) as string[];
    const unique = [...new Set(hrefs)];
    check(hrefs.length >= 64, "every tooth is drawn from its pictures — side, gum and chewing surface", String(hrefs.length));
    check(unique.some((h) => h.includes("/charts/teeth/side-l-m6.webp")) && unique.some((h) => h.includes("/charts/teeth/top-u-m6.webp")) && unique.some((h) => h.includes("/charts/teeth/gum-u.webp")), "a lower first molar, an upper one from above, the upper gum", unique.slice(0, 6).join(" "));
    const bad: string[] = [];
    for (const h of unique) {
      const r = await page.request.get(`${BASE}${h}`);
      if (!r.ok() || !(r.headers()["content-type"] ?? "").includes("image/webp")) bad.push(`${h} ${r.status()}`);
    }
    check(bad.length === 0, `all ${unique.length} pictures are served as images`, bad.join(", "));
    const decoded = (await page.evaluate(
      `Promise.all(${JSON.stringify(unique)}.map((h) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i.naturalWidth > 0); i.onerror = () => ok(false); i.src = h; })))`
    )) as boolean[];
    check(decoded.every(Boolean), "and every one decodes");
    const tinted = await chart(page).locator("[data-tooth='25'] image[filter*='tint-gold'], [data-tooth='26'] image[filter*='tint-amalgam']").count();
    check(tinted >= 2, "a gold crown and an amalgam filling are the tooth's picture in their material", String(tinted));
    await page.screenshot({ path: join(SHOTS, "today-desktop.png"), fullPage: false, clip: { x: 0, y: 0, width: 1440, height: 1000 } });

    /* ── After the plan ──────────────────────────────────────────────── */
    check((await looksOf(page, "16")).includes("caries") && !(await goneOf(page, "18")), "today: caries on 16, 18 still there to come out");
    check((await plannedEdges(page)) > 0, "and the planned work wears its dashed red outline");
    const see = page.locator("[data-see-result]");
    console.log("The gum");
    check((await looksOf(page, "21")).includes("inflamed"), "21: gingivitis is drawn on its gum", await looksOf(page, "21"));
    check((await looksOf(page, "22")).includes("bleeding"), "22: bleeding at the gum margin");
    check((await looksOf(page, "31")).includes("calculus"), "31: tartar at the neck");
    check((await looksOf(page, "17")).includes("pocket"), "17: the pocket beside the root");
    check(((await chart(page).locator("[data-tooth='17'] text").evaluateAll((els) => els.map((e) => e.textContent ?? ""))) as string[]).some((x) => x.trim() === "6"), "with its depth, 6");
    check((await looksOf(page, "11")).includes("perio") && (await looksOf(page, "26")).includes("perio"), "the cleaning planned for the mouth is on every tooth's gum");
    check((await looksOf(page, "17")).split(" ").filter((l) => l === "perio").length === 2, "and 17, in Q1, also carries the deep scaling planned there");
    console.log("After the plan");
    check(await see.isVisible(), "See the result is offered beside the time bar");
    await see.click();
    const viewing = page.locator("[data-viewing]");
    check(await until(async () => (await viewing.getAttribute("data-viewing")) === "after-plan"), "the bar now says After the plan");
    check((await page.locator("[data-after-plan]").getAttribute("data-after-plan")) === String(plannedBefore), `counting the ${plannedBefore} planned treatments`, (await page.locator("[data-after-plan]").innerText().catch(() => "")) as string);
    check((await page.locator("[data-after-plan]").innerText()).includes("Nothing is changed"), "and saying nothing is changed");
    const l16 = await looksOf(page, "16");
    check(!l16.includes("caries") && l16.includes("filling"), "16: the filling is in, the caries it treats is gone", l16);
    check(await goneOf(page, "18"), "18: out");
    check((await looksOf(page, "46")).includes("implant"), "46: the implant stands in the gap");
    check((await looksOf(page, "36")).includes("crown"), "36: crowned over its root canal");
    check((await looksOf(page, "11")).includes("veneer"), "11: veneered");
    check(
      !(await looksOf(page, "21")).includes("inflamed") && !(await looksOf(page, "22")).includes("bleeding") && !(await looksOf(page, "31")).includes("calculus"),
      "the cleaning takes the gingivitis, the bleeding and the tartar"
    );
    check(!(await looksOf(page, "17")).includes("pocket"), "the deep scaling takes the pocket");
    check(!(await looksOf(page, "26")).includes("perio") && (await looksOf(page, "17")).includes("perio"), "a finished cleaning leaves no mark; the deep scaling stays on Q1's gum, done");
    check((await plannedEdges(page)) === 0, "no planned outline is left anywhere", String(await plannedEdges(page)));
    await page.screenshot({ path: join(SHOTS, "after-plan-desktop.png"), fullPage: false, clip: { x: 0, y: 0, width: 1440, height: 1000 } });
    // A tooth opened here reads only: its panel offers nothing to record.
    await chart(page).locator("[data-tooth='36']").first().click();
    await page.locator("[data-dental-panel]").first().waitFor({ timeout: 10000 });
    check((await page.locator("[data-dental-panel] [data-add-treatment]").count()) === 0, "a tooth opened here offers nothing to record");
    for (let i = 0; i < 3 && (await page.locator("[role='dialog'][aria-modal='true']").count()); i++) await page.keyboard.press("Escape");
    check((await plannedInDb()) === plannedBefore, "nothing was written: the plan is still the plan");

    await page.getByRole("button", { name: "Back to today" }).first().click();
    check(await until(async () => (await viewing.getAttribute("data-viewing")) === "today"), "Back to today puts the chart back");
    check((await looksOf(page, "16")).includes("caries") && !(await goneOf(page, "18")), "with the caries and the tooth to come out");
    await chart(page).locator("[data-tooth='36']").first().click();
    await page.locator("[data-dental-panel]").first().waitFor({ timeout: 10000 });
    check((await page.locator("[data-dental-panel] [data-add-treatment]").count()) > 0, "and today the same tooth offers Add treatment again");
    for (let i = 0; i < 3 && (await page.locator("[role='dialog'][aria-modal='true']").count()); i++) await page.keyboard.press("Escape");

    // The time bar reaches it too: one step past Today.
    const range = page.locator("[data-time-bar] input[type='range']");
    await range.focus();
    await page.keyboard.press("End");
    check(await until(async () => (await viewing.getAttribute("data-viewing")) === "after-plan"), "the bar's last step is After the plan");
    await page.keyboard.press("ArrowLeft");
    check(await until(async () => (await viewing.getAttribute("data-viewing")) === "today"), "one step back is Today");

    /* ── On a phone ──────────────────────────────────────────────────── */
    console.log("On a phone");
    const phone = await signIn(browser, email, { width: 390, height: 844 });
    phone.on("pageerror", (e) => errors.push(e.message));
    await openFile(phone, fileUrl);
    await phone.screenshot({ path: join(SHOTS, "today-phone.png") });
    const seePhone = phone.locator("[data-see-result]");
    await seePhone.scrollIntoViewIfNeeded();
    const box = await seePhone.boundingBox();
    check(!!box && box.height >= 36, "See the result is a real target on a phone", JSON.stringify(box));
    await seePhone.click();
    check(await until(async () => (await phone.locator("[data-viewing]").getAttribute("data-viewing")) === "after-plan"), "and shows the result there too");
    const overflow = (await phone.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) as number;
    check(overflow <= 0, "with no sideways scroll", String(overflow));
    await phone.locator("[data-dental-chart]").first().scrollIntoViewIfNeeded();
    await phone.screenshot({ path: join(SHOTS, "after-plan-phone.png") });

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed · screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
