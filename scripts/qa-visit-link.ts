/**
 * The patient's own link to an appointment (migration 0115): see it, move it,
 * cancel it — and reception and the booking page handing it out.
 *
 * The routes are driven over HTTP against the dev server, the clinic's rules
 * are flipped in the database between them, and the patient's page, the
 * booking page's "Already booked?" and the desk's "Send change/cancel link"
 * are driven in a phone-sized browser. The doctor's alert is the worker's
 * code, imported in-process, so a day-old worker on this machine cannot
 * answer for it.
 *
 *   npx tsx scripts/qa-visit-link.ts
 */
import { Client } from "pg";
import { randomUUID } from "node:crypto";
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
  const { visitToken, visitRights, patientCanChange, manageLinkFor } = await import("../src/lib/visit-link");
  const { applyAppointmentStatus } = await import("../src/lib/appointments");
  const { appointmentAlerts } = await import("../worker/notifications");

  const db = new Client({ connectionString: PG });
  await db.connect();
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const tag = Date.now().toString(36);
  const slug = `qavisit${tag}`;
  const userIds: string[] = [];
  let clinic = "";

  // Earlier runs from this machine must not count against this one.
  await db.query(`delete from rate_counters where bucket like 'visit-%' or bucket like 'find%'`);

  try {
    clinic = (
      await one(
        `insert into clinics (name, slug, timezone, working_hours, default_locale, phone_e164) values ('QA Visit', $1, $2, $3, 'en', '+96265000000') returning id, patient_changes, patient_changes_cutoff_hours`,
        [slug, TZ, ALL_DAY]
      )
    ).id as string;
    const fresh = await one(`select patient_changes, patient_changes_cutoff_hours from clinics where id = $1`, [clinic]);
    console.log("\nthe clinic's rules");
    check("a clinic made today lets patients change and cancel", fresh.patient_changes === "cancel_move", fresh.patient_changes);
    check("up to twelve hours before", fresh.patient_changes_cutoff_hours === 12, String(fresh.patient_changes_cutoff_hours));

    // A WhatsApp session that reads as connected, so messages are queued (nothing can send them).
    await db.query(`insert into whatsapp_sessions (clinic_id, status, desired, phone_number) values ($1, 'connected', false, '962790000000')`, [clinic]);
    const mkUser = async (email: string, name: string) => {
      const id = (
        await one(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [
          email,
          bcrypt.hashSync("password123", 10),
          name,
        ])
      ).id as string;
      userIds.push(id);
      return id;
    };
    const ownerEmail = `owner-${slug}@test.local`;
    const ownerId = await mkUser(ownerEmail, "QA Owner");
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
      [clinic, ownerId]
    );
    const docUser = await mkUser(`doc-${slug}@test.local`, "Dr Visit");
    const doc = (await one(`insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'doctor') returning id`, [clinic, docUser])).id as string;
    await db.query(
      `insert into clinic_staff_alerts (clinic_id, kind, roles, enabled, sort) values ($1, 'appointment_cancelled', '{doctor}', true, 5), ($1, 'appointment_rescheduled', '{doctor}', true, 6)`,
      [clinic]
    );
    const svc = async (name: string, dur: number, online = true) =>
      (await one(`insert into services (clinic_id, name, duration_min, price, bookable_online) values ($1, $2, $3, 10, $4) returning id`, [clinic, name, dur, online])).id as string;
    const S30 = await svc("Checkup", 30);
    const S60 = await svc("Long session", 60);
    const SURG = await svc("Surgery", 90, false);
    await db.query(`insert into booking_links (clinic_id, slug, name, min_notice_min, require_otp) values ($1, $2, 'Main', 0, false)`, [clinic, slug]);

    let phoneN = 0;
    const phone = () => `+9627${String(82000000 + Math.floor(Math.random() * 900000) + phoneN++)}`;
    const patient = async (name: string, ph = phone()) =>
      (await one(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, $2, $3, 'staff') returning id`, [clinic, name, ph])).id as string;
    const day = (n: number) => DateTime.now().setZone(TZ).plus({ days: n }).startOf("day");
    const at = (d: number, h: number, m = 0) => day(d).set({ hour: h, minute: m });
    const appt = async (p: string, start: DateTime, o: { service?: string; minutes?: number; status?: string } = {}) =>
      (
        await one(
          `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source)
           values ($1, $2, $3, $4, $5, $6, $7, 'staff') returning id`,
          [clinic, p, doc, o.service ?? S30, start.toUTC().toISO(), start.plus({ minutes: o.minutes ?? 30 }).toUTC().toISO(), o.status ?? "confirmed"]
        )
      ).id as string;
    const tokenOf = async (id: string) => visitToken(id, (await one(`select patient_id from appointments where id = $1`, [id])).patient_id);
    const api = async (path: string, body?: unknown) => {
      const r = await fetch(`${BASE}${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const bodies = async (p: string) =>
      (
        await db.query(
          `select m.body from messages m join conversations c on c.id = m.conversation_id where c.clinic_id = $1 and c.patient_id = $2 order by m.created_at`,
          [clinic, p]
        )
      ).rows.map((r) => String(r.body));

    /* ------------------------------------------------------------ the rules */
    console.log("\nwhat the link allows (pure)");
    const base = { mode: "cancel_move" as const, cutoffHours: 12, status: "confirmed", moves: 0, bookable: true };
    const in2d = new Date(Date.now() + 48 * 3600e3);
    check("two days out: move and cancel", JSON.stringify(visitRights({ ...base, startsAt: in2d })) === JSON.stringify({ cancel: true, move: true, why: null }));
    check("inside the cutoff: neither", visitRights({ ...base, startsAt: new Date(Date.now() + 3 * 3600e3) }).why === "too_late");
    check("cancel-only clinic", visitRights({ ...base, mode: "cancel", startsAt: in2d }).why === "cancel_only");
    check("switched off", visitRights({ ...base, mode: "off", startsAt: in2d }).why === "off");
    check("moved twice", visitRights({ ...base, moves: 2, startsAt: in2d }).why === "moves_used");
    check("a service not bookable online: cancel only", (() => { const r = visitRights({ ...base, bookable: false, startsAt: in2d }); return r.cancel && !r.move && r.why === "not_online"; })());
    check("cancelled: nothing", visitRights({ ...base, status: "cancelled", startsAt: in2d }).why === "closed");

    /* ---------------------------------------------- online booking hands it out */
    console.log("\nthe online booking");
    const bookPhone = phone();
    const booked = await api(`/api/public/book/${slug}/start`, {
      serviceId: S30, doctorId: doc, startISO: at(2, 9).toUTC().toISO(), fullName: "Online Booker", phone: bookPhone, locale: "en",
    });
    check("a booking answers with the patient's own link", booked.status === 200 && /\/v\/[A-Za-z0-9_-]{44}$/.test(String(booked.body.manageUrl)), `${booked.status} ${JSON.stringify(booked.body).slice(0, 200)}`);
    const bookedPatient = (await one(`select id from patients where clinic_id = $1 and phone_e164 = $2`, [clinic, bookPhone]))?.id as string;
    check("and the WhatsApp confirmation carries it", (await bodies(bookedPatient)).some((b) => b.includes(String(booked.body.manageUrl))));

    /* --------------------------------------------------------- the page itself */
    console.log("\nthe link");
    const pA = await patient("Alpha Patient");
    const aA = await appt(pA, at(3, 10));
    const tA = await tokenOf(aA);
    const page200 = await fetch(`${BASE}/v/${tA}`);
    const html = await page200.text();
    check("the page opens", page200.status === 200 && html.includes("data-visit-view"), String(page200.status));
    // A character in the middle of the signature: every bit of it is data.
    const flipped = tA.slice(0, 30) + (tA[30] === "A" ? "B" : "A") + tA.slice(31);
    const padded = tA.slice(0, -1) + (tA.endsWith("A") ? "B" : "A");
    check("another spelling of the same signature is not accepted", !(await (await fetch(`${BASE}/v/${padded}`)).text()).includes("data-visit-view"));
    check("a tampered link shows nothing of the visit", !(await (await fetch(`${BASE}/v/${flipped}`)).text()).includes("data-visit-view"));
    const pOther = await patient("Someone Else");
    check("a link signed for another patient does not open this visit", !(await (await fetch(`${BASE}/v/${visitToken(aA, pOther)}`)).text()).includes("data-visit-view"));
    check("a tampered link cannot cancel", (await api(`/api/public/visit/${flipped}/cancel`, { locale: "en" })).status === 404);

    const days = await api(`/api/public/visit/${tA}/days`);
    check("the days strip has free days", days.status === 200 && Object.values(days.body.counts ?? {}).some((n) => Number(n) > 0), JSON.stringify(days.body).slice(0, 120));
    const slotsDay = await api(`/api/public/visit/${tA}/slots?date=${day(3).toISODate()}`);
    const own = at(3, 10).toUTC().toISO()!;
    check("the times leave out the one it already has", slotsDay.status === 200 && slotsDay.body.slots.length > 0 && !slotsDay.body.slots.some((s: { startISO: string }) => Date.parse(s.startISO) === Date.parse(own)));

    /* ----------------------------------------------------------------- move */
    console.log("\nmoving it");
    const target = at(3, 14).toUTC().toISO()!;
    const mv = await api(`/api/public/visit/${tA}/move`, { startISO: target, locale: "en" });
    const rowA = await one(`select starts_at, ends_at, status, patient_moves from appointments where id = $1`, [aA]);
    check("the patient moves it", mv.status === 200 && Date.parse(rowA.starts_at) === Date.parse(target), `${mv.status} ${JSON.stringify(mv.body)}`);
    check("keeping its length, status, and counting the move", rowA.status === "confirmed" && rowA.patient_moves === 1 && Date.parse(rowA.ends_at) - Date.parse(rowA.starts_at) === 30 * 60e3);
    const ev = await one(
      `select payload from jobs where clinic_id = $1 and kind = 'trigger:appointment_rescheduled' and payload->>'appointmentId' = $2 order by created_at desc limit 1`,
      [clinic, aA]
    );
    check("the desk's own 'moved' event fires, marked as the patient's", ev?.payload?.byPatient === true && !ev.payload.actorUserId, JSON.stringify(ev?.payload));
    check("and the patient is told on WhatsApp", (await bodies(pA)).some((b) => b.includes("has been moved")));
    check("it is in the audit log", !!(await one(`select 1 from audit_log where entity_id = $1 and action = 'appointment.patient_move'`, [aA])));

    const pBusy = await patient("Busy Patient");
    await appt(pBusy, at(3, 16));
    const taken = await api(`/api/public/visit/${tA}/move`, { startISO: at(3, 16).toUTC().toISO(), locale: "en" });
    check("a time somebody else holds is refused", taken.status === 409 && taken.body.error === "slot_taken", `${taken.status} ${JSON.stringify(taken.body)}`);
    const odd = await api(`/api/public/visit/${tA}/move`, { startISO: at(3, 14, 7).toUTC().toISO(), locale: "en" });
    check("a time off the booking grid is refused", odd.status === 409, String(odd.status));

    const pLong = await patient("Long Patient");
    const aLong = await appt(pLong, at(4, 9), { service: S60, minutes: 60 });
    const overlap = await api(`/api/public/visit/${await tokenOf(aLong)}/move`, { startISO: at(4, 9, 30).toUTC().toISO(), locale: "en" });
    check("a visit can move half an hour into its own old time", overlap.status === 200, `${overlap.status} ${JSON.stringify(overlap.body)}`);

    const mv2 = await api(`/api/public/visit/${tA}/move`, { startISO: at(3, 15).toUTC().toISO(), locale: "en" });
    check("a second move is fine", mv2.status === 200 && mv2.body.rights?.move === false && mv2.body.rights?.why === "moves_used", JSON.stringify(mv2.body));
    const mv3 = await api(`/api/public/visit/${tA}/move`, { startISO: at(3, 17).toUTC().toISO(), locale: "en" });
    check("a third is refused: call the clinic", mv3.status === 403 && mv3.body.why === "moves_used", `${mv3.status} ${JSON.stringify(mv3.body)}`);
    check("but the moved-twice visit can still be cancelled", (await patientCanChange(db as never, aA)) === true);

    /* ---------------------------------------------------------------- cancel */
    console.log("\ncancelling it");
    const pC = await patient("Cancel Patient");
    const aC = await appt(pC, at(5, 11));
    const tC = await tokenOf(aC);
    const cx = await api(`/api/public/visit/${tC}/cancel`, { reason: "feel_better", locale: "en" });
    const rowC = await one(`select status, cancelled_by, cancel_reason from appointments where id = $1`, [aC]);
    check("the patient cancels it", cx.status === 200 && rowC.status === "cancelled", `${cx.status} ${JSON.stringify(cx.body)}`);
    check("kept as cancelled by the patient, with the reason", rowC.cancelled_by === "patient" && rowC.cancel_reason === "feel_better", JSON.stringify(rowC));
    check("and answers with the booking page to book again", String(cx.body.bookUrl).endsWith(`/book/${slug}`));
    const evC = await one(
      `select id, payload from jobs where clinic_id = $1 and kind = 'trigger:appointment_status_changed' and payload->>'appointmentId' = $2 order by created_at desc limit 1`,
      [clinic, aC]
    );
    check("the desk's own cancel event fires (waitlist, doctor, automations)", evC?.payload?.status === "cancelled" && evC.payload.byPatient === true, JSON.stringify(evC?.payload));
    check("the patient gets a confirmation with the way to book again", (await bodies(pC)).some((b) => b.includes("has been cancelled") && b.includes(`/book/${slug}`)));
    check("cancelling twice is refused", (await api(`/api/public/visit/${tC}/cancel`, { locale: "en" })).status === 403);

    await applyAppointmentStatus(db as never, { clinicId: clinic, appointmentId: aC, status: "confirmed", actorUserId: ownerId });
    const restored = await one(`select cancelled_by, cancel_reason from appointments where id = $1`, [aC]);
    check("the desk restoring it clears 'cancelled by the patient'", restored.cancelled_by === null && restored.cancel_reason === null);
    await applyAppointmentStatus(db as never, { clinicId: clinic, appointmentId: aC, status: "cancelled", actorUserId: ownerId });
    check("and the desk's own cancel reads as staff", (await one(`select cancelled_by from appointments where id = $1`, [aC])).cancelled_by === "staff");

    /* -------------------------------------------------------- the doctor hears */
    console.log("\nthe doctor's alert (worker code, in-process)");
    const pAl = await patient("Alert Patient");
    const aAl = await appt(pAl, at(6, 10));
    await api(`/api/public/visit/${await tokenOf(aAl)}/cancel`, { reason: "cant_make_it", locale: "en" });
    await appointmentAlerts("appointment_status_changed", clinic, { appointmentId: aAl, patientId: pAl, status: "cancelled", previousStatus: "confirmed", actorUserId: null, byPatient: true }, randomUUID());
    // A worker running on this machine may add its own copy of the alert; this one is the code under test.
    const note = await one(
      `select title, body from notifications where user_id = $1 and title like '%Alert Patient%' and title like '%online by the patient%' order by created_at desc limit 1`,
      [docUser]
    );
    check("says the patient cancelled online, and why", !!note && note.title.includes("online by the patient") && note.body.includes("can't make it"), JSON.stringify(note));

    /* ---------------------------------------------------- the clinic's choices */
    console.log("\nthe clinic's choices");
    const pT = await patient("Late Patient");
    const aT = await appt(pT, DateTime.now().plus({ hours: 3 }).startOf("hour"));
    const late = await (await fetch(`${BASE}/v/${await tokenOf(aT)}`)).text();
    check("three hours before: the page says to contact the clinic", late.includes(`data-visit-why="too_late"`));
    check("and a cancel is refused", (await api(`/api/public/visit/${await tokenOf(aT)}/cancel`, { locale: "en" })).status === 403);
    check("the automation's 'can change it online' says no", (await patientCanChange(db as never, aT)) === false);

    const pS = await patient("Surgery Patient");
    const aS = await appt(pS, at(7, 10), { service: SURG, minutes: 90 });
    const surg = await (await fetch(`${BASE}/v/${await tokenOf(aS)}`)).text();
    check("a service kept off the booking page: cancel only", surg.includes(`data-visit-why="not_online"`) && surg.includes("data-visit-cancel") && !surg.includes("data-visit-change"));
    check("and moving it is refused", (await api(`/api/public/visit/${await tokenOf(aS)}/move`, { startISO: at(7, 12).toUTC().toISO() })).status === 403);

    await db.query(`update clinics set patient_changes = 'cancel' where id = $1`, [clinic]);
    const pK = await patient("CancelOnly Patient");
    const aK = await appt(pK, at(8, 10));
    check("cancel-only: moving is refused", (await api(`/api/public/visit/${await tokenOf(aK)}/move`, { startISO: at(8, 12).toUTC().toISO() })).status === 403);

    await db.query(`update clinics set patient_changes = 'off' where id = $1`, [clinic]);
    check("off: the page only shows it", (await (await fetch(`${BASE}/v/${await tokenOf(aK)}`)).text()).includes(`data-visit-why="off"`));
    check("off: cancelling is refused", (await api(`/api/public/visit/${await tokenOf(aK)}/cancel`, { locale: "en" })).status === 403);
    check("off: no link goes into messages", (await manageLinkFor(db as never, aK)) === "");
    check("off: the booking page cannot send links", (await api(`/api/public/book/${slug}/find`, { phone: phone() })).status === 403);
    await db.query(`update clinics set patient_changes = 'cancel_move' where id = $1`, [clinic]);
    check("on: messages carry the link", (await manageLinkFor(db as never, aK)).includes("/v/"));

    /* ------------------------------------------------------ "Already booked?" */
    console.log("\nthe booking page's 'Already booked?'");
    const findPhone = phone();
    const pF = await patient("Find Patient", findPhone);
    await appt(pF, at(9, 10));
    await appt(pF, at(10, 10));
    await appt(pF, at(11, 10), { status: "cancelled" });
    const found = await api(`/api/public/book/${slug}/find`, { phone: findPhone, locale: "en" });
    const fBodies = await bodies(pF);
    check("a known number: its upcoming visits' links go to its WhatsApp", found.status === 200 && fBodies.filter((b) => b.includes("/v/")).length === 2, `${found.status} ${fBodies.length}`);
    const unknown = await api(`/api/public/book/${slug}/find`, { phone: phone(), locale: "en" });
    check("an unknown number gets the same answer", unknown.status === 200 && unknown.body.ok === true);

    /* --------------------------------------------------------------- browser */
    console.log("\nin a phone's browser");
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ ...devices["Pixel 5"], locale: "en-GB" });
      const page = await ctx.newPage();
      const pB = await patient("Browser Patient");
      const aB = await appt(pB, at(12, 10));
      await page.goto(`${BASE}/v/${await tokenOf(aB)}`, { timeout: 180000 });
      await page.waitForSelector("[data-visit-change]", { timeout: 120000 });
      const fits = async (p: Page) => (await p.evaluate("document.scrollingElement.scrollWidth <= window.innerWidth + 1")) as boolean;
      check("the page fits the phone", await fits(page));
      await page.click("[data-visit-change]");
      await page.waitForSelector("[data-visit-move] [aria-pressed] >> nth=0", { timeout: 30000 });
      // Five days out: the strip opens on today, whose times are inside the cutoff, and a visit
      // moved there rightly cannot be changed again online.
      await page.click(`[data-visit-move] button[aria-label="${day(5).setLocale("en-GB").toFormat("cccc d LLLL")}"]`);
      await page.waitForTimeout(300);
      const slotBtn = page.locator("[data-visit-move] .grid button").first();
      await slotBtn.waitFor({ timeout: 30000 });
      await slotBtn.click();
      await page.click("[data-visit-primary]");
      await page.waitForSelector('[data-visit-done="moved"]', { timeout: 30000 });
      check("change the time: pick one, and it says it moved", (await page.innerText("main")).includes("Your appointment has moved"));
      check("the visit moved in the clinic's diary", (await one(`select patient_moves from appointments where id = $1`, [aB])).patient_moves === 1);
      await page.click("text=Change or cancel");
      await page.click("[data-visit-cancel]");
      await page.click('[data-visit-reason="booked_elsewhere"]');
      await page.click("[data-visit-confirm-cancel]");
      await page.waitForSelector('[data-visit-done="cancelled"]', { timeout: 30000 });
      check("cancel: pick a reason, confirm, and it says so", (await page.innerText("main")).includes("Your appointment is cancelled"));
      check("with a way to book again", (await page.locator("[data-visit-book-another]").count()) === 1);
      check("kept with the reason", (await one(`select status, cancel_reason from appointments where id = $1`, [aB])).cancel_reason === "booked_elsewhere");

      await page.goto(`${BASE}/book/${slug}`, { timeout: 180000 });
      await page.waitForSelector("[data-booking-find-open]", { timeout: 120000 });
      await page.click("[data-booking-find-open]");
      await page.fill("[data-booking-find] input[type=tel]", "0" + findPhone.slice(4));
      await page.click("[data-booking-bar] button >> nth=-1");
      await page.waitForSelector("[data-booking-find-sent]", { timeout: 30000 });
      check("'Already booked?' takes a number and says to check WhatsApp", (await page.innerText("main")).includes("Check your WhatsApp"));
      check("and the page fits the phone", await fits(page));

      // Reception: the visit's panel sends the link.
      const pD = await patient("Desk Patient");
      const aD = await appt(pD, at(2, 12));
      await page.context().clearCookies();
      await page.goto(`${BASE}/login`, { timeout: 180000 });
      await page.fill('input[name="email"]', ownerEmail);
      await page.fill('input[name="password"]', "password123");
      await page.click('button[type="submit"]');
      // The landing page after sign-in is the heaviest compile on a dev server that just restarted.
      await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 420000, waitUntil: "commit" });
      await page.goto(`${BASE}/c/${slug}/calendar?tab=schedule&open=${aD}`, { timeout: 180000, waitUntil: "commit" });
      await page.waitForSelector("[data-panel-send-link]", { timeout: 180000 });
      await page.click("[data-panel-send-link]");
      let sent = false;
      for (let i = 0; i < 30 && !sent; i++) {
        sent = (await bodies(pD)).some((b) => b.includes("/v/") && b.includes("To change or cancel it"));
        if (!sent) await page.waitForTimeout(500);
      }
      const said = sent
        ? ""
        : `${(await page.innerText("body")).slice(-300).replace(/\s+/g, " ")} | rows: ${JSON.stringify(
            (await db.query(`select m.body, m.status from messages m join conversations c on c.id = m.conversation_id where c.patient_id = $1`, [pD])).rows
          )}`;
      check("reception's 'Send change/cancel link' puts it on the patient's WhatsApp", sent, said);

      await page.goto(`${BASE}/c/${slug}/settings/booking`, { timeout: 180000, waitUntil: "commit" });
      await page.waitForSelector("[data-patient-changes]", { timeout: 180000 });
      await page.click('[data-patient-changes-mode="cancel"]');
      let mode = "";
      for (let i = 0; i < 30 && mode !== "cancel"; i++) {
        mode = (await one(`select patient_changes from clinics where id = $1`, [clinic])).patient_changes;
        if (mode !== "cancel") await page.waitForTimeout(500);
      }
      check("Settings → Online booking switches what the link allows", mode === "cancel", mode);
      await ctx.close();
    } finally {
      await browser.close();
    }
  } finally {
    if (clinic) await db.query(`delete from clinics where id = $1`, [clinic]);
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
