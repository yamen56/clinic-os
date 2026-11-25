/**
 * Full arches placed by hand, bridges, and their work at the lab (0117).
 *
 * A dentist, 2026-11-25: an implant of a full arch is not at a tooth — it sits
 * a little right or left and leans; after implants a bridge as well as a
 * crown; the bridge with its full steps, working with the dental labs; and all
 * of it drawn as it looks, not as lines.
 *
 * - The studio: All-on-4 opens in the usual places, the back two leaning
 *   thirty degrees; an implant is dragged along the jaw, turned by its tip,
 *   sunk, nudged by its buttons, added and taken off; never past a neighbour.
 *   Splitting the bridge, its material, its reach.
 * - Saved: each implant where it was put, its tooth the nearest one free; the
 *   chart draws the arch as one piece and the implants where they are.
 *   Adjust implants moves them later, with a line in the history; the server
 *   clamps what it is sent and refuses what is not its own.
 * - Arches recorded before places existed still draw, at their teeth.
 * - A bridge: proposed across the gap, corrected, recorded as one; drawn as
 *   one piece; on implants once its supports are; priced by the tooth.
 * - Its steps, and the lab among them: one order, several trips, per tooth.
 *   A bridge already under way is not asked for its impression again.
 * - Lab work names the teeth and what is being made.
 *
 * Desktop, and a phone with a finger. Run against a warm dev server.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultPlaces, placeDetail, sitesFor, boundedPos, snapTilt, whereText, nextPlace, clampPlace, teethAt, leanOf } from "../src/lib/charts/dental/implant-place";
import { cutsDetail, cutsOf, prostheses, stagesOf } from "../src/lib/charts/dental/prosthesis";
import { progressOf, type StepRecord } from "../src/lib/charts/dental/protocols";
import { LAB_TRIPS, labCostFor, nextAnchor, stagesFor, tripAnchors, tripsOf, type LabCase } from "../src/lib/charts/dental/labs";
import { suggestSpan, bridgeKey } from "../src/lib/charts/dental/bridge";
import { toothStates, type Mark } from "../src/lib/charts/dental/state";
import { BUILT_IN_BY_KEY } from "../src/lib/charts/dental/catalog";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "dental-prosthetics");
const ONLY = process.env.ONLY?.split(",") ?? null;
const run = (part: string) => !ONLY || ONLY.includes(part);

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
// Long enough for a route a cold dev server compiles on its first request — half a minute when the machine is short of memory.
async function until(fn: () => Promise<boolean>, ms = 60000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function signIn(browser: Browser, email: string, opts: { phone?: boolean; locale?: string } = {}): Promise<Page> {
  const ctx: BrowserContext = await browser.newContext(
    opts.phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }
  );
  await ctx.addCookies([{ name: "cos_locale", value: opts.locale ?? "en", url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { timeout: 180000 });
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
  return page;
}

const chart = (p: Page) => p.locator("[data-dental-chart] svg[role='group']").first();
const panelOf = (p: Page) => p.locator("[data-dental-panel]").first();
const studioOf = (p: Page) => p.locator("[data-full-arch='implant_denture']");
async function openFile(page: Page, url: string) {
  await page.goto(url, { timeout: 120000 });
  await page.waitForSelector("[data-dental-chart] [data-tooth='16'], [data-dental-chart] [data-tooth='26']", { timeout: 120000 });
  await page.waitForTimeout(500);
}
async function tapTooth(page: Page, fdi: string) {
  await chart(page).locator(`[data-tooth='${fdi}']`).first().click();
  await panelOf(page).waitFor({ timeout: 10000 });
}
async function addIn(p: Page, key: string, query: string, status?: "Planned" | "Done" | "Existing") {
  const panel = panelOf(p);
  await panel.locator("[data-add-treatment]").click();
  const pane = panel.locator("[data-tooth-pane='add']");
  if (status) await pane.getByRole("radio", { name: status }).click();
  await pane.locator("input[type='search']").first().fill(query);
  await pane.locator(`[data-treatment='${key}']`).first().click();
}
async function putDown(p: Page) {
  for (let i = 0; i < 5 && (await p.locator("[role='dialog'][aria-modal='true']").count()); i++) {
    await p.keyboard.press("Escape");
    await p.waitForTimeout(250);
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  /* ── The rules, on their own ───────────────────────────────────────────── */
  if (run("rules")) {
    console.log("Where implants are");
    const four = defaultPlaces("upper", 4);
    check(sitesFor("upper", four).join(",") === "15,12,22,25", "All-on-4 stands at 15, 12, 22 and 25", sitesFor("upper", four).join(","));
    check(sitesFor("lower", defaultPlaces("lower", 4)).join(",") === "45,42,32,35", "and at 45, 42, 32 and 35 below");
    check(four[0].tilt === 30 && four[3].tilt === -30 && four[1].tilt === 0, "the back two lean thirty degrees, their tips toward the midline", JSON.stringify(four));
    check(leanOf(four[0].pos, four[0].tilt) === "midline" && leanOf(four[3].pos, four[3].tilt) === "midline" && leanOf(2, -20) === "back", "a lean is said by where the tip goes, on either side");
    check(sitesFor("upper", [{ ...four[0], pos: 3 }, { ...four[0], pos: 3.4 }]).join(",") === "15,14", "two implants by one tooth are given two teeth, the nearest keeping its own");
    check(whereText("upper", 3.1) === "15" && whereText("upper", 3.5) === "15–14" && whereText("upper", 7.5) === "11–21", "an implant is at a tooth, or between two", `${whereText("upper", 3.5)} ${whereText("upper", 7.5)}`);
    check(teethAt("lower", 0).join() === "48" && teethAt("lower", 15).join() === "38", "the ends of the jaw are its wisdom teeth");
    const two = [{ ...four[0], pos: 3 }, { ...four[0], pos: 5 }];
    check(boundedPos(two, 0, 9) === 4.4 && boundedPos(two, 1, 1) === 3.6 && boundedPos(two, 0, -4) === 0, "an implant goes as far as its neighbour and no further, and never off the jaw", `${boundedPos(two, 0, 9)}`);
    check(snapTilt(29) === 30 && snapTilt(-16) === -17 && snapTilt(1.4) === 0 && snapTilt(23) === 23, "a tilt settles on the angle an abutment is made at, and can be pulled past it");
    const wild = clampPlace({ pos: 99, tilt: 400, depth: -50, len: 2, dia: 40 });
    check(wild.pos === 15 && wild.tilt === 60 && wild.depth === -2 && wild.len === 6 && wild.dia === 6, "a place off the jaw is brought back onto it", JSON.stringify(wild));
    check((nextPlace(four)?.pos ?? 0) === 4.5 && nextPlace(Array.from({ length: 10 }, (_, i) => ({ ...four[0], pos: i * 1.5 }))) === null, "another goes in the widest gap, until there are ten");
    check(JSON.stringify([...cutsOf({ cuts: cutsDetail([4, 7, 12]) })]) === "[4,7,12]" && cutsOf({}).size === 0, "where a bridge is split is kept and read back");

    console.log("A bridge proposed");
    let n = 0;
    const mk = (site: string, key: string, status: Mark["status"], extra: Partial<Mark> = {}): Mark => {
      const tr = BUILT_IN_BY_KEY.get(key)!;
      n++;
      return {
        id: `m${n}`, site, surfaces: [], treatmentKey: key, label: tr.en, labelAr: tr.ar, look: tr.look, kind: tr.kind, detail: {}, status,
        performedBy: null, recordedBy: { id: "u", name: "" }, createdAt: new Date(1e12 + n).toISOString(), doneAt: status === "done" ? new Date(1e12 + n).toISOString() : null,
        voidedAt: null, voidedBy: null, voidReason: null, note: "", emergency: false, startedAt: null, appointmentId: null, fee: null, feeManual: false, serviceId: null, redoOf: null, ...extra,
      };
    };
    const st = (marks: Mark[]) => toothStates(marks, null);
    const span = (seed: string[], marks: Mark[]) => suggestSpan(seed, st(marks)).map((x) => `${x.site}${x.role === "pontic" ? "p" : "a"}`).join(",");
    const gap = [mk("15", "missing", "existing")];
    check(span(["15"], gap) === "16a,15p,14a", "from the missing tooth: it and a support either side", span(["15"], gap));
    check(span(["14"], gap) === "16a,15p,14a" || span(["14"], gap) === "14a,15p,16a", "from a tooth beside the gap: the same bridge", span(["14"], gap));
    const wide = ["35", "36"].map((f) => mk(f, "missing", "existing"));
    check(span(["36"], wide) === "34a,35p,36p,37a", "two missing: both, and a support either side", span(["36"], wide));
    const imps = [...["24", "25", "26"].map((f) => mk(f, "missing", "existing")), mk("24", "implant", "done"), mk("26", "implant", "done")];
    check(span(["24"], imps) === "24a,25p,26a" && bridgeKey(suggestSpan(["24"], st(imps)), st(imps)) === "implant_bridge", "from an implant: to the next implant, and a bridge on implants", span(["24"], imps));
    check(bridgeKey(suggestSpan(["15"], st(gap)), st(gap)) === "bridge", "on teeth it is a bridge on teeth");
    const ex = [mk("46", "extraction", "planned")];
    check(span(["46"], ex) === "47a,46p,45a", "a tooth about to come out is one the bridge replaces", span(["46"], ex));
    check(span(["12", "14"], []) === "14a,13a,12a", "two teeth in hand: from the one to the other", span(["12", "14"], []));

    console.log("Pieces");
    const bridgeMarks = [mk("16", "bridge", "planned", { groupId: "g", role: "abutment" }), mk("15", "bridge", "planned", { groupId: "g", role: "pontic" }), mk("14", "bridge", "planned", { groupId: "g", role: "abutment" })];
    const rec = (markId: string, step: string, data: Record<string, unknown> = {}): StepRecord => ({ id: `s${n++}`, markId, step, data, note: "", performedBy: null, recordedBy: { id: "u", name: "" }, appointmentId: null, doneAt: new Date(2e12).toISOString(), voidedAt: null, voidedBy: null, voidReason: null });
    const one = prostheses(bridgeMarks, null);
    check(one.pieces.length === 1 && one.pieces[0].units.length === 3 && one.pieces[0].kind === "bridge" && !one.pieces[0].base, "a bridge is one piece of three");
    const prepped = stagesOf(bridgeMarks, [rec(bridgeMarks[0].id, "prep")], null);
    check(bridgeMarks.every((m) => prepped.get(m.id) === "prep"), "its preparation is the whole bridge's");
    check(stagesOf(bridgeMarks, [rec(bridgeMarks[0].id, "prep"), rec(bridgeMarks[0].id, "temp")], null).get(bridgeMarks[2].id) === "temp", "and a temporary is too");
    const arch = [
      mk("upper", "implant_denture", "done", { groupId: "a", detail: { implants: "4", kind: "fixed", cuts: cutsDetail([7]) } }),
      ...four.map((p, i) => mk(sitesFor("upper", four)[i], "implant", "done", { groupId: "a", role: "abutment", detail: placeDetail(p) })),
      ...["13", "12", "11", "21", "22", "23"].map((f) => mk(f, "implant_denture", "done", { groupId: "a", role: "pontic" })),
    ];
    const w = prostheses(arch, null);
    check(w.pieces.length === 2 && w.pieces[0].units.length === 3 && w.pieces[0].seams.right && w.pieces[1].seams.left && w.implants.length === 4, "an arch split at the midline is two pieces that meet there, on its four implants");
    const old = [mk("lower", "implant_denture", "done", { groupId: "o", detail: { implants: "4" } }), ...["45", "42", "32", "35"].map((f) => mk(f, "implant", "done", { groupId: "o", role: "abutment" })), ...["41", "31"].map((f) => mk(f, "implant_denture", "done", { groupId: "o", role: "pontic" }))];
    const ow = prostheses(old, null);
    check(ow.implants.map((i) => i.place.pos).join() === "3,6,9,12" && ow.implants.every((i) => i.place.tilt === 0) && ow.pieces[0].kind === "arch", "an arch recorded before places existed stands at its teeth, fixed on four", ow.implants.map((i) => i.place.pos).join());

    console.log("Steps and trips");
    const before = progressOf("bridge", [rec("x", "prep", { impression: "digital", shade: "A2" })])!;
    check(before.implied.has("impression") && before.requiredDone === 2 && before.next?.key === "temp", "a bridge prepared when the impression was part of it has its impression", `${before.next?.key}`);
    const now = progressOf("bridge", [rec("x", "prep", { margin: "chamfer" })])!;
    check(!now.implied.size && now.requiredDone === 1 && now.next?.key === "impression" && now.required === 3, "one prepared now is asked for it next", `${now.next?.key}`);
    const c = (over: Partial<LabCase>): LabCase => ({ id: "c", markId: "m", labId: "l", cost: 135, status: "sent", sentOn: "2026-11-25", dueOn: null, receivedAt: null, shade: "", note: "", paid: false, createdAt: "", stage: "framework", units: 3, spec: {}, trips: [], ...over });
    check(nextAnchor("bridge", c({})) === null && nextAnchor("bridge", c({ status: "received", receivedAt: "2026-11-26" })) === "framework", "a framework goes again from its try-in, once it is back");
    check(nextAnchor("bridge", c({ status: "received", stage: "finish", receivedAt: "x" })) === null, "a finished piece does not");
    const trips = tripsOf(c({ stage: "finish", trips: [{ stage: "framework", sentOn: "a", dueOn: null, receivedAt: "b" }, { stage: "bisque", sentOn: "c", dueOn: null, receivedAt: "d" }] }));
    check(tripAnchors("bridge", trips).join() === "impression,framework,tryin", "three trips stand after the impression, the framework and the porcelain", tripAnchors("bridge", trips).join());
    check(stagesFor("crown").join() === "finish" && stagesFor("bridge", "tryin").join() === "finish" && LAB_TRIPS.implant_bridge.length === 3, "a crown goes once; a bridge on implants goes like a bridge");
    const prices = [{ labId: "l", chartKey: "bridge", variant: null, cost: 45 }, { labId: "l", chartKey: "crown", variant: null, cost: 45 }];
    check(labCostFor(prices, "l", "bridge", null, 3) === 135 && labCostFor(prices, "l", "crown", null, 3) === 45, "a lab's bridge is priced by the tooth, its crown is not");
  }

  if (ONLY && !ONLY.some((x) => x !== "rules")) return finish();

  /* ── The app ───────────────────────────────────────────────────────────── */
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qaprosth${tag}`;
  const [clinic] = await q(
    `insert into clinics (name, slug, specialty, specialties, features, dental_billing_since)
     values ('QA Prosthetics', $1, 'dental', '{dental}', '{"dental": true}', now() - interval '7 days') returning id`,
    [slug]
  );
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  await q(`select seed_expense_categories($1)`, [clinic.id]);
  const [docUser] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'Sami Haddad', 'en') returning id`, [`prosth-doc-${tag}@test.local`, hash]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions) values ($1, $2, 'doctor', true, 'Dr.', '{"level":"full"}')`, [clinic.id, docUser.id]);
  const [arUser] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'ليان حداد', 'ar') returning id`, [`prosth-ar-${tag}@test.local`, hash]);
  await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions) values ($1, $2, 'doctor', false, 'د.', '{"level":"full"}')`, [clinic.id, arUser.id]);
  const patient = async (name: string) =>
    (await q(`insert into patients (clinic_id, full_name, birth_date, phone_e164, source) values ($1, $2, '1970-03-01', $3, 'staff') returning id`, [clinic.id, name, `+96279${Math.floor(1e6 + Math.random() * 8e6)}`]))[0].id as string;
  const p1 = await patient("Arch Patient");
  const p2 = await patient("Bridge Patient");
  const p3 = await patient("Implant Bridge Patient");
  const p4 = await patient("Old Work Patient");
  const p5 = await patient("Phone Patient");
  // A bridge at 200 a tooth, one on implants at 350; a lab that charges 45 and 80 a tooth.
  const svc = async (key: string, price: number) =>
    q(`insert into services (clinic_id, name, duration_min, price, chart_key, chart_variant, price_unit, chart_owned, bookable_online) values ($1, $2, 30, $3, $2, null, 'item', true, false)`, [clinic.id, key, price]);
  await svc("bridge", 200);
  await svc("implant_bridge", 350);
  await svc("implant_denture", 4000);
  const [lab] = await q(`insert into dental_labs (clinic_id, name) values ($1, 'Smile Lab') returning id`, [clinic.id]);
  await q(`insert into dental_lab_prices (clinic_id, lab_id, chart_key, cost) values ($1, $2, 'bridge', 45), ($1, $2, 'implant_bridge', 80), ($1, $2, 'implant_denture', 900)`, [clinic.id, lab.id]);
  const fileUrl = (id: string) => `${BASE}/c/${slug}/patients/${id}?tab=dental`;
  const put = async (pid: string, site: string, key: string, status: string, extra: { group?: string; role?: string; detail?: Record<string, string>; id?: string } = {}) => {
    const tr = BUILT_IN_BY_KEY.get(key)!;
    return (
      await q(
        `insert into chart_marks (id, clinic_id, patient_id, site, treatment_key, label, label_ar, look, kind, status, group_id, role, detail, recorded_by, done_at)
         values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, case when $10 = 'done' then now() end) returning id`,
        [extra.id ?? null, clinic.id, pid, site, key, tr.en, tr.ar, tr.look, tr.kind, status, extra.group ?? null, extra.role ?? null, JSON.stringify(extra.detail ?? {}), docUser.id]
      )
    )[0].id as string;
  };
  const marksOf = (pid: string) => q(`select * from chart_marks where patient_id = $1 and voided_at is null order by created_at`, [pid]);

  const browser = await chromium.launch();
  const errors: string[] = [];
  const pageOf = async (opts: { phone?: boolean; locale?: string } = {}) => {
    const pg = await signIn(browser, `prosth-${opts.locale === "ar" ? "ar" : "doc"}-${tag}@test.local`, opts);
    pg.on("pageerror", (e) => errors.push(`${opts.phone ? "phone" : "desk"}: ${e.message}`));
    return pg;
  };

  try {
    const page = await pageOf();

    /* ── The studio ──────────────────────────────────────────────────────── */
    if (run("arch")) {
      console.log("The studio");
      await openFile(page, fileUrl(p1));
      await tapTooth(page, "11");
      await addIn(page, "implant_denture", "all on 4", "Planned");
      const studio = studioOf(page);
      await studio.waitFor({ timeout: 10000 });
      const chips = async () => (await studio.locator("[data-implant-chip]").evaluateAll((els) => els.map((e) => e.getAttribute("data-implant-chip")))).join(" ");
      check((await studio.locator("[data-arch='upper'][aria-checked='true']").count()) === 1 && (await chips()) === "15 12 22 25", "All-on-4 from tooth 11 opens on the upper jaw, implants in the usual places", await chips());
      check((await studio.locator("[data-bridge-teeth]").getAttribute("data-bridge-teeth")) === "16,15,14,13,12,11,21,22,23,24,25,26", "the bridge runs first molar to first molar");
      await page.screenshot({ path: join(SHOTS, "studio-open.png") });

      // Dragged along the jaw.
      const handle = (where: string) => studio.locator(`[data-implant='${where}']`);
      const centre = async (loc: ReturnType<typeof handle>) => {
        const b = (await loc.boundingBox())!;
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      };
      const jaw = (await studio.locator("svg[data-jaw]").boundingBox())!;
      const col = (jaw.width / (16 * 44 + 12)) * 44;
      const from = await centre(handle("12"));
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x - col * 0.25, from.y, { steps: 4 });
      await page.mouse.move(from.x - col * 0.5, from.y + 2, { steps: 6 });
      await page.mouse.up();
      check((await chips()) === "15 13–12 22 25", "an implant dragged half a tooth to the right stands between 13 and 12", await chips());
      check((await studio.locator("[data-step-value='pos']").innerText()).includes("Between 13 and 12"), "and the controls say so in words", await studio.locator("[data-step-value='pos']").innerText());

      // Turned by its tip.
      const grip = await centre(studio.locator("[data-turn-handle] circle").last());
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x + col * 0.4, grip.y + 4, { steps: 8 });
      await page.mouse.up();
      const tilt = Number(await handle("13–12").getAttribute("data-implant-tilt"));
      check(tilt > 8 && tilt < 50, "its tip dragged toward the midline tilts it", String(tilt));
      check(/tip to the midline/.test(await studio.locator("[data-step-value='tilt']").innerText()), "and it says which way the tip leans", await studio.locator("[data-step-value='tilt']").innerText());

      // Sunk by dragging into the jaw.
      const bodyAt = await centre(handle("22"));
      await page.mouse.move(bodyAt.x, bodyAt.y);
      await page.mouse.down();
      await page.mouse.move(bodyAt.x, bodyAt.y - 10, { steps: 3 });
      await page.mouse.move(bodyAt.x + 1, bodyAt.y - 22, { steps: 4 });
      await page.mouse.up();
      check(/mm deeper/.test(await studio.locator("[data-step-value='depth']").innerText()) && (await chips()) === "15 13–12 22 25", "dragged into the jaw it goes deeper, and stays where it is along it", await studio.locator("[data-step-value='depth']").innerText());

      // By its buttons.
      await studio.locator("[data-implant-chip='25']").click();
      const before = await studio.locator("[data-step-value='tilt']").innerText();
      await studio.locator("[data-hold='tilt-less']").click();
      await studio.locator("[data-hold='len-more']").click();
      await studio.locator("[data-hold='dia-less']").click();
      check(before.startsWith("30") && (await studio.locator("[data-step-value='tilt']").innerText()).startsWith("31"), "a tap on its buttons turns it a degree", `${before} → ${await studio.locator("[data-step-value='tilt']").innerText()}`);
      check((await studio.locator("[data-step-value='len']").innerText()) === "15 mm" && (await studio.locator("[data-step-value='dia']").innerText()) === "Ø 3.75 mm", "and changes its size", await studio.locator("[data-implant-controls]").innerText());
      // Held: it keeps going, and stops at its neighbour.
      const left = studio.locator("[data-hold='pos-less']");
      const lb = (await left.boundingBox())!;
      await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(900);
      await page.mouse.up();
      const eased = Number(await studio.locator(`[data-implant-id][aria-pressed='true']`).evaluate((el) => (el as SVGElement).getBoundingClientRect().x));
      check((await chips()).split(" ").at(-1) !== "25", "a held button keeps easing it along", `${await chips()} ${eased}`);

      // At a desk, the keys.
      await handle((await chips()).split(" ")[0]).focus();
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowRight");
      check((await chips()).split(" ")[0] === "15–14", "the arrow keys move the implant in hand", await chips());

      // Added, and taken off.
      await studio.locator("[data-implant-add]").click();
      check((await studio.locator("[data-implant-chip]").count()) === 5, "another is added in the widest gap", await chips());
      await studio.locator("[data-implant-remove]").click();
      check((await studio.locator("[data-implant-chip]").count()) === 4, "and taken off again");

      // What goes on them.
      await studio.locator("[data-arch-material='acrylic']").click();
      await studio.locator("[data-arch-last='7']").click();
      check((await studio.locator("[data-bridge-teeth]").getAttribute("data-bridge-teeth"))!.startsWith("17,") && (await studio.locator("[data-bridge-teeth]").getAttribute("data-bridge-pieces")) === "1", "the bridge reaches as far back as the doctor says");
      await studio.locator("[data-joint='11-21']").click();
      check((await studio.locator("[data-bridge-teeth]").getAttribute("data-bridge-pieces")) === "2", "a tap on a joint splits it there");
      await page.screenshot({ path: join(SHOTS, "studio-placed.png") });

      await studio.locator("[data-record-full-arch]").click();
      check(await until(async () => (await marksOf(p1)).length > 30), "recorded");
      const rows = await marksOf(p1);
      const parent = rows.find((r) => r.site === "upper");
      const imps = rows.filter((r) => r.look === "implant").sort((a, b) => Number(a.detail.pos) - Number(b.detail.pos));
      check(
        parent.detail.kind === "fixed" && parent.detail.material === "acrylic" && cutsOf(parent.detail).has(7) && parent.detail.implants === "4" && rows.filter((r) => r.role === "pontic").length === 14,
        "the arch says what it is: fixed, acrylic on titanium, split at the midline, to the second molars",
        JSON.stringify(parent.detail)
      );
      check(imps.length === 4 && imps.every((i) => i.detail.pos && i.detail.tilt !== undefined && i.detail.len) && new Set(imps.map((i) => i.site)).size === 4, "each implant is kept where it was put, with a tooth of its own", JSON.stringify(imps.map((i) => [i.site, i.detail])));
      check(Math.abs(Number(imps[1].detail.pos) - 5.5) < 0.12, "the dragged one half a tooth over", imps[1].detail.pos);
      check(rows.filter((r) => r.treatment_key === "extraction").length === 16, "and the standing teeth are planned out");

      // On the chart, as one drawing.
      await putDown(page);
      await page.waitForTimeout(400);
      const piece = chart(page).locator("[data-piece='arch']");
      check((await piece.count()) === 2 && (await chart(page).locator("[data-arch-implant]").count()) === 4, "the chart draws the two halves of the bridge and the four implants", `${await piece.count()}`);
      check(((await chart(page).locator("[data-tooth='13']").getAttribute("data-looks")) ?? "").includes("denture"), "and each tooth still knows its part");
      await chart(page).screenshot({ path: join(SHOTS, "chart-arch-planned.png") });

      /* ── Adjusted afterwards ───────────────────────────────────────────── */
      console.log("Adjusted afterwards");
      const card = page.locator("[data-procedure]");
      if (!(await card.count())) await page.locator("[data-open-item]").first().click();
      await card.waitFor({ timeout: 10000 });
      const ids = new Map(imps.map((i) => [i.id, i.site]));
      await card.locator("[data-adjust-implants='card']").first().click();
      await studio.waitFor({ timeout: 10000 });
      check((await studio.getAttribute("data-full-arch-mode")) === "edit" && (await studio.locator("[data-implant-chip]").count()) === 4, "Adjust implants opens the jaw as it was recorded");
      await studio.locator("[data-implant-chip]").first().click();
      for (let i = 0; i < 12; i++) await studio.locator("[data-hold='pos-less']").click();
      for (let i = 0; i < 5; i++) await studio.locator("[data-hold='tilt-more']").click();
      await studio.locator("[data-implant-add]").click();
      await studio.locator("[data-arch-last='6']").click();
      await studio.locator("[data-record-full-arch]").click();
      check(await until(async () => (await marksOf(p1)).filter((r) => r.look === "implant").length === 5), "saved: five implants now");
      await page.waitForTimeout(600);
      const after = await marksOf(p1);
      const nowImps = after.filter((r) => r.look === "implant").sort((a, b) => Number(a.detail.pos) - Number(b.detail.pos));
      check(nowImps.filter((i) => ids.has(i.id)).length === 4 && Math.abs(Number(nowImps[0].detail.pos) - (Number(imps[0].detail.pos) - 0.6)) < 0.02, "the four that were there are the same four, moved", `${imps[0].detail.pos} → ${nowImps[0].detail.pos}`);
      check(after.find((r) => r.site === "upper").detail.implants === "5" && after.filter((r) => r.role === "pontic").length === 12, "the arch counts five, and its bridge is shorter by its second molars");
      const placed = await q(`select e.* from chart_mark_events e join chart_marks m on m.id = e.mark_id where m.patient_id = $1 and e.action = 'placed'`, [p1]);
      check(placed.some((e) => e.mark_id === parent.id && /^5 at /.test(e.reason)) && placed.some((e) => e.mark_id === nowImps[0].id), "its history says the implants were adjusted, on the arch and on the implant", JSON.stringify(placed.map((e) => e.reason)));
      const voided = await q(`select count(*)::int as n from chart_marks where patient_id = $1 and role = 'pontic' and voided_at is not null`, [p1]);
      check(voided[0].n === 2, "the teeth it no longer replaces are voided, not deleted");
      check(await until(async () => (await page.locator("[data-dental-chart]").innerText()).includes("Implants adjusted")), "and the chart's history shows it");
      await openFile(page, fileUrl(p1));
      check((await chart(page).locator("[data-arch-implant]").count()) === 5, "after a reload they are where they were left");

      /* ── The server does not take its word ──────────────────────────────── */
      console.log("What the server takes");
      const patch = (markId: string, body: unknown) =>
        page.evaluate(
          `fetch(${JSON.stringify(`/api/c/${slug}/patients/${p1}/dental/marks/`)} + ${JSON.stringify(markId)}, { method: "PATCH", headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then((r) => r.status)`
        ) as Promise<number>;
      const good = nowImps.map((i) => ({ id: i.id, eventId: randomUUID(), pos: Number(i.detail.pos), tilt: Number(i.detail.tilt), depth: Number(i.detail.depth), len: Number(i.detail.len), dia: Number(i.detail.dia) }));
      const teeth = after.filter((r) => r.role === "pontic").map((r) => r.site);
      const body = (over: Record<string, unknown>) => ({ op: "arch", eventId: randomUUID(), implants: good, teeth, kind: "fixed", material: "zirconia", cuts: "0", ...over });
      check((await patch(nowImps[0].id, body({}))) === 409, "an implant is not an arch to be adjusted");
      check((await patch(parent.id, body({ teeth: ["36", "37"] }))) === 409, "an upper arch's bridge has no lower teeth");
      check((await patch(parent.id, body({ implants: [{ ...good[0], id: randomUUID(), eventId: randomUUID() }, { ...good[0], id: (await put(p2, "18", "implant", "done")) }] }))) === 409, "another patient's implant cannot be drawn into it");
      check((await patch(parent.id, body({ implants: [] }))) === 400, "an arch on implants has at least one");
      check((await patch(parent.id, body({ implants: good.map((g, i) => (i === 0 ? { ...g, pos: -40, tilt: 900, len: 1 } : g)) }))) === 200, "a place off the jaw is taken…");
      const [far] = await q(`select detail from chart_marks where id = $1`, [nowImps[0].id]);
      check(far.detail.pos === "0" && far.detail.tilt === "60" && far.detail.len === "6", "…as the nearest place on it", JSON.stringify(far.detail));
      await q(`delete from chart_marks where patient_id = $1 and site = '18'`, [p2]);
    }

    /* ── The steps of an arch ────────────────────────────────────────────── */
    if (run("arch-steps")) {
      console.log("An arch under way");
      const g = randomUUID();
      const pid = await patient("Arch Steps");
      const lower = await put(pid, "lower", "implant_denture", "planned", { group: g, detail: { implants: "4", kind: "fixed", material: "zirconia", cuts: "0" } });
      const places = defaultPlaces("lower", 4);
      const sites = sitesFor("lower", places);
      for (const [i, p] of places.entries()) await put(pid, sites[i], "implant", "planned", { group: g, role: "abutment", detail: placeDetail({ ...p, pos: i === 0 ? 2.5 : p.pos }) });
      for (const f of ["44", "43", "42", "41", "31", "32", "33", "34"]) await put(pid, f, "implant_denture", "planned", { group: g, role: "pontic" });
      await openFile(page, fileUrl(pid));
      await page.locator("[data-open-item]").first().click();
      const card = page.locator("[data-procedure]");
      await card.waitFor({ timeout: 10000 });
      const open = async (key: string) => {
        if (!(await card.locator(`[data-step-form='${key}']`).count())) await card.locator(`[data-step='${key}'] button`).first().click();
        await card.locator(`[data-step-form='${key}']`).waitFor({ timeout: 8000 });
      };
      const doneStep = async (key: string) => {
        await open(key);
        await card.locator(`[data-step-done='${key}']`).click();
        await until(async () => (await card.locator(`[data-step='${key}'][data-step-state='done']`).count()) === 1);
      };
      await open("placement");
      const rowsText = await card.locator("[data-step-form='placement'] [data-implant-row]").evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.split("\n")[0]));
      check(rowsText.length === 4 && rowsText[0].includes("46–45"), "placing the implants asks about each where it stands", rowsText.join(" | "));
      const size = await card.locator("[data-step-form='placement'] [data-implant-row]").first().locator("input").nth(2).inputValue();
      check(size === "13", "with the size it was planned at", size);
      check((await card.locator("[data-step-form='placement'] [data-adjust-implants='step']").count()) === 1, "and may be moved from there");
      await doneStep("placement");
      check(await until(async () => (await chart(page).locator("[data-piece='arch']").first().getAttribute("data-piece-paint")) === "progress"), "once placed the bridge is under way");
      await chart(page).screenshot({ path: join(SHOTS, "chart-arch-placed.png") });
      await doneStep("temporary");
      check(await until(async () => (await chart(page).locator("[data-piece='arch']").first().getAttribute("data-piece-stage")) === "temp"), "its immediate temporary is drawn");
      await chart(page).screenshot({ path: join(SHOTS, "chart-arch-temporary.png") });
      await doneStep("impression");
      check((await card.locator("[data-lab-stop='impression'] [data-lab-send]").count()) === 1, "after the impression stands the lab");
      await card.locator("[data-lab-stop='impression'] [data-lab-send]").click();
      const stages = await card.locator("[data-lab-stage]").evaluateAll((els) => els.map((e) => e.getAttribute("data-lab-stage")).join(","));
      check(stages === "jig,framework,teeth,finish" && (await card.locator("[data-lab-cost-field]").inputValue()) === "900", "which may return a jig, the bar, the teeth or the finished bridge, at its price for the arch", stages);
      await card.locator("[data-lab-stage='teeth']").click();
      await card.locator("[data-lab-send-save]").click();
      check(await until(async () => (await q(`select * from lab_cases where mark_id = $1`, [lower])).length === 1), "sent");
      const [lc] = await q(`select * from lab_cases where mark_id = $1`, [lower]);
      check(lc.stage === "teeth" && lc.units === null && lc.spec.teeth.length === 8 && lc.spec.implants.length === 4 && lc.spec.implants.every((i: { length: number }) => i.length > 0) && lc.spec.material === "zirconia", "its order has the teeth, the material and the implants with their sizes", JSON.stringify(lc.spec));
      await open("delivery");
      check((await card.locator("[data-step-form='delivery'] [data-choice='material:zirconia'][aria-pressed='true']").count()) === 1, "the delivery opens on the material that was planned");
      await card.locator("[data-step-done='delivery']").click();
      check(await until(async () => (await q(`select count(*)::int as n from chart_marks where group_id = $1 and status <> 'done'`, [g]))[0].n === 0), "delivering it finishes the arch and every part of it");
      check(await until(async () => (await chart(page).locator("[data-piece='arch']").first().getAttribute("data-piece-paint")) === "done"), "and the chart shows it done");
      await chart(page).screenshot({ path: join(SHOTS, "chart-arch-done.png") });
      const fees = await q(`select count(*)::int as n from chart_marks where group_id = $1 and id <> $2 and fee is not null`, [g, lower]);
      check(fees[0].n === 0, "its teeth carry no price of their own");
    }

    /* ── Recorded before places existed ──────────────────────────────────── */
    if (run("old")) {
      console.log("Recorded before");
      const g = randomUUID();
      await put(p4, "lower", "implant_denture", "done", { group: g, detail: { implants: "4" } });
      for (const f of ["45", "42", "32", "35"]) await put(p4, f, "implant", "done", { group: g, role: "abutment" });
      for (const f of ["46", "45", "44", "43", "42", "41", "31", "32", "33", "34", "35", "36"]) await put(p4, f, "implant_denture", "done", { group: g, role: "pontic" });
      const b = randomUUID();
      const lead = await put(p4, "16", "bridge", "planned", { group: b, role: "abutment", detail: { material: "zirconia" } });
      await put(p4, "15", "bridge", "planned", { group: b, role: "pontic", detail: { material: "zirconia" } });
      await put(p4, "14", "bridge", "planned", { group: b, role: "abutment", detail: { material: "zirconia" } });
      await q(`insert into chart_mark_steps (clinic_id, mark_id, patient_id, step, data, recorded_by) values ($1, $2, $3, 'prep', '{"impression":"digital","shade":"A3","material":"zirconia"}', $4)`, [clinic.id, lead, p4, docUser.id]);
      await openFile(page, fileUrl(p4));
      check((await chart(page).locator("[data-piece='arch']").count()) === 1 && (await chart(page).locator("[data-arch-implant]").count()) === 4, "an All-on-4 from before draws as one piece on its four implants");
      check((await page.locator("[data-region-pill='lower'] title").first().evaluate((el) => el.textContent)) ?.startsWith("All-on-4"), "and is still called All-on-4");
      await page.locator(`[data-mark='${lead}'] [data-open-item]`).first().click();
      const card = page.locator(`[data-procedure='${lead}']`);
      await card.waitFor({ timeout: 10000 });
      check((await card.locator("[data-step-implied='impression']").count()) === 1 && (await card.getAttribute("data-procedure-status")) === "planned", "a bridge prepared before is not asked for its impression again");
      check((await card.locator("[data-step='prep'] [data-step-summary]").innerText()).includes("Digital scan") && (await card.locator("[data-step='prep'] [data-step-summary]").innerText()).includes("A3"), "and what was recorded then still shows", await card.locator("[data-step='prep'] [data-step-summary]").innerText());
      check((await card.locator("[data-progress]").getAttribute("data-progress")) === "2/3", "two of its three steps are done", (await card.locator("[data-progress]").getAttribute("data-progress")) ?? "");
      check(await card.locator("[data-lab-stop='impression'] [data-lab-send]").isVisible(), "and it is ready for the lab");
      // Correcting the old step keeps what it recorded.
      await card.locator("[data-step-edit='prep']").click();
      await card.locator("[data-choice='margin:chamfer']").click();
      await card.locator("[data-step-save='prep']").click();
      check(
        await until(async () => {
          const [s] = await q(`select data from chart_mark_steps where mark_id = $1 and step = 'prep'`, [lead]);
          return s.data.margin === "chamfer" && s.data.impression === "digital" && s.data.shade === "A3";
        }),
        "correcting it keeps its impression and shade"
      );
      // Cementing it finishes it, with no impression of its own.
      if (!(await card.locator("[data-step-form='cement']").count())) await card.locator("[data-step='cement'] button").first().click();
      await card.locator("[data-step-done='cement']").click();
      check(await until(async () => (await q(`select status from chart_marks where id = $1`, [lead]))[0].status === "done"), "and cementing it finishes it");
    }

    /* ── A bridge ────────────────────────────────────────────────────────── */
    if (run("bridge")) {
      console.log("A bridge on teeth");
      await put(p2, "15", "extraction", "done");
      await openFile(page, fileUrl(p2));
      await tapTooth(page, "15");
      await addIn(page, "bridge", "bridge", "Planned");
      const sheet = page.locator("[data-bridge-sheet]");
      await sheet.waitFor({ timeout: 10000 });
      const roles = async () => (await sheet.locator("[data-bridge-role]").evaluateAll((els) => els.map((e) => e.getAttribute("data-bridge-role")))).join(" ");
      check((await roles()) === "16:abutment 15:pontic 14:abutment", "from the missing 15 it proposes 16–14, 15 replaced", await roles());
      await page.screenshot({ path: join(SHOTS, "bridge-sheet.png") });
      await sheet.locator("[data-bridge-tooth='12']").click();
      check((await roles()) === "16:abutment 15:pontic 14:abutment 13:abutment 12:abutment", "a tooth further along joins with the ones between", await roles());
      await sheet.locator("[data-bridge-tooth='12']").click();
      await sheet.locator("[data-bridge-tooth='13']").click();
      check((await roles()) === "16:abutment 15:pontic 14:abutment", "an end tooth leaves");
      await sheet.locator("[data-bridge-role='14:abutment']").click();
      await sheet.locator("[data-bridge-role='16:abutment']").click();
      check(await sheet.locator("[data-record-bridge]").isDisabled(), "a bridge nothing carries cannot be recorded");
      await sheet.locator("[data-bridge-role='16:pontic']").click();
      check((await roles()) === "16:abutment 15:pontic 14:pontic" && !(await sheet.locator("[data-record-bridge]").isDisabled()), "an end set to replaced is a cantilever, and may be");
      await sheet.locator("[data-bridge-role='14:pontic']").click();
      await sheet.locator("[data-bridge-material='pfm']").click();
      await sheet.locator("[data-record-bridge]").click();
      check(await until(async () => (await marksOf(p2)).filter((r) => r.treatment_key === "bridge").length === 3), "recorded on its three teeth");
      const rows = (await marksOf(p2)).filter((r) => r.treatment_key === "bridge");
      check(new Set(rows.map((r) => r.group_id)).size === 1 && rows.every((r) => r.detail.material === "pfm" && Number(r.fee) === 200) && rows.find((r) => r.site === "15").role === "pontic", "as one bridge, PFM, at the price of a tooth each", JSON.stringify(rows.map((r) => [r.site, r.role, r.fee])));
      const lead = rows.find((r) => r.site === "16").id as string;
      const card = page.locator(`[data-procedure='${lead}']`);
      await card.waitFor({ timeout: 10000 });
      check((await card.locator("[data-price-text]").innerText()).includes("× 3"), "its card opens at once, priced by the tooth", await card.locator("[data-price-text]").innerText());
      const order = await card.locator("ol > li").evaluateAll((els) => els.map((e) => e.getAttribute("data-step") ?? `lab:${e.getAttribute("data-lab-stop")}`));
      check(order.join(" ") === "assess prep impression lab:impression temp framework tryin cement review", "the steps in order, the lab standing after the impression", order.join(" "));
      await putDown(page);
      await page.waitForTimeout(300);
      check((await chart(page).locator("[data-piece='bridge']").getAttribute("data-piece-teeth")) === "16,15,14", "the chart draws it as one piece");
      await chart(page).screenshot({ path: join(SHOTS, "chart-bridge-planned.png") });

      console.log("Its steps, and the lab");
      if (!(await card.count())) await page.locator(`[data-mark='${lead}'] [data-open-item]`).first().click();
      await card.waitFor({ timeout: 10000 });
      const open = async (key: string) => {
        if (!(await card.locator(`[data-step-form='${key}']`).count())) await card.locator(`[data-step='${key}'] button`).first().click();
        await card.locator(`[data-step-form='${key}']`).waitFor({ timeout: 8000 });
      };
      const doneStep = async (key: string) => {
        await open(key);
        await card.locator(`[data-step-done='${key}']`).click();
        await until(async () => (await card.locator(`[data-step='${key}'][data-step-state='done']`).count()) === 1);
      };
      await open("prep");
      await card.locator("[data-choice='material:zirconia']").click();
      await card.locator("[data-choice='margin:chamfer']").click();
      await card.locator("[data-step-done='prep']").click();
      check(await until(async () => (await marksOf(p2)).filter((r) => r.treatment_key === "bridge").every((r) => r.detail.material === "zirconia")), "its type chosen at the preparation is the whole bridge's");
      check(await until(async () => (await chart(page).locator("[data-piece='bridge']").getAttribute("data-piece-stage")) === "prep"), "prepared, its supports are drawn cut down");
      await chart(page).screenshot({ path: join(SHOTS, "chart-bridge-prepared.png") });
      await open("impression");
      await card.locator("[data-step-form='impression'] input").last().fill("A2");
      await card.locator("[data-step-done='impression']").click();
      await until(async () => (await card.locator("[data-step='impression'][data-step-state='done']").count()) === 1);
      const stop = card.locator("[data-lab-stop='impression']");
      check((await stop.innerText()).includes("Ready for the lab"), "the impression taken, it is ready for the lab", await stop.innerText());
      await stop.locator("[data-lab-send]").click();
      check((await card.locator("[data-lab-cost-field]").inputValue()) === "135" && (await card.locator("[data-lab-per-tooth]").innerText()).includes("3 teeth"), "the lab's price is once per tooth: 45 × 3 = 135", await card.locator("[data-lab-cost-field]").inputValue());
      check((await card.locator("[data-lab-form-teeth]").innerText()).includes("15 replaced") && (await card.locator("[data-lab-form] input[placeholder='A2']").inputValue()) === "A2", "with its teeth and its shade already there", await card.locator("[data-lab-form-teeth]").innerText());
      await card.locator("[data-lab-due='5']").click();
      await card.locator("[data-lab-form]").scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, "lab-send.png") });
      await card.locator("[data-lab-send-save]").click();
      check(await until(async () => (await q(`select * from lab_cases where mark_id = $1`, [lead])).length === 1), "sent for its framework");
      const caseOf = async () => (await q(`select * from lab_cases where mark_id = $1`, [lead]))[0];
      let lc = await caseOf();
      check(
        lc.stage === "framework" && lc.units === 3 && Number(lc.cost) === 135 && lc.spec.material === "zirconia" && lc.spec.teeth.map((x: { site: string; role: string }) => `${x.site} ${x.role}`).join() === "16 abutment,15 pontic,14 abutment",
        "the order says which teeth carry it, which it replaces and what of",
        JSON.stringify(lc.spec)
      );
      check(await until(async () => (await stop.locator("[data-lab-trip='framework'][data-lab-trip-state='sent']").count()) === 1 && /due/.test(await stop.innerText())), "it stands in the steps: at the lab, due", await stop.innerText());

      // Lab work, across the clinic.
      await page.goto(`${BASE}/c/${slug}/labs`, { timeout: 120000 });
      await page.waitForSelector("[data-lab-out]", { timeout: 60000 });
      const out = await page.locator(`[data-lab-work='${lc.id}']`).innerText();
      check(/teeth 16 · 15 · 14/.test(out) && /3 units/.test(out) && /framework/.test(out) && /A2/.test(out), "Lab work names every tooth, the units, the shade and what is being made", out);
      await page.screenshot({ path: join(SHOTS, "lab-work.png") });
      await page.locator(`[data-lab-received='${lc.id}']`).click();
      check(await until(async () => (await caseOf()).status === "received"), "received from there");

      await openFile(page, fileUrl(p2));
      await page.locator(`[data-mark='${lead}'] [data-open-item]`).first().click();
      await card.waitFor({ timeout: 10000 });
      check((await card.locator("[data-lab-stop='framework'][data-lab-stop-state='goes-again']").count()) === 1, "back, it goes again from the framework try-in");
      await doneStep("framework");
      const again = card.locator("[data-lab-stop='framework']");
      await again.locator("[data-lab-resend]").click();
      const offers = await again.locator("[data-lab-stage]").evaluateAll((els) => els.map((e) => e.getAttribute("data-lab-stage")).join(","));
      check(offers === "bisque,finish", "for the porcelain, or to be finished", offers);
      await again.locator("[data-lab-due='3']").click();
      await again.locator("[data-lab-resend-save]").click();
      check(await until(async () => (await caseOf()).stage === "bisque"), "sent back for its porcelain");
      lc = await caseOf();
      const n = await q(`select count(*)::int as n, sum(cost)::float as cost from lab_cases where mark_id = $1`, [lead]);
      check(n[0].n === 1 && n[0].cost === 135 && lc.trips.length === 1 && lc.trips[0].stage === "framework" && !!lc.trips[0].receivedAt && lc.status === "sent", "the same order at the same price, the framework's trip kept", JSON.stringify({ n: n[0], trips: lc.trips }));
      await again.locator(`[data-lab-received]`).click();
      await until(async () => (await caseOf()).status === "received");
      await doneStep("tryin");
      const third = card.locator("[data-lab-stop='tryin']");
      await third.locator("[data-lab-resend]").click();
      await third.locator("[data-lab-resend-save]").click();
      check(await until(async () => (await caseOf()).stage === "finish"), "and again to be finished");
      await third.locator("[data-lab-received]").click();
      await until(async () => (await caseOf()).status === "received");
      check((await card.locator("[data-lab-trip]").count()) === 3 && (await card.locator("[data-lab-resend]").count()) === 0, "three trips stand among the steps, and it goes no more");
      await card.locator("[data-lab-order-toggle]").first().click();
      const ord = await card.locator("[data-lab-order]").innerText();
      check(/16 · 14/.test(ord) && /15/.test(ord) && /Zirconia/.test(ord) && /A2/.test(ord), "the order can be read back", ord);
      await card.locator("[data-lab-order]").scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, "bridge-card.png") });
      await doneStep("cement");
      check(await until(async () => (await marksOf(p2)).filter((r) => r.treatment_key === "bridge").every((r) => r.status === "done")), "cementing it finishes the bridge");
      await putDown(page);
      await page.waitForTimeout(400);
      check((await chart(page).locator("[data-piece='bridge']").getAttribute("data-piece-paint")) === "done", "and the chart shows it done");
      await chart(page).screenshot({ path: join(SHOTS, "chart-bridge-done.png") });

      // What the routes refuse.
      const call = (url: string, method: string, body: unknown) =>
        page.evaluate(`fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then((r) => r.status)`) as Promise<number>;
      const teethTry = await call(`/api/c/${slug}/patients/${p2}/dental/labs/${lc.id}`, "PATCH", { op: "resend", stage: "teeth", dueOn: null });
      check(teethTry === 409, "a bridge is never sent for a teeth try-in", String(teethTry));
      await q(`update lab_cases set status = 'sent' where id = $1`, [lc.id]);
      check((await call(`/api/c/${slug}/patients/${p2}/dental/labs/${lc.id}`, "PATCH", { op: "resend", stage: "finish", dueOn: null })) === 409, "what is still at the lab is not sent again");
      const crown = await put(p2, "26", "crown", "planned", { detail: { material: "zirconia" } });
      check((await call(`/api/c/${slug}/patients/${p2}/dental/marks/${crown}/lab`, "POST", { id: randomUUID(), labId: lab.id, cost: 10, stage: "framework" })) === 409, "a crown has no framework to send for");
    }

    /* ── On implants ─────────────────────────────────────────────────────── */
    if (run("implants")) {
      console.log("After an implant: a crown, or a bridge");
      for (const f of ["24", "25", "26"]) await put(p3, f, "missing", "existing");
      const i24 = await put(p3, "24", "implant", "done");
      await put(p3, "26", "implant", "done");
      await openFile(page, fileUrl(p3));
      await tapTooth(page, "24");
      await panelOf(page).locator(`[data-mark='${i24}'] [data-open-item]`).click();
      const impl = page.locator(`[data-procedure='${i24}']`);
      await impl.waitFor({ timeout: 10000 });
      const ups = await impl.locator("[data-follow-up]").evaluateAll((els) => els.map((e) => e.getAttribute("data-follow-up")).join(","));
      check(ups === "implant_crown,implant_bridge", "an implant placed offers a crown on it, and a bridge", ups);
      await impl.locator("[data-follow-up='implant_bridge']").click();
      const sheet = page.locator("[data-bridge-sheet]");
      await sheet.waitFor({ timeout: 10000 });
      check((await sheet.getAttribute("data-bridge-sheet")) === "implant_bridge" && (await sheet.locator("[data-bridge-summary]").getAttribute("data-bridge-summary")) === "3/2", "the bridge is proposed to the next implant, on implants");
      await page.screenshot({ path: join(SHOTS, "implant-bridge-sheet.png") });
      await sheet.locator("[data-record-bridge]").click();
      check(await until(async () => (await marksOf(p3)).filter((r) => r.treatment_key === "implant_bridge").length === 3), "planned across 24–26");
      const rows = (await marksOf(p3)).filter((r) => r.treatment_key === "implant_bridge");
      const lead = rows.find((r) => r.site === "24").id as string;
      check(rows.every((r) => Number(r.fee) === 350 && r.status === "planned") && rows.find((r) => r.site === "25").role === "pontic", "at its own price a tooth", JSON.stringify(rows.map((r) => [r.site, r.role, r.fee])));
      const card = page.locator(`[data-procedure='${lead}']`);
      await card.waitFor({ timeout: 10000 });
      const order = await card.locator("ol > li").evaluateAll((els) => els.map((e) => e.getAttribute("data-step") ?? `lab:${e.getAttribute("data-lab-stop")}`));
      check(order.join(" ") === "impression lab:impression abutment framework tryin delivery review", "its steps: impression, the lab, abutments, try-ins, delivery", order.join(" "));
      await card.locator("[data-step-done='impression']").click();
      await until(async () => (await card.locator("[data-step='impression'][data-step-state='done']").count()) === 1);
      await card.locator("[data-lab-send]").click();
      check((await card.locator("[data-lab-cost-field]").inputValue()) === "240", "the lab's price for it by the tooth: 80 × 3 = 240", await card.locator("[data-lab-cost-field]").inputValue());
      // Full zirconia: straight to the finished piece.
      await card.locator("[data-lab-stage='finish']").click();
      await card.locator("[data-lab-send-save]").click();
      check(await until(async () => (await q(`select * from lab_cases where mark_id = $1`, [lead])).length === 1), "sent straight to be finished");
      const [lc] = await q(`select * from lab_cases where mark_id = $1`, [lead]);
      check(lc.stage === "finish" && lc.spec.teeth.filter((x: { implant?: boolean }) => x.implant).map((x: { site: string }) => x.site).join() === "24,26" && lc.spec.implants.length === 2, "its order says which supports are implants", JSON.stringify(lc.spec));
      await card.locator("[data-lab-received]").click();
      await until(async () => (await q(`select status from lab_cases where id = $1`, [lc.id]))[0].status === "received");
      check((await card.locator("[data-lab-stop='framework']").count()) === 0, "with nothing to try in between");
      if (!(await card.locator("[data-step-form='delivery']").count())) await card.locator("[data-step='delivery'] button").first().click();
      await card.locator("[data-choice='retention:screw']").click();
      await card.locator("[data-step-done='delivery']").click();
      check(await until(async () => (await marksOf(p3)).filter((r) => r.treatment_key === "implant_bridge").every((r) => r.status === "done")), "delivered, it is done");
      await putDown(page);
      await page.waitForTimeout(400);
      await chart(page).screenshot({ path: join(SHOTS, "chart-implant-bridge.png") });

      // A bridge planned after an extraction is a bridge, not one tooth.
      const ext = await put(p3, "36", "extraction", "done");
      await openFile(page, fileUrl(p3));
      await page.evaluate(`document.querySelector("[data-dental-chart] [data-tooth='36']").dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
      await panelOf(page).waitFor({ timeout: 10000 });
      check(!!ext && (await marksOf(p3)).filter((r) => r.treatment_key === "bridge").length === 0, "(no bridge there yet)");
      await addIn(page, "bridge", "bridge", "Planned");
      await sheet.waitFor({ timeout: 10000 });
      check((await sheet.locator("[data-bridge-summary]").getAttribute("data-bridge-summary")) === "3/2" && (await sheet.getAttribute("data-bridge-sheet")) === "bridge", "over an extracted tooth it proposes the bridge on its neighbours");
      await page.keyboard.press("Escape");
      await putDown(page);

      // Settings says which prices are by the tooth.
      await page.goto(`${BASE}/c/${slug}/settings/labs`, { timeout: 120000 });
      await page.waitForSelector("[data-dental-labs]", { timeout: 60000 });
      await page.locator(`[data-lab='${lab.id}'] button`).first().click();
      check((await page.locator("[data-per-tooth='bridge']").count()) === 1 && (await page.locator("[data-per-tooth='implant_bridge']").count()) === 1 && (await page.locator("[data-per-tooth='crown']").count()) === 0, "Settings marks the two bridges as priced per tooth");
    }

    /* ── In Arabic ───────────────────────────────────────────────────────── */
    if (run("arabic")) {
      console.log("In Arabic");
      const ar = await pageOf({ locale: "ar" });
      await ar.goto(`${BASE}/c/${slug}/labs?tab=back`, { timeout: 120000 });
      await ar.waitForSelector("[data-lab-back], [data-lab-out]", { timeout: 60000 }).catch(() => {});
      const text = await ar.locator("main").innerText();
      check(/وحدات/.test(text) && /جاهز للتسليم/.test(text), "Lab work says the units and what came back in Arabic", text.slice(0, 300));
      await ar.screenshot({ path: join(SHOTS, "lab-work-ar.png") });
      await ar.context().close();
    }

    /* ── On a phone ──────────────────────────────────────────────────────── */
    if (run("phone")) {
      console.log("On a phone");
      const phone = await pageOf({ phone: true });
      const cdp = await phone.context().newCDPSession(phone);
      const touch = async (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
        cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      const swipe = async (x0: number, y0: number, x1: number, y1: number) => {
        await touch("touchStart", x0, y0);
        for (let i = 1; i <= 8; i++) {
          await touch("touchMove", x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8);
          await phone.waitForTimeout(16);
        }
        await touch("touchEnd");
        await phone.waitForTimeout(350);
      };
      await openFile(phone, fileUrl(p5));
      await chart(phone).locator("[data-tooth='14']").first().tap();
      await panelOf(phone).waitFor({ timeout: 10000 });
      await addIn(phone, "implant_denture", "all on 4", "Planned");
      const studio = studioOf(phone);
      await studio.waitFor({ timeout: 10000 });
      await phone.waitForTimeout(400);
      const box = (await studio.boundingBox())!;
      check(box.width <= 390 && (await phone.evaluate(`document.documentElement.scrollWidth`)) === 390, "the studio fits a phone, with nothing wider than the screen", `${box.width}`);
      const jaw = (await studio.locator("svg[data-jaw]").boundingBox())!;
      check(jaw.height > 120 && jaw.width >= 380, "the jaw is drawn as wide as the phone", JSON.stringify(jaw));
      await studio.locator("[data-implant-chip='25']").tap();
      await phone.waitForTimeout(500);
      const at25 = (await studio.locator("[data-implant='25']").boundingBox())!;
      check(at25.x > 40 && at25.x + at25.width < 350, "choosing an implant brings it to the middle of the screen", JSON.stringify(at25));
      check(at25.width >= 30, "big enough for a finger", String(at25.width));
      const tiltBefore = await studio.locator("[data-step-value='pos']").innerText();
      await swipe(at25.x + at25.width / 2, at25.y + at25.height / 2, at25.x + at25.width / 2 + 34, at25.y + at25.height / 2 + 2);
      const posAfter = await studio.locator("[data-step-value='pos']").innerText();
      check(posAfter !== tiltBefore && /26|between/i.test(posAfter), "a finger drags it along the jaw", `${tiltBefore} → ${posAfter}`);
      const grip = (await studio.locator("[data-turn-handle] circle").nth(1).boundingBox())!;
      await swipe(grip.x + grip.width / 2, grip.y + grip.height / 2, grip.x + grip.width / 2 + 30, grip.y + grip.height / 2);
      const tiltText = await studio.locator("[data-step-value='tilt']").innerText();
      check(!tiltText.startsWith("30"), "and turns it by its tip", tiltText);
      await phone.screenshot({ path: join(SHOTS, "phone-studio.png") });
      const small = await studio.locator("button:visible").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 35).map((e) => (e as HTMLElement).innerText || e.getAttribute("aria-label")));
      check(small.length === 0, "every button is a thumb's size", small.join(", "));
      // A click, not a tap: a dev server compiling mid-press turns a tap into a long press, and a long press records nothing.
      await studio.locator("[data-record-full-arch]").click();
      const saved = await until(async () => (await marksOf(p5)).filter((r) => r.look === "implant").length === 4);
      if (!saved) {
        await phone.screenshot({ path: join(SHOTS, "phone-not-saved.png") });
        console.log("   studio open:", await studio.count(), "dialogs:", await phone.locator("[role='dialog']").count(), "rows:", (await marksOf(p5)).length);
      }
      check(saved, "and records it");
      const imps = (await marksOf(p5)).filter((r) => r.look === "implant").sort((a, b) => Number(a.detail.pos) - Number(b.detail.pos));
      check(Number(imps[3].detail.pos) > 12.2, "the moved implant where the finger left it", imps[3].detail.pos);
      await phone.keyboard.press("Escape");
      await phone.waitForTimeout(600);
      await phone.screenshot({ path: join(SHOTS, "phone-card.png") });
      for (let i = 0; i < 4 && (await phone.locator("[role='dialog'][aria-modal='true']").count()); i++) {
        await phone.keyboard.press("Escape");
        await phone.waitForTimeout(250);
      }
      await phone.waitForTimeout(400);
      await chart(phone).scrollIntoViewIfNeeded();
      await phone.screenshot({ path: join(SHOTS, "phone-chart.png") });

      // A bridge, on a phone.
      await put(p2, "45", "missing", "existing");
      await openFile(phone, fileUrl(p2));
      await chart(phone).locator("[data-tooth='45']").first().tap();
      await panelOf(phone).waitFor({ timeout: 10000 });
      await addIn(phone, "bridge", "bridge", "Planned");
      const sheet = phone.locator("[data-bridge-sheet]");
      await sheet.waitFor({ timeout: 10000 });
      check((await phone.evaluate(`document.documentElement.scrollWidth`)) === 390, "the bridge sheet fits too");
      await phone.screenshot({ path: join(SHOTS, "phone-bridge.png") });
      await sheet.locator("[data-record-bridge]").scrollIntoViewIfNeeded();
      await sheet.locator("[data-record-bridge]").click();
      check(await until(async () => (await marksOf(p2)).filter((r) => r.treatment_key === "bridge" && ["44", "45", "46"].includes(r.site)).length === 3), "and records a bridge across 44–46");
      await phone.waitForTimeout(800);
      await phone.screenshot({ path: join(SHOTS, "phone-bridge-card.png") });
      await phone.context().close();
    }

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await q(`delete from clinics where id = $1`, [clinic.id]).catch(() => {});
    await db.end();
  }
  finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
