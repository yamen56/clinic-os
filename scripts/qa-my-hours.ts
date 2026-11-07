/**
 * A doctor keeps their own working hours, from their profile.
 *
 * What is proved here:
 *
 *   1. the shape rule — a backwards range, an overlap and a bad time are refused,
 *      and all seven days are always stored, because an empty map would mean
 *      "use the clinic's hours" and open a doctor who closed every day;
 *   2. the page — a doctor reaches it, anybody else is sent back, and a phone
 *      does not scroll sideways;
 *   3. saving — it lands on the doctor's own row and nobody else's, and a part
 *      outside the clinic's hours is named before it is saved;
 *   4. bookings never move — a visit left outside is shown first, stays exactly
 *      where it was, and the desk is told once;
 *   5. a colleague's hours — the staff screen's action refuses the same bad row.
 *
 *   npx tsx scripts/qa-my-hours.ts      (needs the dev stack)
 */
import { chromium, type Browser, type BrowserContext } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { parseWeeklyHours, DAY_KEYS } from "../src/lib/hours";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.QA_BASE || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const CLINIC_HOURS = {
  sun: [["09:00", "17:00"]],
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [],
  sat: [["09:00", "17:00"]],
};

function shapeRules() {
  console.log("\n[the shape of a week]");
  check("a backwards range is refused", parseWeeklyHours({ sun: [["17:00", "09:00"]] }) === null);
  check("an empty range is refused", parseWeeklyHours({ sun: [["09:00", "09:00"]] }) === null);
  check(
    "overlapping ranges are refused",
    parseWeeklyHours({ sun: [["09:00", "13:00"], ["12:00", "17:00"]] }) === null
  );
  check("a cleared time is refused", parseWeeklyHours({ sun: [["", "17:00"]] }) === null);
  check("a bad hour is refused", parseWeeklyHours({ sun: [["25:00", "26:00"]] }) === null);
  check("a list is refused", parseWeeklyHours([]) === null);
  const split = parseWeeklyHours({ sun: [["14:00", "18:00"], ["09:00", "13:00"]] });
  check(
    "a split day is kept, earliest first",
    JSON.stringify(split?.sun) === '[["09:00","13:00"],["14:00","18:00"]]',
    JSON.stringify(split?.sun)
  );
  const cleared = parseWeeklyHours({});
  check(
    "every day is stored even when all are closed",
    !!cleared && DAY_KEYS.every((d) => Array.isArray(cleared[d]) && cleared[d].length === 0)
  );
}

