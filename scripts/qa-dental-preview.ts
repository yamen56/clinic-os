/**
 * The dental chart preview (Phase 0): only the Clinicti team sees it, it draws,
 * it answers taps, and it writes nothing.
 *
 * Also the camera for the go/no-go decision: screenshots at phone, iPad and
 * desktop widths, in Arabic and English, land in scripts/qa-shots/dental/.
 *
 * Run against a warm dev server (`npm run qa-warm` first).
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "dental");

let passed = 0;
let failed = 0;
const ok = (m: string) => {
  passed++;
  console.log(`  ✓ ${m}`);
};
const fail = (m: string) => {
  failed++;
  console.log(`  ✗ ${m}`);
};

async function signIn(browser: Browser, email: string, lang: "ar" | "en", viewport: { width: number; height: number }, touch = false): Promise<Page> {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch && viewport.width < 700, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: "cos_locale", value: lang, url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 240000, waitUntil: "commit" });
  return page;
}

async function openChart(page: Page, url: string) {
  await page.goto(url, { timeout: 120000 });
  await page.waitForSelector("[data-dental-chart] [data-tooth='16']", { timeout: 120000 });
  // Let the sample mouth land and its pop animations finish.
  await page.waitForTimeout(700);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const slug = `qadent${tag}`;
  const hash = bcrypt.hashSync("password123", 10);

  const clinic = (await db.query(`insert into clinics (name, name_ar, slug, specialty) values ('QA Dental','عيادة الأسنان',$1,'dental') returning id`, [slug])).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const admin = (
    await db.query(
      `insert into users (email, password_hash, full_name, is_super_admin, admin_permissions, locale) values ($1,$2,'Yamen QA',true,'{"level":"full"}','ar') returning id`,
      [`dent-admin-${tag}@test.local`, hash]
    )
  ).rows[0];
  const doctor = (await db.query(`insert into users (email, password_hash, full_name, locale) values ($1,$2,'د. ليلى منصور','en') returning id`, [`dent-doc-${tag}@test.local`, hash])).rows[0];
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'doctor',true,'{"level":"full"}')`, [clinic.id, doctor.id]);
  const adult = (
    await db.query(`insert into patients (clinic_id, full_name, birth_date, source) values ($1,'رامي الخطيب','1988-03-14','staff') returning id`, [clinic.id])
  ).rows[0].id as string;
  const child = (
    await db.query(`insert into patients (clinic_id, full_name, birth_date, source) values ($1,'جود الخطيب','2017-06-02','staff') returning id`, [clinic.id])
  ).rows[0].id as string;
  const fileUrl = (id: string) => `${BASE}/c/${slug}/patients/${id}?tab=dental`;

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    /* ── The screenshots Yamen decides on ─────────────────────────────── */
    const views = [
      { name: "desktop", viewport: { width: 1440, height: 1000 }, touch: false },
      { name: "ipad-landscape", viewport: { width: 1180, height: 820 }, touch: true },
      { name: "ipad-portrait", viewport: { width: 820, height: 1180 }, touch: true },
      { name: "phone-390", viewport: { width: 390, height: 844 }, touch: true },
      { name: "phone-320", viewport: { width: 320, height: 640 }, touch: true },
    ];
    // One sign-in per language, the window resized for each size: a dozen
    // sign-ins in a row from one address is what the login throttle is for.
    let page: Page | null = null;
    for (const lang of ["ar", "en"] as const) {
      // Sign-in applies the account's own language over the cookie.
      await db.query(`update users set locale = $1 where id = $2`, [lang, admin.id]);
      if (page) await page.context().close();
      page = await signIn(browser, `dent-admin-${tag}@test.local`, lang, views[0].viewport);
      const p = page;
      p.on("pageerror", (e) => errors.push(`[${lang}] ${e.message}`));
      for (const v of views) {
        const page = p;
        await page.setViewportSize(v.viewport);
        await openChart(page, fileUrl(adult));
        await page.screenshot({ path: join(SHOTS, `${lang}-${v.name}-chart.png`), fullPage: true });
        // Page width must not exceed the viewport (no sideways scroll on a phone).
        const overflow = Number(await page.evaluate("document.documentElement.scrollWidth - window.innerWidth"));
        if (overflow > 1) fail(`${lang} ${v.name}: page scrolls sideways by ${overflow}px`);
        // A phone shows half the mouth at a time; 36 is on the patient's left.
        if (v.viewport.width < 640) await page.getByRole("radio", { name: "Patient's left" }).click();
        await page.locator("[data-dental-chart] [data-tooth='36']").first().click();
        await page.waitForTimeout(450);
        await page.screenshot({ path: join(SHOTS, `${lang}-${v.name}-tooth36.png`), fullPage: v.viewport.width >= 860 });
        if (lang === "ar" && v.name === "desktop") {
          // The chart speaks English inside an Arabic workspace, left to right.
          const chart = await page.locator("[data-dental-chart]").innerText();
          const dir = await page.locator("[data-latin-island]").first().getAttribute("dir");
          const tabs = await page.locator('[role="tablist"]').first().innerText();
          // Doctors' own names may be Arabic; the chart's words may not.
          const arabicTerms = /تسوس|علاج عصب|الرحى|مخطط|منجز|العمل المتبقي/;
          if (/Lower left first molar/.test(chart) && /Remaining work/.test(chart) && !arabicTerms.test(chart) && dir === "ltr")
            ok("on an Arabic screen the chart is English and left-to-right");
          else fail(`Arabic screen: chart dir=${dir}, text starts ${chart.slice(0, 200)}`);
          if (tabs.includes("Dental chart") && tabs.includes("نظرة عامة")) ok("the tab is named in English among Arabic tabs");
          else fail(`tab strip: ${tabs}`);
        }
        if (lang === "en" && v.name === "phone-390") {
          // The panel docks below without dimming the chart, and the tooth stays in view above it.
          const sheet = await page.locator("[data-dental-sheet]").count();
          const modal = await page.locator('[role="dialog"][aria-modal="true"]').count();
          const box = await page.locator("[data-dental-chart] svg [data-tooth='36']").first().boundingBox();
          const openTop = v.viewport.height * (1 - 0.56);
          if (sheet === 1 && modal === 0) ok("on a phone the tooth panel docks at the bottom without covering the page");
          else fail(`phone: sheet=${sheet} modal=${modal}`);
          if (box && box.y >= 0 && box.y + box.height <= openTop + 4) ok("on a phone the tapped tooth stays in view above the panel");
          else fail(`phone: tooth 36 at ${box ? `${Math.round(box.y)}–${Math.round(box.y + box.height)}` : "nowhere"}, open area ends at ${Math.round(openTop)}`);
        }
      }
    }
    ok("screenshots taken in Arabic and English at five sizes");

    /* ── Behaviour, in English so the text can be asserted ───────────── */
    page = page!;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openChart(page, fileUrl(adult));

    const tabs = (await page.locator('[role="tablist"]').first().innerText()).replace(/\s+/g, " ");
    if (tabs.includes("Dental chart")) ok("super-admin sees the Dental chart tab");
    else fail(`super-admin tab strip lacks Dental chart: ${tabs}`);

    // Whole-mouth work is a small mouth with its part lit, and points at the chart.
    const scalingCard = page.locator("[data-mouth-mark='scaling']");
    if ((await scalingCard.locator("svg rect").count()) >= 16) ok("a whole-mouth treatment is drawn as a mouth, not a chip");
    else fail("the scaling card has no mouth drawing");
    await scalingCard.hover();
    if ((await page.locator("[data-dental-chart] svg [data-highlight='mouth']").count()) === 1) ok("pointing at a whole-mouth card outlines the mouth on the chart");
    else fail("no outline on the chart while hovering the scaling card");
    await page.mouse.move(5, 5);

    // No coloured dots: the x-ray on 36 is an icon badge, the legend shows drawn swatches.
    if ((await page.locator("[data-dental-chart] svg [data-tooth='36'] [data-badge]").count()) === 1) ok("work with no shape on a tooth shows as an icon badge by its number");
    else fail("tooth 36 has no badge for its periapical x-ray");
    const legendSwatches = await page.locator("[data-dental-chart] button[aria-pressed] svg path").count();
    if (legendSwatches >= 4) ok("the legend shows a drawn tooth for each status");
    else fail(`legend swatches: ${legendSwatches}`);

    // At a desk, arrows walk the arch and Escape puts the tooth down.
    await page.locator("[data-dental-chart] svg [data-tooth='36']").first().click();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    const walked = await page.locator("[data-dental-chart] svg [data-tooth='27'][aria-pressed='true']").count();
    if (walked === 1) ok("arrow keys move from 36 to 37 and up to 27");
    else fail("arrow keys did not land on 27");
    await page.keyboard.press("Escape");
    if ((await page.locator("[data-dental-panel]").count()) === 0) ok("Escape closes the tooth panel");
    else fail("the panel stayed open after Escape");

    // Tooth first: 47, surfaces O and M, then a composite filling, done.
    const panel = page.locator("[data-dental-panel]").first();
    await page.locator("[data-dental-chart] svg [data-tooth='47']").first().click();
    await panel.locator("[data-surface-chip='O']").click();
    await panel.locator("[data-surface-chip='M']").click();
    await panel.locator("[data-treatment='filling_composite']").first().click();
    await page.waitForTimeout(300);
    const onTooth = await panel.innerText();
    if (/Composite filling · MO/.test(onTooth)) ok("tapping surfaces then a treatment records it on the tooth (MO)");
    else fail(`panel does not list the new MO filling: ${onTooth.slice(0, 400)}`);
    const layerCount = await page.locator("[data-dental-chart] svg [data-tooth='47'] .tooth-pop").count();
    if (layerCount > 0) ok("the filling is drawn on tooth 47");
    else fail("tooth 47 shows no drawn layer");

    // A surface treatment with no surface chosen is refused, not guessed.
    await page.locator("[data-dental-chart] svg [data-tooth='44']").first().click();
    await panel.locator("[data-treatment='filling_composite']").first().click();
    await page.waitForTimeout(200);
    if ((await panel.locator("[data-mark]").count()) === 0) ok("a filling with no surface chosen is not recorded");
    else fail("a filling was recorded on 44 with no surfaces");

    // Extraction done: the tooth becomes a ghost.
    await panel.locator("[data-treatment='extraction']").first().click();
    await page.waitForTimeout(250);
    if ((await page.locator("[data-dental-chart] svg [data-tooth='44'][data-gone]").count()) > 0) ok("a done extraction leaves tooth 44 as a ghost");
    else fail("tooth 44 still drawn after a done extraction");

    // Undo takes the last tap back.
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForTimeout(250);
    if ((await page.locator("[data-dental-chart] svg [data-tooth='44'][data-gone]").count()) === 0) ok("undo brings tooth 44 back");
    else fail("undo did not bring tooth 44 back");

    // Favourites are the clinic's, and say who added them.
    const star = panel.locator("[data-treatment='filling_composite']").first().locator("xpath=..").locator("button[aria-pressed]");
    const title = (await star.getAttribute("title")) ?? "";
    if (/Added by Dr\. Sara Haddad/.test(title)) ok("a favourite says who added it");
    else fail(`favourite title: ${title}`);

    // Brush: missing on 28 and 38.
    await page.getByRole("radio", { name: "Brush" }).click();
    // "Missing" is a finding: it lives behind the picker's second tab.
    await page.locator("[data-dental-panel]").getByRole("tab", { name: "Findings" }).click();
    await page.locator("[data-dental-panel] [data-treatment='missing']").first().click();
    await page.locator("[data-dental-chart] svg [data-tooth='28']").first().click();
    await page.locator("[data-dental-chart] svg [data-tooth='37']").first().click();
    await page.waitForTimeout(250);
    const gone28 = await page.locator("[data-dental-chart] svg [data-tooth='28'][data-gone]").count();
    const gone37 = await page.locator("[data-dental-chart] svg [data-tooth='37'][data-gone]").count();
    if (gone28 && gone37) ok("brush paints 'missing' on two teeth with two taps");
    else fail(`brush: 28 gone=${gone28} 37 gone=${gone37}`);
    await page.locator("[data-dental-chart] svg [data-tooth='37']").first().click();
    await page.waitForTimeout(250);
    if ((await page.locator("[data-dental-chart] svg [data-tooth='37'][data-gone]").count()) === 0) ok("a second dab on the same tooth takes it off again");
    else fail("second brush tap did not remove 'missing' from 37");
    await page.screenshot({ path: join(SHOTS, "en-desktop-after-flow.png"), fullPage: true });

    // Time slider: the first visit shows 46 still in the mouth, today it is gone.
    await page.getByRole("radio", { name: "Tooth" }).click();
    const slider = page.locator("[data-dental-chart] input[type='range']");
    await slider.focus();
    await slider.press("Home");
    await page.waitForTimeout(300);
    const pastGone = await page.locator("[data-dental-chart] svg [data-tooth='46'][data-gone]").count();
    await page.screenshot({ path: join(SHOTS, "en-desktop-first-visit.png"), fullPage: true });
    await slider.press("End");
    await page.waitForTimeout(300);
    const nowGone = await page.locator("[data-dental-chart] svg [data-tooth='46'][data-gone]").count();
    if (pastGone === 0 && nowGone > 0) ok("the time slider shows 46 before its extraction and gone today");
    else fail(`slider: first visit gone=${pastGone}, today gone=${nowGone}`);

    // Child: primary teeth by age.
    await openChart(page, fileUrl(child));
    if ((await page.locator("[data-dental-chart] svg [data-tooth='55']").count()) > 0) ok("a 9-year-old opens on mixed dentition with primary teeth");
    else fail("child file shows no primary teeth");
    await page.screenshot({ path: join(SHOTS, "en-desktop-child-mixed.png"), fullPage: true });
    await page.context().close();

    /* ── Nobody else sees it ──────────────────────────────────────────── */
    const doc = await signIn(browser, `dent-doc-${tag}@test.local`, "en", { width: 1440, height: 900 });
    await doc.goto(fileUrl(adult), { timeout: 120000 });
    await doc.waitForSelector('[role="tablist"]', { timeout: 120000 });
    const docTabs = await doc.locator('[role="tablist"]').first().innerText();
    if (!docTabs.includes("Dental chart")) ok("a clinic doctor does not see the preview tab");
    else fail("a clinic doctor sees the Dental chart preview");
    if ((await doc.locator("[data-dental-chart]").count()) === 0) ok("?tab=dental falls back to the overview for a clinic doctor");
    else fail("the chart rendered for a clinic doctor");
    await doc.context().close();

    // And the preview wrote nothing anywhere.
    const audit = await db.query(`select count(*)::int as n from audit_log where clinic_id = $1 and action like 'dental%'`, [clinic.id]);
    if (audit.rows[0].n === 0) ok("nothing was written to the database");
    else fail(`${audit.rows[0].n} dental audit rows appeared`);

    if (errors.length === 0) ok("no page errors");
    else for (const e of errors) fail(`page error ${e}`);
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = any($1::uuid[])`, [[admin.id, doctor.id]]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed · screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
