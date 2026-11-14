/**
 * Using Clinicti on a phone (2026-11-14): "make the phone view experience
 * better and easier… the loading screen in the phone view does not appear
 * properly… in the dark mode some colours are not well shown, like in the
 * chat… the country code of Palestine does not occur… add the option of
 * choosing the country code".
 *
 *   1. Phone numbers: every place a patient's number is first typed — New
 *      patient, the booking panel's new patient, the public booking page —
 *      has a country picker; Palestine is on it by name; a number pasted with
 *      +970 moves the picker; and the number reaches the database as +970….
 *   2. A tap is answered at once: on a slow connection the tapped tab lights
 *      and a progress line shows before the page arrives, and the fallback
 *      skeleton is a list, not the dashboard's tiles.
 *   3. Dark mode in the chat: the time and the read ticks on a message the
 *      clinic sent can be read against the bubble.
 *   4. The file picker speaks the app's language.
 *   5. The main screens on a phone, light and dark: no page errors, nothing
 *      wider than the screen, no server errors.
 *
 * Runs against a dev server on :3000 with the local database.
 */
import { Client } from "pg";
import { chromium, webkit, devices, type BrowserContext, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = process.env.QA_SHOTS || "";
const HOURS = JSON.stringify(
  Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["08:00", "20:00"]]]))
);

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The dev-mode badge sits in the corner a phone's buttons share, and takes their taps. Not in production. */
const HIDE_DEV_BADGE = `document.addEventListener("DOMContentLoaded", () => {
  const s = document.createElement("style");
  s.textContent = "nextjs-portal{display:none!important}";
  document.head.appendChild(s);
});`;

async function stripHttps(ctx: BrowserContext) {
  await ctx.route("**/*", async (route) => {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    delete headers["strict-transport-security"];
    if (headers["content-security-policy"])
      headers["content-security-policy"] = headers["content-security-policy"].replace(/upgrade-insecure-requests;?/g, "");
    await route.fulfill({ response: res, headers });
  });
}

/**
 * How well `fg` reads on `bg`, as WCAG's contrast ratio. Colours are composited
 * on a canvas, so `oklab(… / 0.65)` and friends come out as the pixel shown.
 * A string, not a function: tsx renames inner functions under page.evaluate.
 */