async function main() {
  shapeRules();

  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = `qahours${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, currency, default_locale, invoice_prefix, timezone, working_hours)
       values ('QA Hours', 'ساعات', $1, 'JOD', 'en', 'QAH', 'Asia/Amman', $2) returning id`,
      [tag, JSON.stringify(CLINIC_HOURS)]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

  const emailOf = (who: string) => `${who}-${tag}@test.local`;
  const hash = bcrypt.hashSync("password123", 10);
  const member = async (who: string, name: string, role: string, isOwner = false) => {
    const u = (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`,
        [emailOf(who), hash, name]
      )
    ).rows[0];
    const m = (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner) values ($1, $2, $3, $4) returning id`,
        [clinic.id, u.id, role, isOwner]
      )
    ).rows[0];
    return { userId: u.id as string, memberId: m.id as string };
  };
  const owner = await member("owner", "Owner Person", "doctor", true);
  const desk = await member("desk", "Desk Person", "receptionist");
  const doctor = await member("doctor", "Dr Hours", "doctor");
  const other = await member("other", "Dr Other", "doctor");

  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164) values ($1, 'Late Patient', $2) returning id`,
      [clinic.id, `+96279${Date.now().toString().slice(-7)}`]
    )
  ).rows[0];

  // Next Sunday at 16:00 in the clinic, inside the clinic's hours.
  const now = DateTime.now().setZone("Asia/Amman");
  const sunday = now.plus({ days: ((7 - (now.weekday % 7)) % 7) + 7 }).set({ hour: 16, minute: 0, second: 0, millisecond: 0 });
  const appt = (
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, $5, 'confirmed') returning id, starts_at`,
      [clinic.id, patient.id, doctor.memberId, sunday.toJSDate(), sunday.plus({ minutes: 30 }).toJSDate()]
    )
  ).rows[0];

  const hoursOf = async (memberId: string) =>
    (await db.query(`select working_hours from clinic_members where id = $1`, [memberId])).rows[0].working_hours;
  const deskNotes = async () =>
    (
      await db.query(`select title, body from notifications where user_id = $1 and kind = 'doctor_hours'`, [desk.userId])
    ).rows;

  const browser: Browser = await chromium.launch();
  const errors: string[] = [];
  const session = async (who: string, viewport = { width: 1280, height: 900 }) => {
    const ctx: BrowserContext = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/login`);
    await page.fill('input[type="email"]', emailOf(who));
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30000 });
    return { ctx, page };
  };
  const base = `${BASE}/c/${tag}`;

  console.log("\n[the page]");
  const { ctx, page } = await session("doctor");
  await page.goto(`${base}/profile`);
  check(
    "the profile offers a doctor their hours",
    (await page.locator('a[href$="/profile/hours"]').innerText()).includes("My working hours")
  );
  await page.click('a[href$="/profile/hours"]');
  await page.waitForURL(/\/profile\/hours/);
  check("the clinic's hours are shown", (await page.innerText("body")).includes("Clinic opening hours"));

  const receptionist = await session("desk");
  await receptionist.page.goto(`${base}/profile`);
  check(
    "reception is not offered it",
    (await receptionist.page.locator('a[href$="/profile/hours"]').count()) === 0
  );
  await receptionist.page.goto(`${base}/profile/hours`);
  await receptionist.page.waitForURL((u) => !u.pathname.endsWith("/profile/hours"), { timeout: 15000 });
  check("reception is sent back from the page", receptionist.page.url().endsWith("/profile"), receptionist.page.url());
  await receptionist.ctx.close();

  console.log("\n[saving]");
  await page.locator('button[role="switch"], input[type="checkbox"]').first().click();
  const save = page.getByRole("button", { name: "Save", exact: true });

  // The clinic is shut on Friday: giving a doctor Friday hours must be named.
  await page.getByText("Friday", { exact: true }).locator("..").getByRole("button", { name: "Add hours" }).click();
  check(
    "a day the clinic is shut is named",
    (await page.locator("[data-hours-limits]").innerText()).includes("Friday: the clinic is closed")
  );
  await page.getByText("Friday", { exact: true }).locator("..").getByRole("button", { name: "Delete" }).click();

  // Shorten Sunday to end at 12:00, which leaves the 16:00 visit outside.
  const sundayRow = page.getByText("Sunday", { exact: true }).locator("..");
  await sundayRow.locator('input[type="time"]').nth(1).fill("12:00");
  await save.click();
  await page.locator("[data-hours-clashes]").waitFor({ timeout: 15000 });
  const clash = await page.locator("[data-hours-clashes]").innerText();
  check("a visit left outside is shown first", clash.includes("Late Patient"), clash.replace(/\n/g, " | "));
  check("nothing is saved until the doctor agrees", (await hoursOf(doctor.memberId)) === null);

  await page.getByRole("button", { name: "Save anyway" }).click();
  await page.locator("[data-hours-clashes]").waitFor({ state: "detached", timeout: 15000 });
  await page.waitForFunction(() => document.body.innerText.includes("Your hours are saved"), undefined, {
    timeout: 15000,
  });

  const stored = await hoursOf(doctor.memberId);
  check("the hours land on the doctor's row", JSON.stringify(stored?.sun) === '[["09:00","12:00"]]', JSON.stringify(stored?.sun));
  check("all seven days are stored", DAY_KEYS.every((d) => Array.isArray(stored?.[d])));
  check("a colleague's row is untouched", (await hoursOf(other.memberId)) === null);

  const after = (
    await db.query(`select starts_at, status from appointments where id = $1`, [appt.id])
  ).rows[0];
  check(
    "the booked visit did not move",
    new Date(after.starts_at).getTime() === new Date(appt.starts_at).getTime() && after.status === "confirmed"
  );

  console.log("\n[the desk is told]");
  const told = await deskNotes();
  check("reception hears about it once", told.length === 1, String(told.length));
  check("it names the doctor", told[0]?.title.includes("Dr Hours"), told[0]?.title);
  check("it says a visit is outside", told[0]?.body.includes("1"), told[0]?.body);
  const toldOwner = (
    await db.query(`select count(*)::int as n from notifications where user_id = $1 and kind = 'doctor_hours'`, [owner.userId])
  ).rows[0].n;
  check("the owner hears about it too", toldOwner === 1, String(toldOwner));
  const toldSelf = (
    await db.query(`select count(*)::int as n from notifications where user_id = $1 and kind = 'doctor_hours'`, [doctor.userId])
  ).rows[0].n;
  check("the doctor is not told what they just did", toldSelf === 0, String(toldSelf));

  console.log("\n[back to the clinic's hours]");
  await page.reload();
  await page.locator('button[role="switch"], input[type="checkbox"]').first().click();
  await save.click();
  await page.waitForFunction(() => document.body.innerText.includes("Your hours are saved"), undefined, {
    timeout: 15000,
  });
  check("switching off stores nothing", (await hoursOf(doctor.memberId)) === null);

  console.log("\n[on a phone]");
  await ctx.close();
  const phone = await session("doctor", { width: 360, height: 740 });
  await phone.page.goto(`${base}/profile/hours`);
  await phone.page.locator('button[role="switch"], input[type="checkbox"]').first().click();
  await phone.page.getByText("Sunday", { exact: true }).first().waitFor();
  const width = await phone.page.evaluate("document.documentElement.scrollWidth");
  check("the page does not scroll sideways", (width as number) <= 360, String(width));
  await phone.ctx.close();

  console.log("\n[a colleague's hours]");
  const boss = await session("owner");
  await boss.page.goto(`${base}/settings/staff`);
  await boss.page
    .getByText("Dr Other", { exact: true })
    .locator("xpath=ancestor::*[.//button[@aria-label='Edit']][1]")
    .getByRole("button", { name: "Edit" })
    .click();
  await boss.page.locator("label").filter({ hasText: "Uses clinic hours" }).getByRole("switch").click();
  await boss.page.getByText("Sunday", { exact: true }).locator("..").locator('input[type="time"]').nth(1).fill("08:00");
  await boss.page.getByRole("button", { name: "Save", exact: true }).click();
  await boss.page.waitForFunction(() => document.body.innerText.includes("Check the hours"), undefined, {
    timeout: 15000,
  });
  check("the staff screen refuses a backwards range", (await hoursOf(other.memberId)) === null);
  await boss.ctx.close();

  check("no page errors", errors.length === 0, errors.join(" | "));

  await browser.close();
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where email like $1`, [`%-${tag}@test.local`]);
  await db.end();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
