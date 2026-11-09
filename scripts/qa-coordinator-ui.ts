/**
 * The treatment coordinator's screens (a test, behind the opt-in
 * `coordinator` feature — migration 0102), in a browser.
 *
 * A clinic with it: Calendar → Waitlist shows Treatments in Due back's place,
 * with the patient whose next laser session is due, the 30-day counts, Book
 * (opening the booking for them) and Stop following (gone at once, back on
 * Undo). On a phone it fits and its buttons are big enough to tap. Settings →
 * Services offers "Given as a course". A clinic without it sees none of that,
 * and its API answers 403. What the engine then does is qa-recipes' job.
 *
 *   npx tsx scripts/qa-coordinator-ui.ts   (dev server on :3000)
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
const ALL_DAY = JSON.stringify(Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["08:00", "21:00"]]])));

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function until(fn: () => Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 90_000 });
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const made: { clinics: string[]; users: string[] } = { clinics: [], users: [] };
  const today = DateTime.now().setZone(TZ).startOf("day");

  const setup = async (slug: string, coordinator: boolean) => {
    const clinic = (
      await db.query(`insert into clinics (name, slug, timezone, working_hours, features) values ($1, $2, $3, $4, $5) returning id`, [
        `QA Coord ${slug}`,
        slug,
        TZ,
        ALL_DAY,
        JSON.stringify(coordinator ? { coordinator: true } : {}),
      ])
    ).rows[0].id as string;
    made.clinics.push(clinic);
    const user = (
      await db.query(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Desk', 'en') returning id`, [
        `desk-${slug}@test.local`,
        bcrypt.hashSync("password123", 10),
      ])
    ).rows[0].id as string;
    made.users.push(user);
    await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`, [clinic, user]);
    const docUser = (
      await db.query(`insert into users (email, password_hash, full_name, locale) values ($1, 'x', 'Dr Hala', 'en') returning id`, [`doc-${slug}@test.local`])
    ).rows[0].id as string;
    made.users.push(docUser);
    const doctor = (await db.query(`insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'doctor') returning id`, [clinic, docUser])).rows[0].id as string;
    const svc = (
      await db.query(
        `insert into services (clinic_id, name, name_ar, duration_min, price, course_sessions, course_interval_days) values ($1, 'Laser', 'ليزر', 30, 40, 6, 28) returning id`,
        [clinic]
      )
    ).rows[0].id as string;
    const patient = (
      await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Lina Laser', $2, 'staff') returning id`, [
        clinic,
        `+9627${String(Date.now()).slice(-8)}`,
      ])
    ).rows[0].id as string;
    const at = today.minus({ days: 22 }).plus({ hours: 10 });
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status) values ($1, $2, $3, $4, $5, $6, 'completed')`,
      [clinic, patient, doctor, svc, at.toUTC().toISO(), at.plus({ minutes: 30 }).toUTC().toISO()]
    );
    return { clinic, patient, email: `desk-${slug}@test.local` };
  };

  const on = await setup(`qacoord${tag}`, true);
  const off = await setup(`qacoordoff${tag}`, false);
  const browser = await chromium.launch();
  try {
    console.log("\na clinic with the coordinator, on a desktop");
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await signIn(page, on.email);
    await page.goto(`${BASE}/c/qacoord${tag}/calendar?tab=waitlist`);
    const row = page.locator(`[data-treatment-row="${on.patient}"]`);
    check("Treatments takes Due back's place", await until(() => row.isVisible()));
    const text = (await row.innerText().catch(() => "")).replace(/\s+/g, " ");
    check("the patient, which session, and that it is due", text.includes("Lina Laser") && text.includes("Session 2 of 6") && /Due \d/.test(text) && !/Due\s+Session/.test(text), text);
    const stats = (await page.locator("[data-coordinator-stats]").innerText().catch(() => "")).replace(/\s+/g, " ");
    check("the last 30 days are counted", stats.includes("Booked by it") && stats.includes("Enquiries booked"), stats);
    check("no Due back list beside it", (await page.locator("[data-due-back]").count()) === 0);

    await row.locator("[data-treatment-stop]").click();
    check("Stop following takes them off at once", await until(async () => (await row.count()) === 0, 3000));
    const undo = page.getByRole("button", { name: "Undo" });
    check("with Undo", await until(() => undo.isVisible(), 5000));
    await undo.click();
    check("Undo brings them back", await until(() => row.isVisible(), 10_000));
    // The row comes back at once; the stop is deleted a moment later.
    const stopsLeft = async () => (await db.query(`select count(*)::int as n from treatment_follow_stops where patient_id = $1`, [on.patient])).rows[0].n as number;
    check("and leaves no stop behind", await until(async () => (await stopsLeft()) === 0, 10_000), String(await stopsLeft()));

    await row.locator("[data-treatment-book]").click();
    const panel = page.locator("aside", { hasText: "New appointment" }).first();
    check("Book opens the booking", await until(() => panel.isVisible(), 10_000));
    check("for them", (await panel.innerText().catch(() => "")).includes("Lina Laser"));
    await ctx.close();

    console.log("\non a phone");
    const phone = await browser.newContext({ ...devices["iPhone 13"] });
    const pp = await phone.newPage();
    await signIn(pp, on.email);
    await pp.goto(`${BASE}/c/qacoord${tag}/calendar?tab=waitlist`);
    const prow = pp.locator(`[data-treatment-row="${on.patient}"]`);
    check("the list is there", await until(() => prow.isVisible()));
    const overflow = await pp.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    check("nothing runs off the side", Number(overflow) <= 1, String(overflow));
    const heights = await prow.locator("button, a").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    check("its buttons are big enough to tap", heights.length >= 2 && heights.every((h) => h >= 40), heights.join(","));

    await pp.goto(`${BASE}/c/qacoord${tag}/settings/services`, { timeout: 120_000 });
    await pp.waitForLoadState("networkidle");
    await pp.getByRole("button", { name: "Edit" }).first().click();
    const course = pp.locator("[data-service-course]");
    check("Settings → Services offers the course", await until(() => course.isVisible(), 10_000));
    const sessions = await pp.locator("[data-course-sessions]").inputValue().catch(() => "");
    const every = await pp.locator("[data-course-every]").inputValue().catch(() => "");
    check("6 sessions, every 4 weeks, as saved", sessions === "6" && every === "4", `${sessions}/${every}`);
    await phone.close();

    console.log("\na clinic without it");
    const c2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p2 = await c2.newPage();
    await signIn(p2, off.email);
    await p2.goto(`${BASE}/c/qacoordoff${tag}/calendar?tab=waitlist`);
    await p2.waitForLoadState("networkidle");
    await p2.waitForTimeout(1500);
    check("no Treatments list", (await p2.locator("[data-treatments]").count()) === 0);
    const api = await p2.request.get(`${BASE}/api/c/qacoordoff${tag}/treatments`);
    check("its API refuses", api.status() === 403, String(api.status()));
    await p2.goto(`${BASE}/c/qacoordoff${tag}/settings/services`, { timeout: 120_000 });
    await p2.waitForLoadState("networkidle");
    await p2.getByRole("button", { name: "Edit" }).first().click();
    await p2.waitForTimeout(800);
    check("and no course on its services", (await p2.locator("[data-service-course]").count()) === 0);
    await c2.close();
  } finally {
    await browser.close();
    for (const id of made.clinics) await db.query(`delete from clinics where id = $1`, [id]).catch((e) => console.log("cleanup:", e.message));
    for (const id of made.users) await db.query(`delete from users where id = $1`, [id]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e);
  process.exit(1);
});
