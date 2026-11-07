/**
 * The team chat (0093).
 *
 * Yamen, 2026-11-07: "an internal team chat, the clinic team can chat with each
 * other, so the team members get notified when the other team members need
 * something". One room for everybody, private threads, groups, files and voice.
 *
 * - Privacy, in the database: a private thread is read by its two people and
 *   nobody else: not the owner, not a super admin, not somebody who has left.
 * - Everybody on the staff has it, doctors without the patient inbox included.
 * - A message reaches the other person live, with one line on their bell per
 *   thread however many arrive, and opening the thread clears both.
 * - Files reach only the thread; a photo loses where it was taken.
 *
 * Run against a warm server.
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import sharp from "sharp";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const APP = process.env.DATABASE_URL!;

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
async function until(fn: () => Promise<boolean>, ms = 20000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function signIn(browser: Browser, email: string, viewport = { width: 1440, height: 1000 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { timeout: 180000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
  return page;
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const app = new Client({ connectionString: APP });
  await app.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  /** A query as the app runs it: row security on, as this person, in this clinic. */
  const as = async (who: { userId: string }, clinicId: string, sql: string, params: unknown[] = [], admin = false) => {
    await app.query("begin");
    try {
      await app.query(
        `select set_config('app.user_id', $1, true), set_config('app.clinic_id', $2, true), set_config('app.role', 'doctor', true), set_config('app.is_admin', $3, true)`,
        [who.userId, clinicId, admin ? "true" : "false"]
      );
      const r = await app.query(sql, params);
      await app.query("commit");
      return r.rows;
    } catch (e) {
      await app.query("rollback");
      throw e;
    }
  };

  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qateam${tag}`;
  const [clinic] = await q(`insert into clinics (name, slug, timezone) values ('QA Team', $1, 'Asia/Amman') returning id`, [slug]);
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const member = async (who: string, name: string, role: string, permissions: string, isOwner = false) => {
    const email = `${who}-${tag}@test.local`;
    const [u] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [email, hash, name]);
    const [m] = await q(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, $3, $4, $5) returning id`, [clinic.id, u.id, role, isOwner, permissions]);
    return { email, userId: u.id as string, memberId: m.id as string, name };
  };
  const owner = await member("owner", "Owner Team", "doctor", '{"level":"full"}', true);
  const desk = await member("desk", "Desk Team", "receptionist", JSON.stringify({ level: "custom", caps: { dashboard: true, conversations: true, calendar: true } }));
  const docA = await member("doca", "Dr Alpha", "doctor", JSON.stringify({ level: "custom", caps: { dashboard: true, patients: true, calendar: true } }));
  const docB = await member("docb", "Dr Beta", "doctor", JSON.stringify({ level: "custom", caps: { dashboard: true, patients: true } }));

  try {
    console.log("The room");
    const [room] = await q(`select id from team_threads where clinic_id = $1 and kind = 'clinic'`, [clinic.id]);
    check(!!room, "a clinic has a room as soon as it has staff");
    const roomPeople = await q(`select user_id from team_thread_members where thread_id = $1`, [room?.id]);
    check(roomPeople.length === 4, "and everybody on the staff is in it", String(roomPeople.length));

    console.log("Privacy, in the database");
    const [dm] = await as(desk, clinic.id, `select app_team_open_direct($1) as id`, [docA.userId]);
    const [again] = await as(docA, clinic.id, `select app_team_open_direct($1) as id`, [desk.userId]);
    check(dm.id && dm.id === again.id, "two people share one private thread, whoever opens it");
    await as(desk, clinic.id, `insert into team_messages (clinic_id, thread_id, sender_id, body) values ($1, $2, $3, 'Room 2 needs gauze')`, [clinic.id, dm.id, desk.userId]);
    const read = async (who: { userId: string }, admin = false) =>
      (await as(who, clinic.id, `select count(*)::int as n from team_messages where thread_id = $1`, [dm.id], admin))[0].n;
    check((await read(docA)) === 1, "the other person reads it");
    check((await read(owner)) === 0, "the owner does not");
    check((await read(owner, true)) === 0, "nor does a super admin's connection");
    check((await as(docB, clinic.id, `select count(*)::int as n from team_threads where id = $1`, [dm.id]))[0].n === 0, "a colleague cannot even see the thread exists");
    let refused = false;
    try {
      await as(docB, clinic.id, `insert into team_messages (clinic_id, thread_id, sender_id, body) values ($1, $2, $3, 'hi')`, [clinic.id, dm.id, docB.userId]);
    } catch {
      refused = true;
    }
    check(refused, "nor write into it");
    const [stranger] = await q(`insert into users (email, password_hash, full_name) values ($1, $2, 'Stranger') returning id`, [`stranger-${tag}@test.local`, hash]);
    const [sneak] = await as(desk, clinic.id, `select app_team_create_group('Sneaky', $1::uuid[]) as id`, [[stranger.id, docB.userId]]);
    const sneakPeople = (await q(`select user_id from team_thread_members where thread_id = $1`, [sneak.id])).map((r) => r.user_id);
    check(sneakPeople.length === 2 && !sneakPeople.includes(stranger.id), "a group takes only people on this clinic's staff");
    await q(`update clinic_members set active = false where id = $1`, [docA.memberId]);
    check((await read(docA)) === 0, "somebody who has left the staff reads nothing, at once");
    await q(`update clinic_members set active = true where id = $1`, [docA.memberId]);
    check((await read(docA)) === 1, "and coming back restores it");

    console.log("Notifications");
    const send = async (who: { userId: string }, thread: string, body: string) => {
      const [m] = await as(who, clinic.id, `insert into team_messages (clinic_id, thread_id, sender_id, body) values ($1, $2, $3, $4) returning id`, [clinic.id, thread, who.userId, body]);
      await as(who, clinic.id, `select app_team_notify($1)`, [m.id]);
    };
    await send(desk, dm.id, "Also the suction tip");
    await send(desk, dm.id, "Thanks!");
    const lines = await q(`select title, body, url from notifications where user_id = $1 and kind = 'team_message'`, [docA.userId]);
    check(lines.length === 1, "three messages are one line on the bell", String(lines.length));
    check(lines[0]?.title === "Desk Team" && lines[0]?.body === "Thanks!", "naming who wrote, and the latest", JSON.stringify(lines[0]));
    check(lines[0]?.url === `/c/${slug}/conversations/team?t=${dm.id}`, "opening it opens the thread");
    check((await q(`select unread from team_thread_members where thread_id = $1 and user_id = $2`, [dm.id, docA.userId]))[0].unread === 2, "and the thread counts what is unread");
    check((await q(`select count(*)::int as n from notifications where user_id = $1 and kind = 'team_message'`, [desk.userId]))[0].n === 0, "the sender is not told of their own message");
    await as(docA, clinic.id, `update team_thread_members set muted = true where thread_id = $1 and user_id = $2`, [dm.id, docA.userId]);
    await q(`delete from notifications where user_id = $1`, [docA.userId]);
    await send(desk, dm.id, "Quiet one");
    check((await q(`select count(*)::int as n from notifications where user_id = $1 and kind = 'team_message'`, [docA.userId]))[0].n === 0, "a muted thread does not ring");
    await as(docA, clinic.id, `update team_thread_members set muted = false where thread_id = $1 and user_id = $2`, [dm.id, docA.userId]);

    console.log("In the browser");
    const browser = await chromium.launch();
    const errors: string[] = [];
    try {
      const doc = await signIn(browser, docA.email);
      const front = await signIn(browser, desk.email);
      for (const p of [doc, front]) p.on("pageerror", (e) => errors.push(e.message));

      await doc.goto(`${BASE}/c/${slug}/conversations`, { timeout: 180000 });
      await doc.waitForURL(/\/conversations\/team/, { timeout: 60000 });
      check(true, "a doctor without the patient inbox lands on the team chat");
      await doc.waitForSelector("[data-team-threads] [data-team-thread]", { timeout: 120000 });
      check((await doc.locator("[data-conversations-switch]").count()) === 0, "and is not offered the patients' WhatsApp");
      const dmRow = doc.locator(`[data-team-thread='${dm.id}']`);
      check((await dmRow.locator("[data-team-unread]").getAttribute("data-team-unread")) === "3", "the private thread shows three unread");
      await dmRow.click();
      await doc.waitForSelector("[data-team-messages] [data-team-message]");
      check((await doc.locator("[data-team-messages]").innerText()).includes("Room 2 needs gauze"), "the thread opens on its messages");
      check(await until(async () => (await q(`select unread from team_thread_members where thread_id = $1 and user_id = $2`, [dm.id, docA.userId]))[0].unread === 0), "opening it clears the count");
      check(await until(async () => (await q(`select count(*)::int as n from notifications where user_id = $1 and kind = 'team_message' and read_at is null`, [docA.userId]))[0].n === 0), "and the bell line");

      await front.goto(`${BASE}/c/${slug}/conversations/team?t=${dm.id}`, { timeout: 180000 });
      await front.waitForSelector("[data-team-input]", { timeout: 120000 });
      check((await front.locator("[data-conversations-switch]").count()) === 1, "the desk can switch between patients and the team");

      await doc.locator("[data-team-input]").fill("On my way");
      await doc.locator("[data-team-send]").click();
      check(await until(async () => (await front.locator("[data-team-messages]").innerText()).includes("On my way")), "a reply reaches the other screen live");

      // A photo, with where it was taken.
      const gps = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#c88" } })
        .jpeg()
        .withExif({ IFD0: { Make: "QA" }, GPS: { GPSLatitudeRef: "N", GPSLatitude: "31/1 57/1 0/1" } } as never)
        .toBuffer();
      check(!!(await sharp(gps).metadata()).exif, "the photo as taken carries where it was taken");
      await front.locator("[data-team-file]").setInputFiles({ name: "chart.jpg", mimeType: "image/jpeg", buffer: gps });
      check(await until(async () => (await q(`select 1 from team_messages where thread_id = $1 and file_path is not null`, [dm.id])).length === 1), "a photo is sent");
      const [img] = await q(`select id from team_messages where thread_id = $1 and file_path is not null`, [dm.id]);
      const mine = await doc.request.get(`${BASE}/api/c/${slug}/team/messages/${img.id}`);
      check(mine.ok(), "the other person can open it");
      const meta = await sharp(Buffer.from(await mine.body())).metadata();
      check(!meta.exif, "without the place it was taken");
      const outsider = await signIn(browser, docB.email);
      const theirs = await outsider.request.get(`${BASE}/api/c/${slug}/team/messages/${img.id}`);
      check(theirs.status() === 404, "and a colleague outside the thread gets nothing", String(theirs.status()));
      const peek = await outsider.request.get(`${BASE}/api/c/${slug}/team/${dm.id}`);
      check(peek.status() === 404, "not even the thread", String(peek.status()));

      console.log("A group");
      await outsider.goto(`${BASE}/c/${slug}/conversations/team`, { timeout: 180000 });
      await outsider.locator("[data-team-new]").click();
      await outsider.locator("[data-team-group-toggle]").click();
      await outsider.locator("[data-team-group-name]").fill("Doctors");
      await outsider.locator(`[data-team-pick='${docA.userId}']`).check();
      await outsider.locator("[data-team-create-group]").click();
      await outsider.waitForSelector("[data-team-input]");
      check((await outsider.locator("[data-team-title]").innerText()) === "Doctors", "a doctor makes a group");
      await outsider.locator("[data-team-input]").fill("Case review at 3");
      await outsider.keyboard.press("Enter");
      check(await until(async () => (await q(`select title from notifications where user_id = $1 and kind = 'team_message' and title like '%Doctors'`, [docA.userId])).length === 1), "and its people are told, with the group's name");

      console.log("On a phone");
      const phone = await signIn(browser, docA.email, { width: 390, height: 844 });
      await phone.goto(`${BASE}/c/${slug}`, { timeout: 180000 });
      await phone.waitForSelector("[data-team-header]", { timeout: 120000 });
      check(true, "the team chat is one tap from the phone's header");
      await phone.locator("[data-team-header]").click();
      await phone.waitForSelector("[data-team-threads]", { timeout: 120000 });
      const width = (await phone.evaluate("document.documentElement.scrollWidth")) as number;
      check(width <= 390, "the chat does not scroll sideways", String(width));
      check(errors.length === 0, "no page errors", errors.join(" | "));
    } finally {
      await browser.close();
    }
  } finally {
    await q(`delete from clinics where id = $1`, [clinic.id]).catch((e) => console.log("cleanup:", e.message));
    await q(`delete from users where email like $1`, [`%-${tag}@test.local`]).catch(() => {});
    await app.end();
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
