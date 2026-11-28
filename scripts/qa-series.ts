/**
 * Repeating appointments (0126).
 *
 *   - The dates: weekly and monthly on the clinic's calendar, the 31st into a
 *     short month, Arabic's dual ("every 2 weeks" is كل أسبوعين).
 *   - Reception books "every week, 5 times" from the booking panel. Each date
 *     is shown first: one the doctor is busy on goes in at the nearest free
 *     time, a day off and a closed day wait unticked, and the desk ticks the
 *     day off anyway.
 *   - Four visits are booked in one series; the clinic hears once (one
 *     appointment_created); the patient is sent every date in one message.
 *   - Opened, a visit says "2 of 4"; cancelling it offers the rest with it,
 *     and the first one stays.
 *   - The repeat box fits a phone.
 *
 *   npx tsx scripts/qa-series.ts
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { describeSpills, spills } from "./lib-layout";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = process.env.QA_SHOTS_DIR || "";
const TZ = "Asia/Amman";
const ALL_DAYS = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["09:00", "17:00"]]]));

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });
}

async function main() {
  const s = await import("../src/lib/series");
  const { ar } = await import("../src/lib/i18n/ar");
  console.log("\n[the dates]");
  const first = DateTime.fromISO("2027-01-31T10:00", { zone: TZ });
  const monthly = s.seriesStarts(first, { every: 1, unit: "month" }, 3).map((d) => d.toFormat("yyyy-MM-dd HH:mm"));
  check("a month is a calendar month, the 31st into a short one", monthly.join(",") === "2027-01-31 10:00,2027-02-28 10:00,2027-03-31 10:00", monthly.join(","));
  const weekly = s.seriesStarts(first, { every: 2, unit: "week" }, 3).map((d) => d.toFormat("yyyy-MM-dd HH:mm"));
  check("every two weeks keeps the hour", weekly.join(",") === "2027-01-31 10:00,2027-02-14 10:00,2027-02-28 10:00", weekly.join(","));
  check("never more than the most a series books", s.seriesStarts(first, { every: 1, unit: "day" }, 99).length === s.MAX_SERIES);
  check("Arabic says two with the dual", s.repeatLabel({ every: 2, unit: "week" }, ar.series) === "كل أسبوعين" && s.repeatLabel({ every: 4, unit: "week" }, ar.series) === "كل 4 أسابيع");
  check("a rule from the browser is checked", s.parseRepeat({ every: 4, unit: "week" }) !== null && s.parseRepeat({ every: 0, unit: "week" }) === null && s.parseRepeat({ every: 2, unit: "year" }) === null);

  /* ================================================================ fixture */
  const db = new Client({ connectionString: PG });
  await db.connect();
  const stamp = Date.now().toString(36);
  const slug = `qaser${stamp}`;
  const today = DateTime.now().setZone(TZ).startOf("day");
  const d0 = today.plus({ days: 2 });
  const day = (i: number) => d0.plus({ weeks: i }).toISODate()!;
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, working_hours, blocked_dates)
       values ('QA Series','عيادة التكرار',$1,'ar',$2,'JOD',$3,$4) returning id`,
      // The fourth week's day the clinic is shut.
      [slug, TZ, JSON.stringify(ALL_DAYS), JSON.stringify([day(3)])]
    )
  ).rows[0].id as string;
  await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1,'connected')`, [clinicId]);
  const mkUser = async (tag: string, name: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'ar') returning id`,
        [`${tag}-${slug}@test.local`, bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;
  const mkMember = async (userId: string, role: string, perms: unknown, owner = false) =>
    (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,$3,$4,$5) returning id`,
        [clinicId, userId, role, owner, JSON.stringify(perms)]
      )
    ).rows[0].id as string;
  await mkMember(await mkUser("owner", "مالك العيادة"), "other", { level: "full" }, true);
  const doc = await mkMember(await mkUser("doc", "د. ليلى سمارة"), "doctor", { level: "full" });
  await mkMember(await mkUser("desk", "موظفة الاستقبال"), "receptionist", { level: "custom", caps: { dashboard: true, calendar: true, patients: true } });
  const service = (
    await db.query(`insert into services (clinic_id, name, name_ar, duration_min, price, active) values ($1,'Laser','ليزر',30,40,true) returning id`, [clinicId])
  ).rows[0].id as string;
  const mkPatient = async (name: string, phone: string) =>
    (await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1,$2,$3,'staff') returning id`, [clinicId, name, phone])).rows[0].id as string;
  const patient = await mkPatient("رنا خوري", "+962790772201");
  const other = await mkPatient("سامر عيسى", "+962790772202");
  // The second week: the doctor already has somebody at 10:00.
  const busyAt = DateTime.fromISO(`${day(1)}T10:00`, { zone: TZ });
  await db.query(
    `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
     values ($1,$2,$3,$4,$5,$6,'confirmed')`,
    [clinicId, other, doc, service, busyAt.toUTC().toISO(), busyAt.plus({ minutes: 30 }).toUTC().toISO()]
  );
  // The third week: her day off.
  await db.query(`insert into doctor_time_off (clinic_id, member_id, starts_on, ends_on) values ($1,$2,$3,$3)`, [clinicId, doc, day(2)]);

  const browser = await chromium.launch();
  const ctx = async (email: string, viewport = { width: 1360, height: 900 }, touch = false) => {
    const c = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch && viewport.width < 600 });
    const pg = await c.newPage();
    pg.setDefaultNavigationTimeout(180_000);
    pg.setDefaultTimeout(90_000);
    await signIn(pg, email);
    await c.addCookies([{ name: "cos_locale", value: "ar", url: BASE }]);
    return { c, pg };
  };
  const go = async (pg: Page, path: string) => {
    await pg.goto(`${BASE}/c/${slug}${path}`);
    await pg.waitForLoadState("networkidle");
    await pg.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  };
  const openNew = async (pg: Page) => {
    await go(pg, `/calendar?patient=${patient}`);
    const panel = pg.locator('[data-appointment-panel="new"]');
    await panel.waitFor();
    await panel.locator("select[data-add-service]").selectOption(service);
    await panel.locator("select[data-doctor-select]").selectOption(doc);
    await panel.locator('input[type="date"]').fill(day(0));
    await panel.locator('input[type="time"]').fill("10:00");
    return panel;
  };

  try {
    /* ============================================================ booking */
    console.log("\n[reception books every week, five times]");
    const desk = await ctx(`desk-${slug}@test.local`);
    const panel = await openNew(desk.pg);
    await panel.locator("[data-repeat-toggle]").click();
    await panel.locator('[data-repeat-every="1:week"]').click();
    await panel.locator("input[data-repeat-times]").fill("5");
    await panel.locator('[data-repeat-plan="5"]').waitFor();
    // The preview settles a moment after the last change.
    await desk.pg.waitForFunction(
      `(() => { const p = document.querySelector('[data-repeat-plan="5"]'); return !!p && !p.className.includes("opacity-60"); })()`
    );
    const n = async (sel: string) => panel.locator(sel).count();
    check("five dates are shown before anything is booked", (await n("[data-repeat-date]")) === 5);
    check("the busy week is found", (await n('[data-repeat-date="busy"]')) === 1);
    check("and goes in at the nearest free time that day", (await n('[data-repeat-date="busy"][data-repeat-kept="1"]')) === 1);
    const busyText = (await panel.locator('[data-repeat-date="busy"]').innerText()).replace(/\s+/g, " ");
    check("saying who has the time and what it moved from", busyText.includes("سامر عيسى") && busyText.includes("10:00"), busyText);
    check("the day off waits unticked", (await n('[data-repeat-date="off"][data-repeat-kept="0"]')) === 1);
    check("so does the day the clinic is shut", (await n('[data-repeat-date="closed"][data-repeat-kept="0"]')) === 1);
    const save = panel.locator("[data-panel-save]");
    check("the button counts what it will book", (await save.innerText()).includes("3"), await save.innerText());
    // The desk knows the doctor is coming in that day after all.
    await panel.locator('[data-repeat-date="off"] input[type="checkbox"]').check();
    check("ticking the day off adds it", (await save.innerText()).includes("4"), await save.innerText());
    if (SHOTS) await panel.screenshot({ path: `${SHOTS}/series-panel.png` });
    await save.click();

    let rows: { id: string; starts_at: Date; series_id: string }[] = [];
    for (let i = 0; i < 40 && rows.length < 4; i++) {
      await desk.pg.waitForTimeout(500);
      rows = (
        await db.query(`select id, starts_at, series_id from appointments where patient_id = $1 and series_id is not null order by starts_at`, [patient])
      ).rows;
    }
    check("four visits are booked", rows.length === 4, String(rows.length));
    check("all in one series", new Set(rows.map((r) => r.series_id)).size === 1);
    const local = rows.map((r) => DateTime.fromJSDate(r.starts_at).setZone(TZ).toFormat("yyyy-MM-dd HH:mm"));
    check(
      "on the days asked, the busy one at its free time",
      local[0] === `${day(0)} 10:00` && local[1].startsWith(day(1)) && !local[1].endsWith("10:00") && local[2] === `${day(2)} 10:00` && local[3] === `${day(4)} 10:00`,
      local.join(" | ")
    );
    const series = (await db.query(`select every, unit, planned from appointment_series where id = $1`, [rows[0]?.series_id])).rows[0];
    check("the rule is kept with them", series?.every === 1 && series?.unit === "week" && series?.planned === 4, JSON.stringify(series));
    const ids = rows.map((r) => r.id);
    const created = (
      await db.query(`select count(*)::int as n from jobs where clinic_id = $1 and kind = 'trigger:appointment_created' and payload->>'appointmentId' = any($2::text[])`, [clinicId, ids])
    ).rows[0].n;
    check("the clinic hears about the series once", created === 1, String(created));
    const sent = (
      await db.query(
        `select m.body from messages m join conversations cv on cv.id = m.conversation_id
          where cv.clinic_id = $1 and cv.phone_e164 = '+962790772201' and m.direction = 'out' order by m.created_at`,
        [clinicId]
      )
    ).rows.map((r) => r.body as string);
    const list = sent.find((b) => b.includes("مواعيدك في"));
    check("the patient is sent every date in one message", !!list && list.includes("1. ") && list.includes("4. ") && !list.includes("5. "), list?.slice(0, 160));
    check("and only the one", sent.filter((b) => b.includes("مواعيدك في")).length === 1);
    await desk.c.close();

    /* ============================================================ one of them */
    console.log("\n[a visit of the series, opened]");
    const d2 = await ctx(`desk-${slug}@test.local`);
    await go(d2.pg, `/calendar?tab=schedule&date=${day(1)}`);
    await d2.pg.locator(`[data-appt-id="${ids[1]}"]`).click();
    const opened = d2.pg.locator(`[data-appointment-panel="${ids[1]}"]`);
    await opened.waitFor();
    check("it says which of the series it is", (await opened.locator('[data-panel-series="2/4"]').count()) === 1);
    const tag = await d2.pg.locator(`[data-appt-id="${ids[1]}"] [data-appt-series]`).getAttribute("data-appt-series");
    check("and so does its block on the calendar", tag === "2/4", String(tag));
    await opened.locator("footer button").first().click();
    await d2.pg.locator("[data-cancel-series]").waitFor();
    check("cancelling offers the rest with it", (await d2.pg.locator('[data-cancel-series-rest="1"]').count()) === 1);
    await d2.pg.locator('[data-cancel-series-rest="1"]').check();
    await d2.pg.getByRole("dialog").getByRole("button", { name: "إلغاء الموعد" }).click().catch(async () => {
      // The confirm button carries the delete wording; find it by its place if the name differs.
      await d2.pg.getByRole("dialog").locator("button").last().click();
    });
    let statuses: string[] = [];
    for (let i = 0; i < 30; i++) {
      await d2.pg.waitForTimeout(500);
      statuses = (await db.query(`select status from appointments where id = any($1::uuid[]) order by starts_at`, [ids])).rows.map((r) => r.status);
      if (statuses.filter((x) => x === "cancelled").length === 3) break;
    }
    check("this one and the ones after it are cancelled", statuses.slice(1).every((x) => x === "cancelled"), statuses.join(","));
    check("the first one stays", statuses[0] !== "cancelled", statuses[0]);
    await d2.c.close();

    /* ============================================================ phone */
    console.log("\n[on a phone]");
    const ph = await ctx(`desk-${slug}@test.local`, { width: 390, height: 844 }, true);
    const p2 = await openNew(ph.pg);
    await p2.locator("[data-repeat-toggle]").click();
    await p2.locator("[data-repeat-plan]").waitFor();
    const sp = await spills(ph.pg, "[data-repeat-box]");
    check("the repeat box fits a phone", sp.length === 0, describeSpills(sp));
    const chip = await p2.locator('[data-repeat-every="1:week"]').boundingBox();
    check("its choices are thumb-sized", (chip?.height ?? 0) >= 40, `${Math.round(chip?.height ?? 0)}px`);
    if (SHOTS) await ph.pg.screenshot({ path: `${SHOTS}/series-phone.png`, fullPage: false });
    await ph.c.close();
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinicId]);
    await db.query(`delete from users where email like $1`, [`%-${slug}@test.local`]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
