/**
 * The desk's batch of 2026-11-28 (after families and series).
 *
 *   - The booking panel says what is wrong with a time before it is saved:
 *     the doctor's day off, a day they do not work, outside their hours, the
 *     clinic shut, another patient at that time — and a fine time says nothing.
 *     A day off can still be booked.
 *   - Moving one visit of a series asks whether the later ones go too, and
 *     moves them by the same amount.
 *   - The patient header has one WhatsApp button; the wa.me link is in ⋯.
 *   - A service's switch says what it is.
 *   - A child with no phone shows, in the list, whose number reaches them.
 *
 *   npx tsx scripts/qa-desk-notices.ts
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = process.env.QA_SHOTS_DIR || "";
const TZ = "Asia/Amman";

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
  const db = new Client({ connectionString: PG });
  await db.connect();
  const stamp = Date.now().toString(36);
  const slug = `qanote${stamp}`;
  const today = DateTime.now().setZone(TZ).startOf("day");
  const at = (days: number) => today.plus({ days });
  // A weekday the clinic is open, three days on, and the days around it.
  const open = at(3);
  const blocked = at(5).toISODate()!;
  // The doctor works every day the clinic does except the weekday of `at(4)`.
  const notHerDay = at(4).toFormat("ccc").toLowerCase();
  const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const clinicHours = Object.fromEntries(DAY_KEYS.map((d) => [d, [["09:00", "17:00"]]]));
  const doctorHours = Object.fromEntries(DAY_KEYS.map((d) => [d, d === notHerDay ? [] : [["10:00", "16:00"]]]));
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, working_hours, blocked_dates)
       values ('QA Notices','عيادة التنبيهات',$1,'ar',$2,'JOD',$3,$4) returning id`,
      [slug, TZ, JSON.stringify(clinicHours), JSON.stringify([blocked])]
    )
  ).rows[0].id as string;
  const mkUser = async (tag: string, name: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'ar') returning id`,
        [`${tag}-${slug}@test.local`, bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;
  const mkMember = async (userId: string, role: string, perms: unknown, owner = false, hours: unknown = null) =>
    (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions, working_hours) values ($1,$2,$3,$4,$5,$6) returning id`,
        [clinicId, userId, role, owner, JSON.stringify(perms), hours ? JSON.stringify(hours) : null]
      )
    ).rows[0].id as string;
  await mkMember(await mkUser("owner", "مالك العيادة"), "other", { level: "full" }, true);
  const doc = await mkMember(await mkUser("doc", "د. هالة عواد"), "doctor", { level: "full" }, false, doctorHours);
  await db.query(`insert into doctor_time_off (clinic_id, member_id, starts_on, ends_on, note) values ($1,$2,$3,$3,'مؤتمر')`, [clinicId, doc, at(6).toISODate()]);
  const service = (
    await db.query(`insert into services (clinic_id, name, name_ar, duration_min, price, active) values ($1,'Visit','زيارة',30,20,true) returning id`, [clinicId])
  ).rows[0].id as string;
  const mkPatient = async (name: string, phone: string | null) =>
    (await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1,$2,$3,'staff') returning id`, [clinicId, name, phone])).rows[0].id as string;
  const patient = await mkPatient("منى داود", "+962790774401");
  const other = await mkPatient("وليد سعد", "+962790774402");
  const child = await mkPatient("تالا داود", null);
  const fam = (await db.query(`insert into patient_families (clinic_id, contact_patient_id) values ($1,$2) returning id`, [clinicId, patient])).rows[0].id;
  await db.query(`update patients set family_id = $1, family_role = case when id = $2 then 'parent' else 'child' end where id = any($3::uuid[])`, [fam, patient, [patient, child]]);
  // Somebody with the doctor at 11:00 on the open day.
  const busyAt = DateTime.fromISO(`${open.toISODate()}T11:00`, { zone: TZ });
  await db.query(
    `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status) values ($1,$2,$3,$4,$5,$6,'confirmed')`,
    [clinicId, other, doc, service, busyAt.toUTC().toISO(), busyAt.plus({ minutes: 30 }).toUTC().toISO()]
  );
  // A series of three, a week apart, from a week on.
  const series = (
    await db.query(`insert into appointment_series (clinic_id, patient_id, every, unit, planned) values ($1,$2,1,'week',3) returning id`, [clinicId, patient])
  ).rows[0].id;
  const seriesIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const s = DateTime.fromISO(`${at(7 + i * 7).toISODate()}T12:00`, { zone: TZ });
    seriesIds.push(
      (
        await db.query(
          `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, series_id) values ($1,$2,$3,$4,$5,$6,'scheduled',$7) returning id`,
          [clinicId, patient, doc, service, s.toUTC().toISO(), s.plus({ minutes: 30 }).toUTC().toISO(), series]
        )
      ).rows[0].id
    );
  }

  const browser = await chromium.launch();
  const c = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await c.newPage();
  page.setDefaultNavigationTimeout(180_000);
  page.setDefaultTimeout(90_000);
  await signIn(page, `owner-${slug}@test.local`);
  await c.addCookies([{ name: "cos_locale", value: "ar", url: BASE }]);
  const go = async (path: string) => {
    await page.goto(`${BASE}/c/${slug}${path}`);
    await page.waitForLoadState("networkidle");
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  };

  try {
    /* ============================================================ notices */
    console.log("\n[the panel says what is wrong with a time]");
    await go(`/calendar?patient=${patient}`);
    const panel = page.locator('[data-appointment-panel="new"]');
    await panel.waitFor();
    await panel.locator("select[data-add-service]").selectOption(service);
    await panel.locator("select[data-doctor-select]").selectOption(doc);
    const noticeFor = async (day: string, time: string) => {
      await panel.locator('input[type="date"]').fill(day);
      await panel.locator('input[type="time"]').fill(time);
      await page.waitForTimeout(1200);
      const el = panel.locator("[data-slot-notice]");
      return (await el.count()) ? { kind: await el.getAttribute("data-slot-notice"), text: (await el.innerText()).replace(/\s+/g, " ") } : null;
    };
    const fine = await noticeFor(open.toISODate()!, "10:00");
    check("a free time in her hours says nothing", fine === null, JSON.stringify(fine));
    const busy = await noticeFor(open.toISODate()!, "11:00");
    check("another patient at that time is said before saving", busy?.kind === "busy" && busy.text.includes("وليد سعد"), JSON.stringify(busy));
    const early = await noticeFor(open.toISODate()!, "09:00");
    check("before her hours, with her hours that day", early?.kind === "outside" && early.text.includes("10:00–16:00") && early.text.includes("د. هالة عواد"), JSON.stringify(early));
    const notHers = await noticeFor(at(4).toISODate()!, "12:00");
    check("a weekday she does not work", notHers?.kind === "not_working", JSON.stringify(notHers));
    const shut = await noticeFor(blocked, "12:00");
    check("a day the clinic is shut", shut?.kind === "closed", JSON.stringify(shut));
    const away = await noticeFor(at(6).toISODate()!, "12:00");
    check("her day off, with its note", away?.kind === "off" && away.text.includes("مؤتمر") && away.text.includes(ar("canStill")), JSON.stringify(away));
    if (SHOTS) await panel.screenshot({ path: `${SHOTS}/notice-off.png` });
    await panel.locator("[data-panel-save]").click();
    let booked = 0;
    for (let i = 0; i < 30 && !booked; i++) {
      await page.waitForTimeout(400);
      booked = (await db.query(`select count(*)::int as n from appointments where patient_id = $1 and series_id is null`, [patient])).rows[0].n;
    }
    check("and the desk can still book it", booked === 1, String(booked));

    /* ============================================================ series move */
    console.log("\n[moving one visit of a series]");
    const first = DateTime.fromISO(`${at(7).toISODate()}T12:00`, { zone: TZ });
    await go(`/calendar?tab=schedule&date=${at(7).toISODate()}`);
    await page.locator(`[data-appt-id="${seriesIds[0]}"]`).click();
    const opened = page.locator(`[data-appointment-panel="${seriesIds[0]}"]`);
    await opened.waitFor();
    await opened.locator('input[type="date"]').fill(at(8).toISODate()!);
    await opened.locator("[data-panel-save]").click();
    await page.locator("[data-move-series]").waitFor();
    check("it asks whether the later ones go too", (await page.locator('[data-move-series-rest="1"]').count()) === 1);
    await page.locator('[data-move-series-rest="1"]').check();
    await page.getByRole("dialog").locator("button").last().click();
    let starts: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(400);
      starts = (await db.query(`select starts_at from appointments where id = any($1::uuid[]) order by starts_at`, [seriesIds])).rows.map((r) =>
        DateTime.fromJSDate(r.starts_at).setZone(TZ).toFormat("yyyy-MM-dd HH:mm")
      );
      if (starts[0]?.startsWith(at(8).toISODate()!) && starts[2]?.startsWith(at(22).toISODate()!)) break;
    }
    check(
      "all three move a day, at the same hour",
      starts.join(",") === [at(8), at(15), at(22)].map((d) => `${d.toISODate()} 12:00`).join(","),
      starts.join(" | ") + ` (from ${first.toFormat("yyyy-MM-dd")})`
    );

    /* ============================================================ inbox dates */
    console.log("\n[a WhatsApp thread says the day, as WhatsApp does]");
    const conv = (
      await db.query(`insert into conversations (clinic_id, phone_e164, patient_id, last_message_at) values ($1,'+962790774401',$2, now()) returning id`, [clinicId, patient])
    ).rows[0].id;
    const msgAt = (daysAgo: number, hhmm: string) => DateTime.fromISO(`${today.minus({ days: daysAgo }).toISODate()}T${hhmm}`, { zone: TZ }).toUTC().toISO();
    for (const [ago, hhmm, body] of [[10, "09:15", "مرحبا، هل يوجد موعد؟"], [1, "18:40", "شكراً"], [0, "00:05", "صباح الخير"]] as const) {
      await db.query(
        `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body, status, created_at) values ($1,$2,'in','patient','text',$3,'delivered',$4)`,
        [clinicId, conv, body, msgAt(ago, hhmm)]
      );
    }
    await go(`/conversations?open=${conv}`);
    await page.locator("[data-day-divider]").first().waitFor();
    const dividers = await page.locator("[data-day-divider]").allInnerTexts();
    const tenDays = today.minus({ days: 10 }).setLocale("ar-JO-u-nu-latn");
    check("each day starts with its date", dividers.length === 3, dividers.join(" | "));
    check(
      "today, yesterday, and an older day by its date",
      dividers[2]?.trim() === "اليوم" && dividers[1]?.trim() === "أمس" && dividers[0]?.includes(tenDays.toFormat("d LLLL")),
      dividers.join(" | ")
    );
    const stamp = (await page.locator("[data-chat-stamp]").first().innerText()).trim();
    check("the chat list stamps today's chat with its time, not 'ago'", /\d:\d\d/.test(stamp) && !stamp.includes("قبل"), stamp);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/inbox-days.png` });

    /* ============================================================ header */
    console.log("\n[the patient file]");
    await go(`/patients/${patient}`);
    check("one WhatsApp button in the header", (await page.locator("[data-header-message]").count()) === 1 && (await page.locator('main a[href^="https://wa.me/"]').count()) === 0);
    await page.getByRole("button", { name: ar("actions") }).click();
    check("the wa.me link is in the ⋯ menu", (await page.locator("[data-menu-wa]").count()) === 1);
    await page.keyboard.press("Escape");

    /* ============================================================ services */
    console.log("\n[a service's switch]");
    await go(`/settings/services`);
    const row = (await page.locator("li.spine").first().innerText()).replace(/\s+/g, " ");
    check("says what it is", row.includes(ar("offered")), row);

    /* ============================================================ list */
    console.log("\n[the patient list]");
    await go(`/patients`);
    const reach = page.locator("[data-row-reach]");
    const listText = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    check("a child with no phone shows whose number reaches her", listText.includes("عبر رقم منى داود"), `${await reach.count()} rows`);
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

let dict: Record<string, unknown> | null = null;
function ar(key: string): string {
  const d = dict as { slotNotice: { canStill: string }; common: { actions: string }; services: { offered: string } };
  return key === "canStill" ? d.slotNotice.canStill : key === "actions" ? d.common.actions : d.services.offered;
}

import("../src/lib/i18n/ar").then((m) => {
  dict = m.ar as unknown as Record<string, unknown>;
  return main();
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
