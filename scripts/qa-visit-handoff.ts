/**
 * The visit, from the chair to the desk (migration 0088).
 *
 * The doctor, on a phone, sees the visit over the patient's file, writes a
 * prescription that is filed under it, and finishes with "in 2 weeks" and a
 * note. Reception is told, the board's card carries the hand-off, Book next
 * opens on the day asked for, and the patient waits on Due back until
 * somebody books them. Skip finishes as Finish always did, and tells nobody.
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

async function until(fn: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
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
  const slug = `qahand${tag}`;
  const userIds: string[] = [];
  const clinic = (
    await db.query(`insert into clinics (name, slug, timezone, working_hours) values ('QA Handoff', $1, $2, $3) returning id`, [slug, TZ, ALL_DAY])
  ).rows[0].id as string;
  const mkUser = async (who: string, name: string) => {
    const id = (
      await db.query(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [
        `${who}-${slug}@test.local`,
        bcrypt.hashSync("password123", 10),
        name,
      ])
    ).rows[0].id as string;
    userIds.push(id);
    return id;
  };
  const ownerUser = await mkUser("owner", "QA Desk");
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`, [clinic, ownerUser]);
  const docUser = await mkUser("doc", "Dr Rana");
  const caps = { level: "custom", caps: { dashboard: true, calendar: true, patients: true, "patients.prescriptions": true } };
  const doc = (
    await db.query(`insert into clinic_members (clinic_id, user_id, role, permissions) values ($1, $2, 'doctor', $3) returning id`, [clinic, docUser, JSON.stringify(caps)])
  ).rows[0].id as string;
  const svc = (await db.query(`insert into services (clinic_id, name, duration_min, price) values ($1, 'Filling', 45, 40) returning id`, [clinic])).rows[0].id as string;
  const mkPatient = async (name: string, phone: string) =>
    (await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, $2, $3, 'staff') returning id`, [clinic, name, phone])).rows[0]
      .id as string;
  const nada = await mkPatient("Nada Haddad", "+962790661101");
  const sami = await mkPatient("Sami Odeh", "+962790661102");
  const inRoom = async (p: string, minsAgo: number) =>
    (
      await db.query(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, arrived_at, seated_at)
         values ($1, $2, $3, $4, now() - make_interval(mins => $5), now() - make_interval(mins => $5) + interval '45 minutes', 'confirmed',
                 now() - make_interval(mins => $5), now() - make_interval(mins => $5 - 2)) returning id`,
        [clinic, p, doc, svc, minsAgo]
      )
    ).rows[0].id as string;
  const visit = await inRoom(nada, 20);
  const visit2 = await inRoom(sami, 10);
  // Booked at Finish, not needed, and another time (2026-11-09).
  const lina = await mkPatient("Lina Saleh", "+962790661103");
  const omar = await mkPatient("Omar Najjar", "+962790661104");
  const huda = await mkPatient("Huda Karam", "+962790661105");
  const visit3 = await inRoom(lina, 15);
  const visit4 = await inRoom(omar, 12);
  const visit5 = await inRoom(huda, 8);

  const browser = await chromium.launch();
  const errors: string[] = [];
  const watch = (p: Page) => p.on("pageerror", (e) => errors.push(e.message));
  const base = `${BASE}/c/${slug}`;

  try {
    /* ============================================================ in the room */
    console.log("\n[the doctor, on a phone, in the room]");
    const phoneCtx = await browser.newContext({ ...devices["iPhone 13"] });
    const ph = await phoneCtx.newPage();
    watch(ph);
    await signIn(ph, `doc-${slug}@test.local`);
    await ph.goto(`${base}/patients/${nada}`);
    await ph.waitForSelector('[data-visit-banner="in_room"]', { timeout: 90_000 });
    check("the file says the patient is with the doctor", (await ph.locator("[data-visit-banner]").innerText()).includes("min"));

    await ph.getByRole("button", { name: "Prescription", exact: true }).first().click();
    await ph.getByRole("dialog").waitFor();
    await ph.getByRole("combobox", { name: "Medicine" }).first().fill("Paracetamol 500mg");
    await ph.getByRole("button", { name: "Send on WhatsApp", exact: true }).click();
    await ph.getByRole("dialog").waitFor({ state: "detached", timeout: 90_000 });
    const rx = (await db.query(`select appointment_id from prescriptions where patient_id = $1`, [nada])).rows;
    check("a prescription written in the room is filed under the visit", rx.length === 1 && rx[0].appointment_id === visit, JSON.stringify(rx));

    await ph.click("[data-visit-finish]");
    await ph.waitForSelector("[data-finish-sheet]", { timeout: 15_000 });
    // Measured once it has risen: it slides up as it opens.
    await ph.waitForTimeout(600);
    const sheet = await ph.locator("[data-finish-sheet] > div").last().boundingBox();
    const vh = ph.viewportSize()?.height ?? 0;
    check("on a phone the sheet rises from the bottom", !!sheet && Math.abs(sheet.y + sheet.height - vh) < 4, JSON.stringify(sheet));
    const chip = await ph.locator('[data-next-days="14"]').boundingBox();
    check("its answers are big enough for a thumb", (chip?.height ?? 0) >= 40, String(chip?.height));
    await ph.click('[data-next-days="14"]');
    await ph.selectOption("[data-next-minutes]", "45");
    await ph.fill("[data-desk-note]", "X-ray before the next visit");
    await ph.click("[data-finish-confirm]");
    const handed = await until(async () => (await db.query(`select handed_off_at from appointments where id = $1`, [visit])).rows[0].handed_off_at !== null);
    const row = (await db.query(`select status, next_visit_days, next_visit_min, desk_note, handed_off_by from appointments where id = $1`, [visit])).rows[0];
    check(
      "Finish records the visit as done, in 2 weeks, 45 minutes, with the note",
      handed && row.status === "completed" && row.next_visit_days === 14 && row.next_visit_min === 45 && row.desk_note === "X-ray before the next visit" && row.handed_off_by === docUser,
      JSON.stringify(row)
    );
    check("and the banner goes", await until(async () => (await ph.locator("[data-visit-banner]").count()) === 0));
    const sideways = (await ph.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")) as number;
    check("nothing on the phone scrolls sideways", sideways <= 0, String(sideways));
    await phoneCtx.close();

    /* ============================================================ the desk is told */
    console.log("\n[reception is told]");
    const notes = (await db.query(`select user_id, title, body, url from notifications where clinic_id = $1 and kind = 'visit_handoff'`, [clinic])).rows;
    const mine = notes.find((n) => n.user_id === ownerUser);
    check("the desk gets the hand-off", !!mine && mine.title.includes("Dr Rana finished with Nada Haddad"), JSON.stringify(notes));
    check("saying when, and the note", !!mine && mine.body.includes("2 weeks") && mine.body.includes("X-ray"), mine?.body);
    check("landing on the visit", !!mine && mine.url.endsWith(`?open=${visit}`), mine?.url);
    check("and not the doctor who finished it", !notes.some((n) => n.user_id === docUser));

    /* ============================================================ the board */
    console.log("\n[the board carries it to checkout]");
    const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(desk);
    await signIn(desk, `owner-${slug}@test.local`);
    await desk.goto(`${base}/calendar?tab=today`);
    const card = desk.locator(`[data-flow-card="${visit}"]`);
    await card.waitFor({ timeout: 90_000 });
    const handoff = await card.locator("[data-flow-handoff]").innerText();
    check("the finished card says the next visit is not booked yet, and the note", handoff.includes("Not booked yet — next visit in 2 weeks") && handoff.includes("X-ray"), handoff);
    await card.locator("[data-flow-book-next]").click();
    const booking = desk.locator("aside", { hasText: "New appointment" });
    await booking.waitFor({ timeout: 30_000 });
    const expected = DateTime.now().setZone(TZ).plus({ days: 14 }).toISODate();
    const dates = await booking.locator('input[type="date"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    check("Book next opens on the day the doctor asked for", dates.includes(expected!), `${dates.join(",")} vs ${expected}`);
    check("with the patient in it", (await booking.innerText()).includes("Nada Haddad"));
    await desk.keyboard.press("Escape");

    await desk.goto(`${base}/calendar?open=${visit}`);
    await desk.waitForSelector("[data-panel-checkout]", { timeout: 60_000 });
    const panel = await desk.locator("[data-panel-checkout]").innerText();
    check("the visit opened from the Schedule offers the same next steps", panel.includes("next visit in 2 weeks") && panel.includes("Create invoice"), panel);

    /* ============================================================ due back */
    console.log("\n[due back until somebody books]");
    await db.query(`update appointments set finished_at = now() - interval '20 days', starts_at = now() - interval '20 days', ends_at = now() - interval '20 days' + interval '45 minutes' where id = $1`, [visit]);
    await desk.goto(`${base}/calendar?tab=waitlist`);
    const due = desk.locator(`[data-due-back-row="${nada}"]`);
    check("an overdue patient is on Due back", await until(async () => (await due.count()) === 1, 60_000));
    check("saying how late", (await due.innerText()).includes("days late"), await due.innerText().catch(() => ""));
    await desk.goto(base);
    await desk.waitForSelector("[data-today-list], main", { timeout: 60_000 });
    check("the dashboard counts them", (await desk.locator("main").innerText()).includes("Due back"));
    await desk.goto(`${base}/calendar?tab=waitlist`);
    await due.waitFor({ timeout: 60_000 });
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, now() + interval '3 days', now() + interval '3 days 45 minutes', 'scheduled')`,
      [clinic, nada, doc, svc]
    );
    check("booking them takes them off, live", await until(async () => (await due.count()) === 0, 30_000));

    /* ============================================================ skip */
    console.log("\n[Skip finishes as Finish always did]");
    const docDesk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(docDesk);
    await signIn(docDesk, `doc-${slug}@test.local`);
    await docDesk.goto(base);
    await docDesk.waitForSelector(`[data-today-row="${visit2}"] [data-today-action="finished"]`, { timeout: 90_000 });
    await docDesk.click(`[data-today-row="${visit2}"] [data-today-action="finished"]`);
    await docDesk.waitForSelector("[data-finish-sheet]", { timeout: 15_000 });
    await docDesk.click("[data-finish-skip]");
    const skipped = await until(async () => (await db.query(`select status from appointments where id = $1`, [visit2])).rows[0].status === "completed");
    const r2 = (await db.query(`select handed_off_at, next_visit_days from appointments where id = $1`, [visit2])).rows[0];
    check("Skip finishes the visit with nothing handed on", skipped && r2.handed_off_at === null && r2.next_visit_days === null, JSON.stringify(r2));
    const told = (await db.query(`select count(*)::int as n from notifications where clinic_id = $1 and kind = 'visit_handoff'`, [clinic])).rows[0].n;
    check("and tells nobody", told === 1, String(told));

    /* ============================================================ book it at Finish */
    console.log("\n[the next visit booked as the visit is finished]");
    await docDesk.goto(base);
    await docDesk.waitForSelector(`[data-today-row="${visit3}"] [data-today-action="finished"]`, { timeout: 90_000 });
    await docDesk.click(`[data-today-row="${visit3}"] [data-today-action="finished"]`);
    await docDesk.waitForSelector("[data-finish-sheet]", { timeout: 15_000 });
    check("before a when is chosen, nothing offers to book", (await docDesk.locator("[data-finish-book]").count()) === 0);
    await docDesk.click('[data-next-days="14"]');
    const slot = docDesk.locator("[data-book-slot]").first();
    check("choosing 2 weeks offers free times to book", await slot.waitFor({ timeout: 30_000 }).then(() => true, () => false));
    const slotAt = (await slot.getAttribute("data-book-slot")) ?? "";
    const slotDay = DateTime.fromISO(slotAt).setZone(TZ).toISODate();
    check("from the day asked for", !!slotDay && slotDay >= DateTime.now().setZone(TZ).plus({ days: 14 }).toISODate()!, `${slotDay}`);
    check("beside Another time and Not now", (await docDesk.locator("[data-book-other]").count()) === 1 && (await docDesk.locator("[data-book-later]").count()) === 1);
    await docDesk.fill("[data-desk-note]", "Bring the old x-ray");
    await slot.click();
    const confirm = await docDesk.locator("[data-finish-confirm]").innerText();
    check("the button says it will finish and book", confirm.includes("Finish and book"), confirm);
    await docDesk.click("[data-finish-confirm]");
    const nextAppt = async () =>
      (
        await db.query(
          `select id, starts_at, ends_at, doctor_member_id, service_id, status from appointments where patient_id = $1 and starts_at > now() order by starts_at limit 1`,
          [lina]
        )
      ).rows[0];
    check("the next visit is booked", await until(async () => !!(await nextAppt())));
    const nx = await nextAppt();
    check(
      "at the time picked, with the doctor, for the service, 45 minutes",
      !!nx &&
        new Date(nx.starts_at).toISOString() === new Date(slotAt).toISOString() &&
        nx.doctor_member_id === doc &&
        nx.service_id === svc &&
        (new Date(nx.ends_at).getTime() - new Date(nx.starts_at).getTime()) / 60000 === 45,
      JSON.stringify(nx)
    );
    const v3 = (await db.query(`select status, next_visit_days from appointments where id = $1`, [visit3])).rows[0];
    check("and the visit is finished, asking for 2 weeks", v3.status === "completed" && v3.next_visit_days === 14, JSON.stringify(v3));
    const told3 = (await db.query(`select body from notifications where clinic_id = $1 and kind = 'visit_handoff' and url like $2`, [clinic, `%${visit3}`])).rows;
    check(
      "the desk is told it is booked, not asked to book it",
      told3.length === 1 && told3[0].body.includes("Next visit booked") && told3[0].body.includes("Bring the old x-ray") && !told3[0].body.includes("Book the next visit"),
      JSON.stringify(told3)
    );
    await desk.goto(`${base}/calendar?tab=today`);
    const card3 = desk.locator(`[data-flow-card="${visit3}"]`);
    await card3.waitFor({ timeout: 90_000 });
    const booked3 = card3.locator('[data-flow-next="booked"]');
    check("the Finished card records it booked", await until(async () => (await booked3.count()) === 1, 30_000));
    check(
      "and says when",
      (await booked3.innerText().catch(() => "")).includes(DateTime.fromISO(slotAt).setZone(TZ).setLocale("en-GB").toFormat("d LLL")),
      await booked3.innerText().catch(() => "")
    );

    console.log("\n[not needed, said and kept]");
    const card4 = desk.locator(`[data-flow-card="${visit4}"]`);
    await card4.locator('[data-flow-action="finished"]').click();
    await desk.waitForSelector("[data-finish-sheet]", { timeout: 15_000 });
    await desk.click('[data-next-days="none"]');
    await desk.click("[data-finish-confirm]");
    check(
      "Not needed is kept on the visit",
      await until(async () => (await db.query(`select next_visit_none from appointments where id = $1`, [visit4])).rows[0].next_visit_none === true)
    );
    check("and the Finished card says no further visit is needed", await until(async () => (await card4.locator('[data-flow-next="none"]').count()) === 1, 30_000));
    check("with nobody booked for them", (await db.query(`select 1 from appointments where patient_id = $1 and starts_at > now()`, [omar])).rowCount === 0);

    console.log("\n[another time: finished, and the booking opens on the day]");
    const card5 = desk.locator(`[data-flow-card="${visit5}"]`);
    await card5.locator('[data-flow-action="finished"]').click();
    await desk.waitForSelector("[data-finish-sheet]", { timeout: 15_000 });
    await desk.click('[data-next-days="30"]');
    await desk.locator("[data-book-other]").waitFor({ timeout: 30_000 });
    await desk.click("[data-book-other]");
    const booking5 = desk.locator("aside", { hasText: "New appointment" });
    check("Another time opens the booking", await booking5.waitFor({ timeout: 30_000 }).then(() => true, () => false));
    const dates5 = await booking5.locator('input[type="date"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    const in30 = DateTime.now().setZone(TZ).plus({ days: 30 }).toISODate()!;
    check("on the day a month from now", dates5.includes(in30), `${dates5.join(",")} vs ${in30}`);
    check("for the patient", (await booking5.innerText()).includes("Huda Karam"));
    const v5 = (await db.query(`select status, next_visit_days from appointments where id = $1`, [visit5])).rows[0];
    check("with the visit already finished", v5.status === "completed" && v5.next_visit_days === 30, JSON.stringify(v5));
    await desk.keyboard.press("Escape");
    check("until it is booked, the card says it is not", await until(async () => (await card5.locator('[data-flow-next="not_booked"]').count()) === 1, 30_000));

    check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await browser.close();
  } finally {
    await db.query(`delete from clinics where id = $1`, [clinic]);
    await db.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    await db.end();
  }

  console.log(`\n  visit hand-off: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