const contrastJs = (fgSel: string, bgSel: string) => `(() => {
  const fgEl = document.querySelector(${JSON.stringify(fgSel)});
  const bgEl = document.querySelector(${JSON.stringify(bgSel)});
  if (!fgEl || !bgEl) return null;
  const fg = getComputedStyle(fgEl).color;
  const bg = getComputedStyle(bgEl).backgroundColor;
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const x = cv.getContext("2d");
  x.fillStyle = "#808080"; x.fillRect(0, 0, 1, 1);
  x.fillStyle = bg; x.fillRect(0, 0, 1, 1);
  const b = x.getImageData(0, 0, 1, 1).data;
  x.fillStyle = fg; x.fillRect(0, 0, 1, 1);
  const f = x.getImageData(0, 0, 1, 1).data;
  const lum = (p) => { const c = [p[0], p[1], p[2]].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const L1 = lum(f), L2 = lum(b);
  return { ratio: Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100, fg, bg };
})()`;

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const slug = `qaphone${tag}`;
  const email = `owner-${slug}@test.local`;
  const userIds: string[] = [];
  let clinic = "";
  const browsers: { close: () => Promise<void> }[] = [];

  try {
    clinic = (
      await db.query(
        `insert into clinics (name, name_ar, slug, timezone, working_hours, default_locale)
         values ('QA Phone', 'عيادة الهاتف', $1, 'Asia/Amman', $2, 'ar') returning id`,
        [slug, HOURS]
      )
    ).rows[0].id as string;
    const mkUser = async (mail: string, name: string) => {
      const id = (
        await db.query(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'ar') returning id`, [
          mail,
          bcrypt.hashSync("password123", 10),
          name,
        ])
      ).rows[0].id as string;
      userIds.push(id);
      return id;
    };
    const owner = await mkUser(email, "رنا المالكة");
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
      [clinic, owner]
    );
    const docUser = await mkUser(`doc-${slug}@test.local`, "د. عمر");
    const doc = (
      await db.query(`insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'doctor') returning id`, [clinic, docUser])
    ).rows[0].id as string;
    const svc = (
      await db.query(`insert into services (clinic_id, name, name_ar, duration_min, price) values ($1, 'Checkup', 'كشف', 30, 20) returning id`, [clinic])
    ).rows[0].id as string;
    await db.query(`insert into booking_links (clinic_id, slug, min_notice_min) values ($1, $2, 0)`, [clinic, `${slug}-book`]);
    // A WhatsApp conversation with what the clinic sent, for the dark-mode bubbles.
    const pat = (
      await db.query(`insert into patients (clinic_id, full_name, phone_e164) values ($1, 'سارة المصري', '+962790001122') returning id`, [clinic])
    ).rows[0].id as string;
    const conv = (
      await db.query(
        `insert into conversations (clinic_id, phone_e164, patient_id, last_message_at, last_message_preview) values ($1, '+962790001122', $2, now(), 'تمام') returning id`,
        [clinic, pat]
      )
    ).rows[0].id as string;
    for (const [dir, kind, status, body, name, ago] of [
      ["in", "patient", "delivered", "مرحباً، بدي موعد", null, 30],
      ["out", "staff", "read", "أهلاً، الساعة ١١ بتناسبك؟", owner, 20],
      ["out", "ai", "sent", "تم حجز موعدك، نراك غداً", null, 10],
      ["in", "patient", "delivered", "تمام", null, 5],
    ] as const) {
      await db.query(
        `insert into messages (clinic_id, conversation_id, direction, sender_kind, status, body, msg_type, sender_user_id, created_at)
         values ($1, $2, $3, $4, $5, $6, 'text', $7, now() - make_interval(mins => $8))`,
        [clinic, conv, dir, kind, status, body, name, ago]
      );
    }

    const cr = await chromium.launch();
    browsers.push(cr);

    /* ---------------------------------------------------- sign in on a phone */
    const ctx = await cr.newContext({ ...devices["Pixel 7"] });
    await ctx.addInitScript(HIDE_DEV_BADGE);
    const page = await ctx.newPage();
    const errors: string[] = [];
    const serverErrors: string[] = [];
    page.on("pageerror", (e) => errors.push(`${page.url()} :: ${e.message}`));
    page.on("response", (r) => {
      if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(`${BASE}/login`, { timeout: 120000 });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000 });

    /* ------------------------------------------------ 1. New patient: Palestine */
    console.log("\nphone numbers: New patient");
    await page.goto(`${BASE}/c/${slug}/patients?new=1`, { timeout: 120000 });
    const modal = page.locator("[data-new-patient]");
    await modal.waitFor({ timeout: 60000 });
    const country = modal.locator("[data-phone-country]");
    const options = await country.locator("option").allInnerTexts();
    check("the country list names Palestine", options.some((o) => o.includes("فلسطين") && o.includes("+970")), options.slice(0, 5).join(" | "));
    check("and starts on the clinic's own country", (await country.inputValue()) === "JO");
    await modal.locator("[data-new-name]").fill("مريم من نابلس");
    await country.selectOption("PS");
    await modal.locator("[data-new-phone]").fill("0599123456");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-new-patient.png` });
    await modal.locator("[data-new-create]").click();
    await page.waitForURL(/\/patients\/[0-9a-f-]{36}/, { timeout: 30000 }).catch(() => {});
    const p1 = (await db.query(`select phone_e164 from patients where clinic_id = $1 and full_name = 'مريم من نابلس'`, [clinic])).rows[0];
    check("a Palestinian number is saved as +970", p1?.phone_e164 === "+970599123456", JSON.stringify(p1));

    /* -------------------------------- pasting a number with its code moves the picker */
    await page.goto(`${BASE}/c/${slug}/patients?new=1`, { timeout: 120000 });
    await modal.waitFor({ timeout: 60000 });
    await modal.locator("[data-new-phone]").fill("+970 59 912 3457");
    check("a number pasted with +970 picks Palestine by itself", (await modal.locator("[data-phone-country]").inputValue()) === "PS");
    check("and keeps only the local part in the box", (await modal.locator("[data-new-phone]").inputValue()) === "599123457", await modal.locator("[data-new-phone]").inputValue());
    await page.keyboard.press("Escape").catch(() => {});

    /* ------------------------------------- the booking panel's new patient */
    console.log("\nphone numbers: booking an appointment for a new patient");
    await page.goto(`${BASE}/c/${slug}/calendar?tab=schedule&new=1`, { timeout: 120000 });
    const aside = page.locator("aside").last();
    await aside.getByText("إنشاء مريض جديد").click({ timeout: 60000 });
    await aside.locator("input").first().fill("خليل من الخليل");
    await aside.locator("[data-phone-country]").selectOption("PS");
    await aside.locator('input[type="tel"]').fill("0569876543");
    await aside.locator("select[data-add-service]").selectOption(svc);
    await aside.locator("select[data-doctor-select]").selectOption(doc);
    const tomorrow = DateTime.now().setZone("Asia/Amman").plus({ days: 1 });
    await aside.locator('input[type="date"]').fill(tomorrow.toISODate()!);
    await aside.locator('input[type="time"]').fill("11:00");
    await aside.getByRole("button", { name: "حفظ" }).click();
    await page.waitForTimeout(2500);
    const p2 = (await db.query(`select phone_e164 from patients where clinic_id = $1 and full_name = 'خليل من الخليل'`, [clinic])).rows[0];
    check("the booking panel saves +970 too", p2?.phone_e164 === "+970569876543", JSON.stringify(p2));

    /* ------------------------------------------- 2. a tap is answered at once */
    console.log("\nloading: a tap on a slow connection");
    await page.goto(`${BASE}/c/${slug}`, { timeout: 120000 });
    await page.waitForTimeout(3000);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 1500, downloadThroughput: 150000, uploadThroughput: 75000 });
    const tab = page.locator("[data-mobile-tabbar] a").filter({ hasText: "المرضى" });
    await tab.click();
    await page.waitForTimeout(250);
    check("the tapped tab lights up at once", (await tab.getAttribute("aria-current")) === "page");
    check("and a progress line shows", (await page.locator("[data-nav-progress]").count()) === 1);
    await page.waitForTimeout(500);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-loading.png` });
    const tiles = await page.evaluate(`document.querySelectorAll("main .grid.grid-cols-2 > .rounded-card").length`);
    check("the fallback skeleton is a list, not the dashboard's tiles", Number(tiles) === 0 || !(await page.locator("[data-page-loading]").count()), `${tiles} tiles`);
    await page.waitForURL(/\/patients$/, { timeout: 60000 });
    await page.waitForFunction(`!document.querySelector("[data-nav-progress]")`, null, { timeout: 30000 }).catch(() => {});
    check("the line goes once the page is there", (await page.locator("[data-nav-progress]").count()) === 0);
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    /* ---------------------------------------------- 3. dark mode in the chat */
    console.log("\ndark mode: the chat");
    await ctx.addCookies([{ name: "cos_theme", value: "dark", domain: "localhost", path: "/" }]);
    await page.goto(`${BASE}/c/${slug}/conversations?open=${conv}`, { timeout: 120000 });
    await page.waitForSelector('[data-bubble="staff"]', { timeout: 60000 });
    await page.waitForTimeout(800);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-dark-chat.png` });
    const time = (await page.evaluate(contrastJs('[data-bubble="staff"] [data-bubble-time]', '[data-bubble="staff"]'))) as { ratio: number; fg: string; bg: string } | null;
    check("the time on a sent message reads in dark mode", !!time && time.ratio >= 3, JSON.stringify(time));
    const sender = (await page.evaluate(contrastJs('[data-bubble="staff"] > div:first-child', '[data-bubble="staff"]'))) as { ratio: number } | null;
    check("and so does who sent it", !!sender && sender.ratio >= 3, JSON.stringify(sender));
    const tick = (await page.evaluate(contrastJs('[data-bubble="staff"] svg[aria-label]', '[data-bubble="staff"]'))) as { ratio: number } | null;
    check("and the read ticks", !!tick && tick.ratio >= 2.5, JSON.stringify(tick));
    await ctx.addCookies([{ name: "cos_theme", value: "light", domain: "localhost", path: "/" }]);
    await page.goto(`${BASE}/c/${slug}/conversations?open=${conv}`, { timeout: 120000 });
    await page.waitForSelector('[data-bubble="staff"]', { timeout: 60000 });
    const lightTime = (await page.evaluate(contrastJs('[data-bubble="staff"] [data-bubble-time]', '[data-bubble="staff"]'))) as { ratio: number } | null;
    check("and still in light mode", !!lightTime && lightTime.ratio >= 3, JSON.stringify(lightTime));

    /* ------------------------------------------------ 4. the file picker */
    console.log("\nthe file picker");
    await page.goto(`${BASE}/c/${slug}/patients/import`, { timeout: 120000 });
    await page.waitForSelector("text=اختر ملفاً", { timeout: 60000 }).catch(() => {});
    check("it says 'Choose a file' in Arabic", (await page.locator("text=اختر ملفاً").count()) > 0);
    const nativeBox = await page.locator('input[type="file"]').first().boundingBox();
    check("and the browser's English control is not drawn", !!nativeBox && nativeBox.width <= 2, JSON.stringify(nativeBox));

    /* -------------------------------------- 5. the main screens, both themes */
    for (const theme of ["light", "dark"]) {
      console.log(`\nthe main screens on a phone · ${theme}`);
      await ctx.addCookies([{ name: "cos_theme", value: theme, domain: "localhost", path: "/" }]);
      for (const [name, path] of [
        ["dashboard", ""],
        ["appointments", "/calendar"],
        ["schedule", "/calendar?tab=schedule"],
        ["patients", "/patients"],
        ["chat", "/conversations"],
        ["team chat", "/conversations/team"],
        ["invoices", "/invoices"],
        ["settings", "/settings"],
      ]) {
        await page.goto(`${BASE}/c/${slug}${path}`, { timeout: 120000, waitUntil: "commit" });
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(2000);
        const wide = Number(await page.evaluate("document.documentElement.scrollWidth - innerWidth"));
        check(`${name}: nothing wider than the screen`, wide <= 1, `${wide}px over`);
      }
    }
    check("no page errors anywhere", errors.length === 0, errors.slice(0, 3).join(" | "));
    check("no server errors anywhere", serverErrors.length === 0, serverErrors.slice(0, 3).join(" | "));
    await ctx.close();

    /* ------------------------------ the public booking page, on an iPhone */
    console.log("\nphone numbers: the public booking page on an iPhone");
    const wk = await webkit.launch();
    browsers.push(wk);
    const ictx = await wk.newContext({ ...devices["iPhone 14"] });
    await ictx.addInitScript(HIDE_DEV_BADGE);
    await stripHttps(ictx);
    const ip = await ictx.newPage();
    const ierrors: string[] = [];
    ip.on("pageerror", (e) => ierrors.push(e.message));
    await ip.goto(`${BASE}/book/${slug}-book`, { timeout: 120000 });
    await ip.waitForSelector("button.tnum", { timeout: 60000 }).catch(async () => {
      await ip.getByRole("button", { name: /كشف/ }).first().tap();
      await ip.waitForSelector("button.tnum", { timeout: 60000 });
    });
    await ip.locator("button.tnum").first().tap();
    await ip.getByRole("button", { name: "متابعة" }).last().tap();
    await ip.getByPlaceholder("اسمك الكامل").fill("آمنة من رام الله");
    await ip.locator("[data-phone-country]").selectOption("PS");
    check("the booking page offers the country too", (await ip.locator("[data-phone-country]").inputValue()) === "PS");
    await ip.locator('input[type="tel"]').fill("0599555666");
    if (SHOTS) await ip.screenshot({ path: `${SHOTS}/4-booking-phone.png` });
    await ip.getByRole("button", { name: /تأكيد الحجز|إرسال الرمز/ }).last().tap();
    await ip.waitForSelector("text=/تم تأكيد الحجز|تم استلام الطلب/", { timeout: 30000 }).catch(() => {});
    const p3 = (await db.query(`select phone_e164 from patients where clinic_id = $1 and full_name = 'آمنة من رام الله'`, [clinic])).rows[0];
    check("and a patient booking with a Palestinian number is saved as +970", p3?.phone_e164 === "+970599555666", JSON.stringify(p3));
    check("no page errors on the booking page", ierrors.length === 0, ierrors.join(" | "));
    await ictx.close();
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    if (clinic) await db.query(`delete from clinics where id = $1`, [clinic]);
    if (userIds.length) await db.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    await db.end();
  }

  console.log(`\n  phone experience: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
