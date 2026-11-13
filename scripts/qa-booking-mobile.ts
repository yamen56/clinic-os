/**
 * The booking link on phones (2026-11-12): "make sure that the scheduling link
 * works on the mobile version too".
 *
 * A whole booking, by touch, on the phones patients actually hold: iPhones in
 * WebKit (what Safari is), Android in Chromium, from the 320px-wide small ones
 * up. On each, at every step:
 *   - nothing is wider than the screen (no sideways page scroll);
 *   - the step's button is on screen without scrolling to the end;
 *   - every button is big enough for a thumb (40px);
 *   - a field is 16px or more, or iOS zooms the page in when it is tapped;
 *   - the chosen day is in view in the date strip;
 *   - no page errors, and the visit is in the diary at the end.
 * Both looks: the band in the clinic's colour, and the plain white page
 * (`booking_links.brand_header`, 0107) — and the switch itself, flipped from
 * the booking settings on a phone.
 *
 * Runs against a dev server on :3000. WebKit needs HSTS and
 * upgrade-insecure-requests stripped to use http://localhost (see
 * webkit-qa-needs-hsts-stripped in the project notes).
 */
import { Client } from "pg";
import { chromium, webkit, devices, type Browser, type BrowserContext, type Page } from "playwright";
import bcrypt from "bcryptjs";

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

/** WebKit on http://localhost: drop what would send it to https. */
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

/** What a phone can get wrong on one screen. Strings only: tsx renames inner functions. */
async function screenChecks(page: Page, where: string) {
  const r = (await page.evaluate(`(() => {
    const vw = window.innerWidth;
    const wide = document.documentElement.scrollWidth;
    const small = [...document.querySelectorAll("main button, main a[href]")]
      .filter((el) => {
        const b = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return b.width > 0 && b.height > 0 && s.visibility !== "hidden" && b.bottom > 0 && b.top < window.innerHeight * 3;
      })
      .map((el) => ({ h: Math.round(el.getBoundingClientRect().height), t: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24) }))
      .filter((x) => x.h < 40 && !/Clinicti|كلينيكتي|Privacy|الخصوصية/.test(x.t));
    const tiny = [...document.querySelectorAll("main input:not([type=checkbox]), main textarea, main select")]
      .map((el) => parseFloat(getComputedStyle(el).fontSize))
      .filter((px) => px < 16);
    return { vw, wide, small, tiny };
  })()`)) as { vw: number; wide: number; small: { h: number; t: string }[]; tiny: number[] };
  check(`${where}: nothing wider than the screen`, r.wide <= r.vw + 1, `${r.wide}px page on a ${r.vw}px screen`);
  check(`${where}: every button is thumb-sized`, r.small.length === 0, JSON.stringify(r.small.slice(0, 4)));
  check(`${where}: fields are 16px, so iOS does not zoom`, r.tiny.length === 0, JSON.stringify(r.tiny));
}

