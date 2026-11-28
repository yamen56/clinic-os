/**
 * A doctor's days off (0124).
 *
 *   - The slot engine: a doctor away on a day offers nothing that day, the
 *     other doctor still does, and the days either side are untouched.
 *   - A doctor adds their own from My hours: a visit already booked on those
 *     days is shown first and stays where it is, and the desk is told.
 *   - Settings → Hours lists every doctor's and adds one for a colleague,
 *     who is told.
 *   - The calendar's day view closes the absent doctor's column and says so.
 *   - It fits a phone.
 *
 *   npx tsx scripts/qa-days-off.ts
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { ar } from "../src/lib/i18n/ar";
import { describeSpills, spills } from "./lib-layout";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const TZ = "Asia/Amman";
const SHOTS = process.env.QA_SHOTS_DIR || "";

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

const T = ar.timeOff;
const ALL_DAYS = { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]], sat: [["09:00", "17:00"]], sun: [["09:00", "17:00"]] };

async function main() {
  const { computeSlots, computeDayCounts, isOffOn } = await import("../src/lib/slots");

  console.log("\n[the rule]");
  check("a day inside a range is off, its edges included", isOffOn([["2026-12-03", "2026-12-05"]], "2026-12-03") && isOffOn([["2026-12-03", "2026-12-05"]], "2026-12-05"));
  check("the days either side are not", !isOffOn([["2026-12-03", "2026-12-05"]], "2026-12-02") && !isOffOn([["2026-12-03", "2026-12-05"]], "2026-12-06") && !isOffOn(undefined, "2026-12-03"));

  /* ================================================================ fixture */
  const db = new Client({ connectionString: PG });
  await db.connect();
  const stamp = Date.now().toString(36);
  const slug = `qadoff${stamp}`;
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, working_hours)
       values ('QA Days Off','عيادة الإجازات',$1,'ar',$2,'JOD',$3) returning id`,
      [slug, TZ, JSON.stringify(ALL_DAYS)]
    )
  ).rows[0].id as string;
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

  const ownerId = await mkUser("owner", "مالك العيادة");
  await mkMember(ownerId, "other", { level: "full" }, true);
  const aUser = await mkUser("doca", "د. أمل ناصر");
  const docA = await mkMember(aUser, "doctor", { level: "full" });
  const bUser = await mkUser("docb", "د. باسم عودة");
  const docB = await mkMember(bUser, "doctor", { level: "full" });
  const deskUser = await mkUser("desk", "موظفة الاستقبال");
  await mkMember(deskUser, "receptionist", { level: "custom", caps: { dashboard: true, calendar: true, patients: true } });
  const service = (
    await db.query(
      `insert into services (clinic_id, name, name_ar, duration_min, price, active) values ($1,'Checkup','فحص',30,20,true) returning id`,
      [clinicId]
    )
  ).rows[0].id as string;
  const patient = (
    await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1,'سلمى حداد','+962790771144','staff') returning id`, [clinicId])
  ).rows[0].id as string;

  const today = DateTime.now().setZone(TZ).startOf("day");
  const d1 = today.plus({ days: 2 }).toISODate()!;
  const d2 = today.plus({ days: 3 }).toISODate()!;
  const d3 = today.plus({ days: 4 }).toISODate()!;
  // A visit already booked with Dr A on the day she will take off.
  const visitAt = DateTime.fromISO(`${d2}T11:00`, { zone: TZ });
  const appt = (
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5,$6,'confirmed') returning id`,
      [clinicId, patient, docA, service, visitAt.toUTC().toISO(), visitAt.plus({ minutes: 30 }).toUTC().toISO()]
    )
  ).rows[0].id as string;

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

  try {
    /* ============================================================ a doctor's own */
    console.log("\n[Dr A takes a day off from My hours]");
    const a = await ctx(`doca-${slug}@test.local`);
    await go(a.pg, "/profile/hours");
    check("My hours has the days-off card", (await a.pg.locator("[data-days-off]").count()) === 1);
    check("with nothing coming up", (await a.pg.locator("[data-days-off]").innerText()).includes(T.none));
    await a.pg.locator("[data-days-off-from]").fill(d2);
    await a.pg.locator("[data-days-off-to]").fill(d2);
    await a.pg.getByRole("textbox", { name: T.note }).fill("مؤتمر");
    await a.pg.locator("[data-days-off-add]").click();
    await a.pg.locator("[data-days-off-clashes]").waitFor();
    const clashText = await a.pg.locator("[data-days-off-clashes]").innerText();
    check("the visit booked that day is shown first", clashText.includes("سلمى حداد"), clashText.replace(/\n/g, " / "));
    const before = (await db.query(`select count(*)::int n from doctor_time_off where clinic_id = $1`, [clinicId])).rows[0].n;
    check("and nothing is saved yet", before === 0);
    await a.pg.getByRole("button", { name: T.addAnyway, exact: true }).click();
    await a.pg.locator("[data-days-off-list]").waitFor();
    const rowA = (await db.query(`select *, starts_on::text s, ends_on::text e from doctor_time_off where member_id = $1`, [docA])).rows[0];
    check("it is saved for that one day", rowA?.s === d2 && rowA?.e === d2 && rowA?.note === "مؤتمر", `${rowA?.s}–${rowA?.e}`);
    const apptAfter = (await db.query(`select status, starts_at, doctor_member_id from appointments where id = $1`, [appt])).rows[0];
    check("the booked visit has not moved", apptAfter.status === "confirmed" && apptAfter.doctor_member_id === docA && new Date(apptAfter.starts_at).getTime() === visitAt.toMillis());
    const deskNote = (await db.query(`select title, body from notifications where user_id = $1 and kind = 'doctor_hours'`, [deskUser])).rows[0];
    check("the desk is told, with the visit count", !!deskNote && deskNote.title.includes("د. أمل ناصر") && deskNote.body.includes("1"), deskNote ? `${deskNote.title} — ${deskNote.body}` : "none");
    const selfNote = (await db.query(`select count(*)::int n from notifications where user_id = $1 and kind = 'doctor_hours'`, [aUser])).rows[0].n;
    check("and the doctor is not told about her own", selfNote === 0);

    /* ============================================================ the engine */
    console.log("\n[booking offers]");
    const opts = (doctorMemberId: string | null) => ({
      clinicId,
      tz: TZ,
      clinicHours: ALL_DAYS as never,
      blockedDates: [],
      serviceId: service,
      doctorMemberId,
      minNoticeMin: 0,
      granularityMin: 30,
      linkDoctorIds: [],
    });
    const aOff = await computeSlots(db as never, { ...opts(docA), dateISO: d2 });
    check("Dr A offers nothing on her day off", aOff.length === 0, String(aOff.length));
    const aNext = await computeSlots(db as never, { ...opts(docA), dateISO: d3 });
    check("and is back the next day", aNext.length > 0, String(aNext.length));
    const any = await computeSlots(db as never, { ...opts(null), dateISO: d2 });
    check("any doctor that day means Dr B", any.length > 0 && any.every((s) => s.doctorMemberId === docB), `${any.length} slots`);
    const counts = await computeDayCounts(db as never, { ...opts(docA), fromISO: d1, days: 3 });
    check("the date strip shows her day off empty", counts[d2] === 0 && counts[d1] > 0 && counts[d3] > 0, JSON.stringify(counts));

    /* ============================================================ settings */
    console.log("\n[Settings → Hours, for a colleague]");
    const owner = await ctx(`owner-${slug}@test.local`);
    await go(owner.pg, "/settings/hours");
    const listed = await owner.pg.locator("[data-days-off-list]").innerText().catch(() => "");
    check("it lists every doctor's days off by name", listed.includes("د. أمل ناصر") && listed.includes("مؤتمر"), listed.replace(/\n/g, " / "));
    await owner.pg.locator("[data-days-off-doctor]").selectOption(docB);
    await owner.pg.locator("[data-days-off-from]").fill(d1);
    await owner.pg.locator("[data-days-off-to]").fill(d3);
    await owner.pg.locator("[data-days-off-add]").click();
    await owner.pg.waitForFunction(
      (id) => document.querySelectorAll(`[data-days-off-row="${id}"]`).length === 1,
      docB
    );
    const rowB = (await db.query(`select starts_on::text s, ends_on::text e from doctor_time_off where member_id = $1`, [docB])).rows[0];
    check("Dr B's three days are saved", rowB?.s === d1 && rowB?.e === d3);
    const bNote = (await db.query(`select title from notifications where user_id = $1 and kind = 'doctor_hours'`, [bUser])).rows[0];
    check("and Dr B is told", !!bNote, bNote?.title ?? "none");
    if (SHOTS) await owner.pg.locator("[data-days-off]").screenshot({ path: `${SHOTS}/days-off-settings.png` });
    const none = await computeSlots(db as never, { ...opts(null), dateISO: d2 });
    check("with both away, the day offers nothing", none.length === 0, String(none.length));

    /* ============================================================ the calendar */
    console.log("\n[the calendar]");
    const range = await owner.pg.request.get(
      `${BASE}/api/c/${slug}/appointments?from=${encodeURIComponent(DateTime.fromISO(d1, { zone: TZ }).toUTC().toISO()!)}&to=${encodeURIComponent(DateTime.fromISO(d3, { zone: TZ }).endOf("day").toUTC().toISO()!)}`
    );
    const cal = (await range.json()) as { timeOff?: { member_id: string }[] };
    check("the calendar data carries the days off", (cal.timeOff ?? []).length === 2, String(cal.timeOff?.length));
    // Dr B is away all three days; on d1 Dr A is in, so her column stays open.
    await go(owner.pg, `/calendar?tab=schedule&date=${d1}`);
    await owner.pg.getByRole("button", { name: ar.calendar.day, exact: true }).click();
    const offCol = owner.pg.locator(`[data-col="د. باسم عودة · ${T.offShort}"]`);
    await offCol.waitFor({ timeout: 30_000 }).catch(() => {});
    check("the absent doctor's column says so", (await offCol.count()) === 1);
    if (SHOTS) await owner.pg.screenshot({ path: `${SHOTS}/days-off-calendar.png` });
    check("the other doctor's column is as usual", (await owner.pg.locator('[data-col="د. أمل ناصر"]').count()) === 1);

    /* ============================================================ removing */
    console.log("\n[Dr A changes her mind]");
    await go(a.pg, "/profile/hours");
    check("her page lists only her own", (await a.pg.locator(`[data-days-off-row="${docB}"]`).count()) === 0 && (await a.pg.locator(`[data-days-off-row="${docA}"]`).count()) === 1);
    await a.pg.locator(`[data-days-off-row="${docA}"]`).getByRole("button", { name: T.remove }).click();
    await a.pg.waitForFunction((id) => document.querySelectorAll(`[data-days-off-row="${id}"]`).length === 0, docA);
    const left = (await db.query(`select count(*)::int n from doctor_time_off where member_id = $1`, [docA])).rows[0].n;
    check("removing it deletes it", left === 0);
    const back = await computeSlots(db as never, { ...opts(docA), dateISO: d2 });
    check("and she is bookable that day again", back.length > 0, String(back.length));

    /* ============================================================ phone */
    console.log("\n[on a phone]");
    const phone = await ctx(`owner-${slug}@test.local`, { width: 390, height: 844 }, true);
    await go(phone.pg, "/settings/hours");
    if (SHOTS) {
      await phone.pg.locator("[data-days-off]").scrollIntoViewIfNeeded();
      await phone.pg.screenshot({ path: `${SHOTS}/days-off-phone.png` });
    }
    const s = await spills(phone.pg, "[data-days-off]");
    check("the days-off card fits a phone", s.length === 0, describeSpills(s));
    const addBox = await phone.pg.locator("[data-days-off-add]").boundingBox();
    check("its button is thumb-sized", (addBox?.height ?? 0) >= 40, `${Math.round(addBox?.height ?? 0)}px`);
    await phone.c.close();
    await a.c.close();
    await owner.c.close();
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
