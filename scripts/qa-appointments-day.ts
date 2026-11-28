/**
 * The Appointments page, as Yamen asked for it on 2026-11-22:
 *
 *  - a tap anywhere on a Patients today card opens the visit — for a doctor too;
 *  - a visit running past its booked time is not painted red ("N min over");
 *  - Due back is a call list that works: overdue and coming up, Call, Book on a
 *    day that has not passed, take somebody off with Undo, and an explanation
 *    when it is empty; its due count is on the Waitlist tab;
 *  - the booking link is a tap away from the page;
 *  - any day can be picked, from Today and from the Schedule's date.
 *
 *   npx tsx scripts/qa-appointments-day.ts
 */
import { Client } from "pg";
import { chromium, devices, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const TZ = "Asia/Amman";
const ALL_DAY = JSON.stringify(
  Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["00:00", "23:59"]]]))
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

async function main() {
  const { notInThePast } = await import("../src/lib/next-visit");
  const db = new Client({ connectionString: PG });
  await db.connect();
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const tag = Date.now().toString(36);
  const slug = `qaday${tag}`;
  const userIds: string[] = [];
  let clinic = "";
  let empty = "";

  console.log("\nnotInThePast");
  const nowMs = DateTime.fromISO("2026-11-22T15:00:00", { zone: TZ }).toMillis();
  const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toISO()!;
  check("a day still ahead is kept", notInThePast(at("2026-11-25T10:00:00"), TZ, nowMs) === at("2026-11-25T10:00:00"));
  check("a gone day at an hour still ahead today: today", DateTime.fromISO(notInThePast(at("2026-11-10T17:30:00"), TZ, nowMs)!).setZone(TZ).toFormat("yyyy-MM-dd HH:mm") === "2026-11-22 17:30");
  check("a gone day at an hour already gone today: tomorrow", DateTime.fromISO(notInThePast(at("2026-11-10T09:00:00"), TZ, nowMs)!).setZone(TZ).toFormat("yyyy-MM-dd HH:mm") === "2026-11-23 09:00");

  try {
    clinic = (
      await one(`insert into clinics (name, slug, timezone, working_hours, default_locale) values ('QA Day', $1, $2, $3, 'en') returning id`, [slug, TZ, ALL_DAY])
    ).id as string;
    empty = (
      await one(`insert into clinics (name, slug, timezone, working_hours, default_locale) values ('QA Day Empty', $1, $2, $3, 'en') returning id`, [`${slug}e`, TZ, ALL_DAY])
    ).id as string;
    const mkUser = async (email: string, name: string) => {
      const id = (
        await one(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [email, bcrypt.hashSync("password123", 10), name])
      ).id as string;
      userIds.push(id);
      return id;
    };
    const deskEmail = `desk-${slug}@test.local`;
    const docEmail = `doc-${slug}@test.local`;
    const desk = await mkUser(deskEmail, "QA Desk");
    await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`, [clinic, desk]);
    await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`, [empty, desk]);
    const docUser = await mkUser(docEmail, "Dr Day");
    const doc = (await one(`insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'doctor') returning id`, [clinic, docUser])).id as string;
    const room = (await one(`insert into clinic_rooms (clinic_id, name, sort) values ($1, 'Room A', 0) returning id`, [clinic])).id as string;
    const svc = (await one(`insert into services (clinic_id, name, duration_min, price) values ($1, 'Checkup', 30, 10) returning id`, [clinic])).id as string;
    await db.query(`insert into booking_links (clinic_id, slug, name) values ($1, $2, 'Main link')`, [clinic, slug]);

    let n = 0;
    const patient = async (name: string) =>
      (await one(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, $2, $3, 'staff') returning id`, [clinic, name, `+9627${83000000 + n++ + Math.floor(Math.random() * 900000)}`])).id as string;
    const now = DateTime.now().setZone(TZ);

    // With the doctor, and past its booked end: no red.
    const pIn = await patient("Long Visit");
    const aIn = (
      await one(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source, arrived_at, seated_at, room_id)
         values ($1, $2, $3, $4, $5, $6, 'confirmed', 'staff', $7, $7, $8) returning id`,
        [clinic, pIn, doc, svc, now.minus({ minutes: 90 }).toUTC().toISO(), now.minus({ minutes: 60 }).toUTC().toISO(), now.minus({ minutes: 85 }).toUTC().toISO(), room]
      )
    ).id as string;
    // Coming later today.
    const pLater = await patient("Later Today");
    const aLater = (
      await one(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source)
         values ($1, $2, $3, $4, $5, $6, 'scheduled', 'staff') returning id`,
        [clinic, pLater, doc, svc, now.plus({ hours: 2 }).toUTC().toISO(), now.plus({ hours: 2, minutes: 30 }).toUTC().toISO()]
      )
    ).id as string;
    // A day to pick.
    const picked = now.plus({ days: 9 }).startOf("day");
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source) values ($1, $2, $3, $4, $5, $6, 'scheduled', 'staff')`,
      [clinic, await patient("Picked Day Patient"), doc, svc, picked.set({ hour: 11 }).toUTC().toISO(), picked.set({ hour: 11, minute: 30 }).toUTC().toISO()]
    );

    // Due back: overdue by six days, due in about twenty, and too far ahead to list.
    const finished = async (name: string, daysAgo: number, nextDays: number) => {
      const p = await patient(name);
      const start = now.minus({ days: daysAgo }).set({ hour: 10, minute: 0 });
      await db.query(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source, finished_at, next_visit_days, handed_off_at)
         values ($1, $2, $3, $4, $5, $6, 'completed', 'staff', $6, $7, $6)`,
        [clinic, p, doc, svc, start.toUTC().toISO(), start.plus({ minutes: 30 }).toUTC().toISO(), nextDays]
      );
      return p;
    };
    const pOver = await finished("Overdue Patient", 20, 14);
    const pSoon = await finished("Soon Patient", 5, 25);
    await finished("Far Patient", 1, 60);

    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, locale: "en-GB" });
      await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
      const page = await ctx.newPage();
      const signIn = async (p: Page, email: string) => {
        await p.context().clearCookies();
        await p.goto(`${BASE}/login`, { timeout: 180000 });
        await p.fill('input[name="email"]', email);
        await p.fill('input[name="password"]', "password123");
        await p.click('button[type="submit"]');
        await p.waitForURL((u) => !u.pathname.includes("login"), { timeout: 420000, waitUntil: "commit" });
      };

      console.log("\nPatients today");
      await signIn(page, deskEmail);
      await page.goto(`${BASE}/c/${slug}/calendar`, { timeout: 180000, waitUntil: "commit" });
      await page.waitForSelector(`[data-flow-card="${aIn}"]`, { timeout: 180000 });
      const inCard = await page.innerText(`[data-flow-card="${aIn}"]`);
      check("with the doctor past the booked end: says how long, not 'over'", /min in/.test(inCard) && !/over/i.test(inCard), inCard.replace(/\s+/g, " ").slice(0, 120));
      const tile = page.locator('[data-room-tile="Room A"]');
      const tileText = await tile.innerText();
      const tileClass = (await tile.getAttribute("class")) ?? "";
      check("and the room tile has no red border or 'over'", !tileClass.includes("danger") && !/over/i.test(tileText), `${tileClass} | ${tileText}`);

      // The service line is plain text on the card, far from any button.
      await page.click(`[data-flow-card="${aLater}"] [data-flow-services]`);
      check("a tap on the card's body opens the visit", await page.waitForSelector('[data-appointment-panel]:has-text("Later Today")', { timeout: 30000 }).then(() => true, () => false));
      check("the visit it opens is this one", (await page.innerText("[data-appointment-panel]")).includes("Later Today"));
      await page.keyboard.press("Escape");
      await page.click("[data-appointment-panel] header button[aria-label]").catch(() => {});
      await page.waitForSelector("[data-appointment-panel]", { state: "detached", timeout: 10000 }).catch(() => {});

      // A menu on the card still opens its menu, not the visit.
      await page.click(`[data-flow-card="${aLater}"] button[aria-haspopup="menu"]`);
      await page.waitForTimeout(400);
      check("the card's ⋯ menu opens the menu, not the visit", (await page.locator("[data-appointment-panel]").count()) === 0 && (await page.locator('[role="menu"]').count()) > 0);
      await page.keyboard.press("Escape");

      console.log("\nthe booking link");
      await page.click('button[aria-label="Booking link"], button:has-text("Booking link")');
      await page.waitForSelector("[data-booking-link-menu]", { timeout: 10000 });
      check("the menu names the link", (await page.innerText("[data-booking-link-menu]")).includes(`/book/${slug}`));
      await page.click('[data-booking-link-menu] [role="menuitem"]:has-text("Copy link")');
      await page.waitForTimeout(500);
      const copied = String(await page.evaluate("navigator.clipboard.readText()"));
      check("Copy link puts the page's address on the clipboard", copied.endsWith(`/book/${slug}`), copied);

      console.log("\npicking a day");
      await page.locator("[data-flow-board] [data-date-pick] input[type=date]").fill(picked.toISODate()!);
      await page.waitForSelector("[data-schedule-date]", { timeout: 60000 });
      const title = await page.innerText("[data-schedule-date]");
      check("from Today, a picked day opens the Schedule on it", title.includes(picked.setLocale("en-GB").toFormat("d LLLL")), title);
      check("with that day's appointments", await page.waitForSelector("text=Picked Day Patient", { timeout: 30000 }).then(() => true, () => false));
      const other = now.plus({ days: 15 });
      await page.locator("[data-date-pick]:has([data-schedule-date]) input[type=date]").fill(other.toISODate()!);
      await page.waitForTimeout(500);
      check("the Schedule's date picks any other day", (await page.innerText("[data-schedule-date]")).includes(other.setLocale("en-GB").toFormat("d LLLL")));

      console.log("\nDue back");
      await page.click('[role="tab"]:has-text("Waitlist")');
      await page.waitForSelector("[data-due-back]", { timeout: 60000 });
      const dueText = await page.innerText("[data-due-back]");
      check("an overdue patient is listed with how late", dueText.includes("Overdue Patient") && /6 days late/.test(dueText), dueText.replace(/\s+/g, " ").slice(0, 200));
      check("one due in three weeks is listed under Coming up", (await page.locator("[data-due-back-soon]").count()) === 1 && dueText.includes("Soon Patient"));
      check("one due in two months is not", !dueText.includes("Far Patient"));
      check("each row has a number to call", (await page.locator(`[data-due-back-row="${pOver}"] [data-due-back-call]`).getAttribute("href"))?.startsWith("tel:"));
      const tabText = await page.innerText('[role="tab"]:has-text("Waitlist")');
      check("the tab counts who is due", /\b1\b/.test(tabText), tabText);

      await page.click(`[data-due-back-row="${pOver}"] [data-due-back-book]`);
      await page.waitForSelector("[data-appointment-panel] input[type=date]", { timeout: 30000 });
      const bookDay = await page.inputValue("[data-appointment-panel] input[type=date]");
      check("Book on an overdue patient opens today or later, not the overdue day", bookDay >= now.toISODate()!, bookDay);
      await page.click("[data-appointment-panel] header button[aria-label]").catch(() => {});
      await page.waitForTimeout(400);

      await page.click(`[data-due-back-row="${pSoon}"] [data-due-back-remove]`);
      // The row goes at once; the write lands when the server answers — on a cold dev server, after a route compiles.
      let dismissed = { next_visit_dismissed_at: null as Date | null, next_visit_dismissed_by: null as string | null };
      for (let i = 0; i < 25 && !dismissed.next_visit_dismissed_at; i++) {
        await page.waitForTimeout(200);
        dismissed = await one(`select next_visit_dismissed_at, next_visit_dismissed_by from appointments where patient_id = $1 and next_visit_days is not null`, [pSoon]);
      }
      check("✕ takes them off the list, and says who did", !!dismissed.next_visit_dismissed_at && dismissed.next_visit_dismissed_by === desk);
      check("and they are gone from the page", (await page.locator(`[data-due-back-row="${pSoon}"]`).count()) === 0);
      await page.click('button:has-text("Undo")');
      let back = false;
      for (let i = 0; i < 20 && !back; i++) {
        back = (await one(`select next_visit_dismissed_at from appointments where patient_id = $1 and next_visit_days is not null`, [pSoon])).next_visit_dismissed_at === null;
        if (!back) await page.waitForTimeout(300);
      }
      check("Undo puts them back", back && (await page.waitForSelector(`[data-due-back-row="${pSoon}"]`, { timeout: 10000 }).then(() => true, () => false)));

      await page.goto(`${BASE}/c/${slug}e/calendar?tab=waitlist`, { timeout: 180000, waitUntil: "commit" });
      await page.waitForSelector("[data-due-back]", { timeout: 120000 });
      check("an empty Due back still shows, and says how patients get onto it", (await page.locator("[data-due-back-empty]").count()) === 1 && (await page.innerText("[data-due-back]")).includes("Come back in"));
      await page.click('button[aria-label="Booking link"], button:has-text("Booking link")');
      await page.waitForSelector("[data-booking-link-menu]", { timeout: 10000 });
      check("a clinic with no booking link is offered to set one up", (await page.innerText("[data-booking-link-menu]")).includes("Set up a booking link"));
      await page.keyboard.press("Escape");

      console.log("\na doctor's board");
      await signIn(page, docEmail);
      await page.goto(`${BASE}/c/${slug}/calendar`, { timeout: 180000, waitUntil: "commit" });
      await page.waitForSelector(`[data-flow-card="${aLater}"]`, { timeout: 180000 });
      await page.click(`[data-flow-card="${aLater}"] [data-flow-open]`);
      check("a doctor's tap opens the visit too, not the file", await page.waitForSelector('[data-appointment-panel]:has-text("Later Today")', { timeout: 30000 }).then(() => true, () => false) && !page.url().includes("/patients/"));

      // A phone: the booking link is in reach there as well.
      const phone = await browser.newContext({ ...devices["Pixel 5"], locale: "en-GB" });
      const pp = await phone.newPage();
      await signIn(pp, deskEmail);
      await pp.goto(`${BASE}/c/${slug}/calendar`, { timeout: 180000, waitUntil: "commit" });
      await pp.waitForSelector("[data-flow-board]", { timeout: 180000 });
      check("on a phone the booking link is in the page's header", await pp.locator('button[aria-label="Booking link"]').isVisible());
      check("and the page fits the phone", (await pp.evaluate("document.scrollingElement.scrollWidth <= window.innerWidth + 1")) as boolean);
      await phone.close();
      await ctx.close();
    } finally {
      await browser.close();
    }
  } finally {
    for (const id of [clinic, empty].filter(Boolean)) await db.query(`delete from clinics where id = $1`, [id]);
    for (const id of userIds) await db.query(`delete from users where id = $1`, [id]).catch(() => {});
    await db.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