/** The step's main button is on screen as it is, without scrolling to it. */
async function onScreen(page: Page, name: RegExp, where: string) {
  const btn = page.getByRole("button", { name }).last();
  await btn.waitFor({ timeout: 15000 });
  const box = await btn.boundingBox();
  const vh = page.viewportSize()!.height;
  check(`${where}: "${name.source.split("|")[0]}" is on screen`, !!box && box.y >= 0 && box.y + box.height <= vh + 1, JSON.stringify(box));
  return btn;
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const slug = `qamob${tag}`;
  const userIds: string[] = [];
  let clinic = "";
  const browsers: Browser[] = [];

  try {
    clinic = (
      await db.query(
        `insert into clinics (name, name_ar, slug, timezone, working_hours, default_locale, brand_color, address, address_ar)
         values ('QA Mobile Dental', 'عيادة الهاتف للأسنان', $1, 'Asia/Amman', $2, 'ar', '#0f6e5c',
                 'Amman, Seventh Circle, Zahran Street 42', 'عمان، الدوار السابع، شارع زهران ٤٢') returning id`,
        [slug, HOURS]
      )
    ).rows[0].id as string;
    const mkUser = async (email: string, name: string) => {
      const id = (
        await db.query(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [
          email,
          bcrypt.hashSync("password123", 10),
          name,
        ])
      ).rows[0].id as string;
      userIds.push(id);
      return id;
    };
    const owner = await mkUser(`owner-${slug}@test.local`, "Mobile Owner");
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
      [clinic, owner]
    );
    for (const [i, name] of ["د. عمر الخطيب", "د. لينا حداد"].entries()) {
      const u = await mkUser(`doc${i}-${slug}@test.local`, name);
      await db.query(`insert into clinic_members (clinic_id, user_id, role, specialty) values ($1, $2, 'doctor', 'أسنان')`, [clinic, u]);
    }
    for (const [i, [name, ar, dur]] of (
      [
        ["Cleaning", "تنظيف الأسنان", 30],
        ["Whitening", "تبييض الأسنان", 45],
        ["Checkup", "كشف", 20],
      ] as const
    ).entries()) {
      await db.query(`insert into services (clinic_id, name, name_ar, duration_min, price, sort) values ($1, $2, $3, $4, 25, $5)`, [
        clinic,
        name,
        ar,
        dur,
        i,
      ]);
    }
    // No WhatsApp session, so both links book on the spot (the offline path).
    await db.query(
      `insert into booking_links (clinic_id, slug, name, min_notice_min, headline, headline_ar) values ($1, $2, 'Band', 0, 'Book your visit', 'احجز زيارتك')`,
      [clinic, `${slug}-band`]
    );
    await db.query(
      `insert into booking_links (clinic_id, slug, name, min_notice_min, brand_header, allow_multiple_services) values ($1, $2, 'Plain', 0, false, true)`,
      [clinic, `${slug}-plain`]
    );

    const runs: { device: string; engine: "webkit" | "chromium"; link: "band" | "plain"; english?: boolean }[] = [
      { device: "iPhone SE", engine: "webkit", link: "band" },
      { device: "iPhone 14", engine: "webkit", link: "plain", english: true },
      { device: "iPhone 15 Pro Max", engine: "webkit", link: "band", english: true },
      { device: "Galaxy S9+", engine: "chromium", link: "plain" },
      { device: "Galaxy S24", engine: "chromium", link: "band" },
      { device: "Pixel 7", engine: "chromium", link: "plain", english: true },
    ];
    const wk = await webkit.launch();
    const cr = await chromium.launch();
    browsers.push(wk, cr);
    let n = 0;

    for (const run of runs) {
      n++;
      const who = `${run.device}`;
      console.log(`\n${who} · ${run.link === "band" ? "clinic colour" : "plain white, two services"} · ${run.english ? "English" : "Arabic"}`);
      const ctx = await (run.engine === "webkit" ? wk : cr).newContext({ ...devices[run.device] });
      if (run.engine === "webkit") await stripHttps(ctx);
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const shot = async (step: string) => {
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/m${n}-${run.device.replace(/\W+/g, "")}-${step}.png` });
      };

      await page.goto(`${BASE}/book/${slug}-${run.link}`, { timeout: 90000 });
      await page.waitForSelector("[data-booking-style]", { timeout: 60000 });
      check(`${who}: the ${run.link} look is drawn`, (await page.getAttribute("[data-booking-style]", "data-booking-style")) === run.link);
      if (run.english) {
        await page.getByRole("button", { name: "English" }).tap();
        await page.waitForSelector("text=Step 1 of", { timeout: 10000 });
      }
      await page.waitForTimeout(400);
      await shot("1-services");
      await screenChecks(page, `${who} services`);

      // What to book: one service tapped through, or two ticked on the plain link.
      if (run.link === "plain") {
        const toggles = page.locator("[data-service-toggle]");
        await toggles.nth(0).tap();
        await toggles.nth(1).tap();
        const next = await onScreen(page, /Continue|متابعة/, `${who} services`);
        await next.tap();
      } else {
        await page.getByRole("button", { name: /Cleaning|تنظيف الأسنان/ }).first().tap();
      }

      // Who with: whoever is free.
      await page.getByText(/First available doctor|أول طبيب متاح/).tap();

      // When.
      await page.waitForSelector("button.tnum", { timeout: 30000 });
      await page.waitForTimeout(600);
      await shot("2-time");
      await screenChecks(page, `${who} times`);
      const chosen = (await page.evaluate(`(() => {
        const b = document.querySelector('button[aria-pressed="true"]:has(span.tnum)');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { left: r.left, right: r.right, vw: window.innerWidth };
      })()`)) as { left: number; right: number; vw: number } | null;
      check(`${who} times: the chosen day is in view`, !!chosen && chosen.left >= -1 && chosen.right <= chosen.vw + 1, JSON.stringify(chosen));
      await page.locator("button.tnum").first().tap();
      const toDetails = await onScreen(page, /Continue|متابعة/, `${who} times`);
      await toDetails.tap();

      // Who they are.
      await page.waitForSelector("[data-booking-card]", { timeout: 15000 });
      const name = `Mobile ${tag} ${n}`;
      await page.getByPlaceholder(/Your full name|اسمك الكامل/).tap();
      await page.getByPlaceholder(/Your full name|اسمك الكامل/).fill(name);
      await page.getByPlaceholder("079 000 0000").tap();
      await page.getByPlaceholder("079 000 0000").fill(`0791${String(100000 + n * 7 + (Date.now() % 1000)).slice(0, 6)}`);
      await page.waitForTimeout(300);
      await shot("3-details");
      await screenChecks(page, `${who} details`);
      const book = await onScreen(page, /Confirm booking|تأكيد الحجز|Send code|إرسال الرمز/, `${who} details`);
      await book.tap();

      // Booked.
      const done = await page
        .waitForSelector("text=/Booking confirmed|تم تأكيد الحجز/", { timeout: 30000 })
        .then(() => true)
        .catch(() => false);
      check(`${who}: the booking is confirmed on the phone`, done);
      await page.waitForTimeout(400);
      await shot("4-done");
      await screenChecks(page, `${who} done`);
      const row = (
        await db.query(
          `select a.id, appointment_service_names(a.id, false) as names from appointments a join patients p on p.id = a.patient_id
            where a.clinic_id = $1 and p.full_name = $2`,
          [clinic, name]
        )
      ).rows[0];
      check(`${who}: and it is in the diary`, !!row, name);
      if (run.link === "plain") check(`${who}: with both services`, row?.names === "Cleaning + Whitening", row?.names);
      check(`${who}: no page errors`, errors.length === 0, errors.join(" | "));
      await ctx.close();
    }

    /* --------------------------------------- the switch, from a phone */
    console.log("\nthe switch, in the booking settings on a phone");
    const ctx = await cr.newContext({ ...devices["Pixel 7"] });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/login`, { timeout: 90000 });
    await page.fill('input[name="email"]', `owner-${slug}@test.local`);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 90000 });
    await page.goto(`${BASE}/c/${slug}/settings/booking`, { timeout: 120000 });
    await page.getByRole("button", { name: /^Edit$|^تعديل$/ }).first().tap({ timeout: 60000 });
    const sw = page.locator("[data-brand-header]");
    await sw.scrollIntoViewIfNeeded({ timeout: 15000 });
    check("the colour switch is in the link's settings", await sw.isVisible());
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/m-settings.png` });
    await sw.getByRole("switch").tap();
    const save = page.getByRole("dialog").getByRole("button", { name: /^Save$|^حفظ$/ });
    await save.scrollIntoViewIfNeeded();
    await save.tap();
    await page.waitForSelector("text=/Saved|تم الحفظ/", { timeout: 15000 }).catch(() => {});
    const stored = (await db.query(`select brand_header from booking_links where slug = $1`, [`${slug}-band`])).rows[0];
    check("turning it off is saved", stored?.brand_header === false, JSON.stringify(stored));
    await page.goto(`${BASE}/book/${slug}-band`, { timeout: 90000 });
    await page.waitForSelector("[data-booking-style]", { timeout: 60000 });
    check(
      "and the page is plain white from then on",
      (await page.getAttribute("[data-booking-style]", "data-booking-style")) === "plain"
    );
    check("no page errors in the settings", errors.length === 0, errors.join(" | "));
    await ctx.close();
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    if (clinic) await db.query(`delete from clinics where id = $1`, [clinic]);
    if (userIds.length) await db.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    await db.end();
  }

  console.log(`\n  booking on phones: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
