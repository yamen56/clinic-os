/**
 * The clinic's own face treatments, and the kinds of each (0094).
 *
 * Yamen, 2026-11-07: the doctor should "be able to add more treatments other than
 * the added ones, with its possible variants".
 *
 * - A doctor adds a treatment at the chair, on the areas just picked, and records it.
 * - A kind of the work is added in place and recorded with the entry; the entry
 *   keeps how it counted, so renaming or archiving the treatment later changes no past entry.
 * - The kind can have its own price, which wins over the treatment's; what was
 *   recorded with no price takes it.
 * - The invoice line says which kind it was.
 * - The clinic's own treatments are offered for packages and products, and an
 *   archived one is no longer offered but still named on old entries.
 *
 * Run against a warm server.
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { faceLineText } from "../src/lib/charts/face/catalog";

const BASE = process.env.APP_URL || "http://localhost:3000";
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
async function until(fn: () => Promise<boolean>, ms = 15000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** A tap on a part of the face, beside its middle: an earlier visit's dot may sit in the middle, and a tap there opens it. */
async function tapBeside(page: Page, zone: string, dx = 24) {
  const el = page.locator(`[data-zone='${zone}']`);
  const b = (await el.boundingBox())!;
  await el.click({ position: { x: b.width / 2 + dx, y: b.height / 2 } });
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const slug = `qacustom${tag}`;
  const [clinic] = await q(`insert into clinics (name, slug, features, timezone) values ('QA Custom', $1, '{"aesthetic": true}', 'Asia/Amman') returning id`, [slug]);
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  await q(`select seed_expense_categories($1)`, [clinic.id]);
  const email = `custom-${tag}@test.local`;
  const [u] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'Dr Custom', 'en') returning id`, [email, bcrypt.hashSync("password123", 10)]);
  const [doc] = await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'doctor', true, '{"level":"full"}') returning id`, [clinic.id, u.id]);
  const [patient] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Maya Custom', '+962790006161', 'staff') returning id`, [clinic.id]);

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
    const page: Page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/login`, { timeout: 180000 });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((x) => !x.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });

    console.log("A treatment of the clinic's own, at the chair");
    const chart = `${BASE}/c/${slug}/patients/${patient.id}?tab=face`;
    await page.goto(chart, { timeout: 180000 });
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    await page.locator("[data-zone='neck']").click();
    await page.locator("[data-face-add-treatment]").click();
    await page.locator("[data-face-new-name]").fill("Polynucleotides");
    await page.locator("[data-face-new-family]").selectOption("skin");
    await page.locator("[data-face-new-priced]").selectOption("session");
    await page.locator("[data-face-new-save]").click();
    await page.waitForSelector("[data-face-panel='record']", { timeout: 15000 });
    const [made] = await q(`select key, fits from aesthetic_treatments where clinic_id = $1`, [clinic.id]);
    check(made?.key?.startsWith("aes_c_"), "it is saved with a face chart key", made?.key);
    check(JSON.stringify(made?.fits) === '["neck"]', "on the areas the doctor picked", JSON.stringify(made?.fits));
    check((await page.locator("[data-face-panel='record'] h3").innerText()).includes("Polynucleotides"), "and the chart goes straight on to recording it");

    console.log("A kind of it");
    await page.locator("[data-face-variant-add]").click();
    await page.locator("[data-face-variant-name]").fill("Salmon DNA");
    await page.locator("[data-face-variant-save]").click();
    check(await until(async () => (await page.locator("[data-face-variant='Salmon DNA']").getAttribute("aria-pressed")) === "true"), "a kind is added in place, and chosen");
    await page.locator("[data-face-save]").click();
    check(await until(async () => (await q(`select 1 from chart_marks where clinic_id = $1 and treatment_key = $2`, [clinic.id, made.key])).length === 1), "the treatment is recorded");
    const [mark] = await q(`select id, label, label_ar, areas, quantity, detail, fee from chart_marks where clinic_id = $1 and treatment_key = $2`, [clinic.id, made.key]);
    check(mark.detail?.variant?.name === "Salmon DNA" && mark.detail?.pricedBy === "session", "with its kind and how it counted", JSON.stringify(mark.detail));
    check(mark.fee === null, "unpriced, as nothing has a price yet");

    console.log("Prices");
    await page.goto(`${BASE}/c/${slug}/settings/face-prices`, { timeout: 180000 });
    await page.waitForSelector("[data-face-prices]", { timeout: 120000 });
    check((await page.locator(`[data-face-price-row='${made.key}']`).count()) === 1, "the clinic's own treatment is on the price list");
    const [kind] = await q(`select id from aesthetic_treatment_variants where clinic_id = $1 and name = 'Salmon DNA'`, [clinic.id]);
    // The kind's price first: an entry of that kind takes it, not the treatment's.
    await page.locator(`[data-price-box='${made.key}:${kind.id}']`).fill("150");
    await page.locator(`[data-price-box='${made.key}:${kind.id}']`).press("Enter");
    check(await until(async () => Number((await q(`select fee from chart_marks where id = $1`, [mark.id]))[0].fee) === 150), "the waiting entry takes its kind's own price");
    await page.locator(`[data-price-box='${made.key}']`).fill("100");
    await page.locator(`[data-price-box='${made.key}']`).press("Enter");
    await until(async () => (await q(`select 1 from services where clinic_id = $1 and chart_key = $2 and chart_variant is null`, [clinic.id, made.key])).length === 1);
    check(Number((await q(`select fee from chart_marks where id = $1`, [mark.id]))[0].fee) === 150, "and the treatment's own price does not undercut it");
    const [svc] = await q(`select name from services where clinic_id = $1 and chart_variant = $2`, [clinic.id, kind.id]);
    check(svc?.name === "Polynucleotides (Salmon DNA)", "the kind's price is named after it", svc?.name);
    const plainLine = faceLineText({ treatmentKey: made.key, label: mark.label, labelAr: mark.label_ar, areas: mark.areas, quantity: Number(mark.quantity), detail: mark.detail }, null, "en");
    check(plainLine.startsWith("Polynucleotides (Salmon DNA) — Neck"), "an invoice line says which kind it was", plainLine);

    console.log("Elsewhere");
    await page.goto(`${BASE}/c/${slug}/stock`, { timeout: 180000 });
    await page.waitForSelector("[data-stock]");
    await page.locator("[data-stock-new-product]").click();
    check((await page.locator(`[data-product-treatment='${made.key}']`).count()) === 1, "a product can be offered for it");
    await page.keyboard.press("Escape");
    await page.goto(`${BASE}/c/${slug}/settings/face-packages`, { timeout: 180000 });
    await page.getByRole("button", { name: /new/i }).first().click();
    check(await until(async () => (await page.locator(`option[value='${made.key}']`).count()) > 0), "and a package can include it");

    console.log("Anywhere, at the doctor's price, and retouched");
    const anywhere = await page.request.post(`${BASE}/api/c/${slug}/patients/${patient.id}/face/marks`, {
      data: { id: crypto.randomUUID(), eventId: crypto.randomUUID(), treatmentKey: "aes_filler", areas: [{ zone: "forehead" }], count: 1 },
    });
    check(anywhere.ok(), "a treatment is recorded wherever the doctor says, not only where it is usual", String(anywhere.status()));
    await page.goto(chart, { timeout: 180000 });
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    check((await page.locator("[data-face-preset='neck']").count()) === 1 && (await page.locator("[data-face-preset='full']").count()) === 1, "the neck and the full face are one tap each");
    await tapBeside(page, "neck");
    await page.locator(`[data-face-treatment='${made.key}']`).click();
    await page.waitForSelector("[data-face-panel='record']");
    await page.locator("[data-face-price-input]").fill("80");
    await page.locator("[data-face-save]").click();
    check(
      await until(async () => (await q(`select 1 from chart_marks where clinic_id = $1 and treatment_key = $2 and fee = 80 and fee_manual`, [clinic.id, made.key])).length === 1),
      "the doctor sets this patient's price while recording, and it is kept as theirs"
    );
    await page.reload();
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    await page.locator(`[data-face-retouch='${mark.id}']`).first().click();
    await page.waitForSelector("[data-face-retouching]");
    check(await page.locator("[data-face-save]").isDisabled(), "a retouch waits for the doctor to say what it costs");
    await page.locator("[data-face-price-input]").fill("0");
    await page.locator("[data-face-save]").click();
    check(
      await until(async () => (await q(`select 1 from chart_marks where redo_of = $1 and fee = 0 and fee_manual`, [mark.id])).length === 1),
      "and is recorded against the treatment it retouches, free when they say so"
    );
    check(await until(async () => (await page.locator(`[data-face-retouched='1']`).count()) > 0), "the original says it was retouched");

    console.log("Exact points (2026-11-08)");
    await page.goto(chart, { timeout: 180000 });
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    const map = page.locator("[data-face-map]");
    const mb = (await map.boundingBox())!;
    const at = (x: number, y: number) => map.click({ position: { x: mb.width * x, y: mb.height * y } });
    await at(0.42, 0.262);
    await at(0.58, 0.27);
    await at(0.5, 0.341);
    check((await page.locator("[data-face-point]").count()) === 3, "each tap puts a point where it lands");
    check((await page.locator("[data-face-point='forehead']").count()) === 2 && (await page.locator("[data-face-point='glabella']").count()) === 1, "and each point knows the part of the face it is in");
    check((await page.locator("[data-face-points]").getAttribute("data-face-points")) === "3", "the panel counts them");
    await page.locator("[data-face-point='glabella']").click();
    check((await page.locator("[data-face-point]").count()) === 2 && (await page.locator("[data-zone='glabella']").getAttribute("aria-pressed")) === "false", "a point tapped again comes off, and its part with it");
    await at(0.5, 0.341);
    await page.locator("[data-face-treatment='aes_toxin']").click();
    await page.waitForSelector("[data-face-panel='record']");
    await page.locator("[data-face-save]").click();
    check(
      await until(async () => (await q(`select 1 from chart_marks where clinic_id = $1 and treatment_key = 'aes_toxin'`, [clinic.id])).length === 1),
      "the treatment is saved"
    );
    const [pointed] = await q(`select id, areas from chart_marks where clinic_id = $1 and treatment_key = 'aes_toxin'`, [clinic.id]);
    const byZone = Object.fromEntries((pointed.areas as { zone: string; units?: number; points?: { x: number; y: number }[] }[]).map((a) => [a.zone, a]));
    check(byZone.forehead?.points?.length === 2 && byZone.glabella?.points?.length === 1, "with its points, by part", JSON.stringify(pointed.areas));
    check(Math.abs((byZone.forehead?.points?.[0]?.x ?? 0) - 0.42) < 0.02, "where they were tapped");
    check(byZone.forehead?.units === 10 && byZone.glabella?.units === 20, "and the parts keep their units");
    await page.reload();
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    check((await page.locator(`[data-face-past='${pointed.id}']`).count()) === 3, "after, the points stay on the face as dots");
    // The forehead is tinted by the filler recorded on it whole, above; the glabella only ever had points.
    check((await page.locator("[data-zone='glabella']").getAttribute("data-tint")) === null, "instead of tinting the whole part");
    await page.locator(`[data-face-past='${pointed.id}']`).first().click();
    await page.waitForSelector(`[data-face-spot='${pointed.id}']`);
    const card = await page.locator(`[data-face-spot='${pointed.id}']`).innerText();
    check(card.includes("Botulinum toxin") && card.includes("Dr Custom") && card.includes("10u in Forehead"), "tapping a dot says what was done there, by whom, how much", card.replace(/\n/g, " | "));
    await page.locator("[data-face-spot-again]").click();
    check((await page.locator("[data-face-point]").count()) === 1 && (await page.locator("[data-face-panel='areas']").count()) === 1, "and Treat here again starts a new one on that spot");
    await page.locator("[data-face-panel='areas'] button", { hasText: "Clear" }).click();
    const misplaced = await page.request.post(`${BASE}/api/c/${slug}/patients/${patient.id}/face/marks`, {
      data: { id: crypto.randomUUID(), eventId: crypto.randomUUID(), treatmentKey: "aes_toxin", areas: [{ zone: "forehead", units: 10, points: [{ x: 0.5, y: 0.83 }] }] },
    });
    check(misplaced.status() === 400, "a point is refused under a part it is not in", String(misplaced.status()));
    await page.locator("[data-zone='lips']").focus();
    await page.keyboard.press("Enter");
    check((await page.locator("[data-zone='lips']").getAttribute("aria-pressed")) === "true" && (await page.locator("[data-face-point]").count()) === 0, "from the keyboard a part is chosen whole");
    await page.locator("[data-face-panel='areas'] button", { hasText: "Clear" }).click();

    console.log("The head turned (2026-11-08)");
    check((await page.locator("[data-face-view-tab]").count()) === 5, "five views: left, front-left, front, front-right, right");
    await page.locator("[data-face-view-tab='left']").click();
    check((await page.locator("[data-face-map]").getAttribute("data-face-view")) === "left" && (await page.locator("[data-face-img]").getAttribute("src"))?.includes("face-left"), "the left view shows the head from the left");
    check((await page.locator("[data-zone='cheek_r']").count()) === 0 && (await page.locator("[data-zone='cheek_l']").count()) === 1, "with only the parts it shows");
    check((await page.locator(`[data-face-past='${pointed.id}']`).count()) === 0, "and none of the front's points");
    const lb = (await map.boundingBox())!;
    await map.click({ position: { x: lb.width * 0.31, y: lb.height * 0.53 } });
    check((await page.locator("[data-face-point='cheek_l']").count()) === 1, "a tap on the left cheek is the left cheek");
    check((await page.locator("[data-face-view-tab='left']").innerText()).includes("1"), "the view counts the points on it");
    await page.locator("[data-face-view-tab='front']").click();
    check((await page.locator("[data-face-point]").count()) === 0 && (await page.locator("[data-face-panel='areas']").count()) === 1, "on the front it is not drawn, but it is still being recorded");
    await page.locator("[data-face-treatment='aes_filler']").click();
    await page.waitForSelector("[data-face-panel='record']");
    await page.locator("[data-face-save]").click();
    check(
      await until(async () => (await q(`select 1 from chart_marks where clinic_id = $1 and treatment_key = 'aes_filler' and areas @> '[{"zone":"cheek_l"}]'`, [clinic.id])).length === 1),
      "the filler is saved on the left cheek"
    );
    const [side] = await q(`select id, areas from chart_marks where clinic_id = $1 and treatment_key = 'aes_filler' and areas @> '[{"zone":"cheek_l"}]'`, [clinic.id]);
    check((side.areas as { points?: { v?: string }[] }[])[0]?.points?.[0]?.v === "left", "with the view it was marked on", JSON.stringify(side.areas));
    await page.reload();
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    check((await page.locator(`[data-face-past='${side.id}']`).count()) === 0, "after, its dot is not on the front");
    check((await page.locator("[data-face-view-tab='left'] span[aria-hidden]").count()) === 1, "the left view says it has points");
    await page.locator("[data-face-view-tab='left']").click();
    check((await page.locator(`[data-face-past='${side.id}']`).count()) === 1, "it is on the left view");
    const wrongView = await page.request.post(`${BASE}/api/c/${slug}/patients/${patient.id}/face/marks`, {
      data: { id: crypto.randomUUID(), eventId: crypto.randomUUID(), treatmentKey: "aes_filler", areas: [{ zone: "cheek_l", points: [{ x: 0.31, y: 0.53, v: "front" }] }] },
    });
    check(wrongView.status() === 400, "a point is checked against the picture it says it was on", String(wrongView.status()));
    await page.locator("[data-face-view-tab='front']").click();

    console.log("A treatment added from the price list");
    await page.goto(`${BASE}/c/${slug}/settings/face-prices`, { timeout: 180000 });
    await page.waitForSelector("[data-face-prices]", { timeout: 120000 });
    await page.locator("[data-face-prices-add]").click();
    await page.locator("[data-face-new-name]").fill("Salmon PDRN");
    await page.locator("[data-face-new-family]").selectOption("skin");
    await page.locator("[data-face-new-save]").click();
    let exo: { key: string } | undefined;
    check(await until(async () => !!(exo = (await q(`select key from aesthetic_treatments where clinic_id = $1 and name = 'Salmon PDRN'`, [clinic.id]))[0])), "Face prices adds a treatment");
    check(await until(async () => (await page.locator(`[data-face-price-row='${exo?.key}']`).count()) === 1), "and lists it at once");
    check(await until(async () => (await page.evaluate("document.activeElement && document.activeElement.getAttribute('data-price-box')")) === exo?.key), "with its price box ready to type in");

    console.log("Archived");
    const r = await page.request.post(`${BASE}/api/c/${slug}/face/treatments`, { data: { op: "archive", key: made.key, archived: true } });
    check(r.ok(), "the treatment is archived");
    await page.goto(chart, { timeout: 180000 });
    await page.waitForSelector("[data-face-map]", { timeout: 120000 });
    check((await page.locator(`[data-face-entry='${mark.id}']`).first().innerText()).includes("Polynucleotides"), "its past entry still names it");
    await tapBeside(page, "neck", -24);
    check((await page.locator(`[data-face-treatment='${made.key}']`).count()) === 0, "but it is not offered any more");
    const again = await page.request.post(`${BASE}/api/c/${slug}/patients/${patient.id}/face/marks`, {
      data: { id: crypto.randomUUID(), eventId: crypto.randomUUID(), treatmentKey: made.key, areas: [{ zone: "neck" }] },
    });
    check(again.status() === 400, "nor accepted", String(again.status()));
    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await q(`delete from clinics where id = $1`, [clinic.id]).catch((e) => console.log("cleanup:", e.message));
    await q(`delete from users where email = $1`, [email]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
