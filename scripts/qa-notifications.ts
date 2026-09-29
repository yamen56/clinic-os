/**
 * Notifications: the right person hears about the right thing, once, at the
 * right moment — in the app and on the phone.
 *
 * What is proved here, in the order it can break:
 *
 *   1. the registry — which switch silences which kind, what "off" means for
 *      somebody who set it before levels existed, when quiet hours end;
 *   2. the delivery plan — what goes to the phone now, what waits for the
 *      morning, what is kept in the app, what comes out as one summary;
 *   3. writing a notification — a member telling a colleague from inside their
 *      own transaction (this used to roll the transaction back), and a kind
 *      somebody switched off never landing;
 *   4. reminders — sent after a worker restart, not repeated, and sent again
 *      when the appointment moves;
 *   5. the instant appointment alerts — the doctor hears about a booking, a
 *      cancellation and a move; the person who made the change does not;
 *   6. the role summaries — tomorrow's list, what is left to confirm, the week;
 *      nobody sent a number or a link they are not allowed to open;
 *   7. the realtime events that keep every open tab's badge honest;
 *   8. in the browser — the badge on the bell, the pop-up on whatever screen is
 *      open, the settings page, the team-alert templates, and one live
 *      connection per tab however many screens listen.
 *
 * The planner is tested as a pure function because the worker is running
 * alongside this suite: anything that waits for "the worker" to push would be
 * racing it. Everything else is keyed at-most-once, so whichever of the two
 * gets there first, the counts are the same.
 *
 *   npx tsx scripts/qa-notifications.ts      (needs the dev stack for section 8)
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.QA_BASE || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await wait(300);
  }
  return null;
}

async function main() {
  const kinds = await import("../src/lib/notification-kinds");
  const { NT } = await import("../src/lib/notification-text");
  const { en, ar } = { en: (await import("../src/lib/i18n/en")).en, ar: (await import("../src/lib/i18n/ar")).ar };
  const worker = await import("../worker/notifications");
  const { withSystem: workerSystem, pool: workerPool } = await import("../worker/db");
  const { withCtx } = await import("../src/lib/db");
  const { notifyClinicStaff, notifyUser } = await import("../src/lib/notify");

  const db = new Client({ connectionString: PG });
  await db.connect();

  /* ------------------------------------------------------------ fixtures */
  const tag = Date.now().toString(36);
  const slug = `qa-notif-${tag}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, timezone, currency) values ('QA Notif', 'إشعارات', $1, 'Asia/Amman', 'JOD')
       returning id, timezone`,
      [slug]
    )
  ).rows[0];
  const other = (
    await db.query(`insert into clinics (name, slug) values ('QA Elsewhere', $1) returning id`, [`${slug}-x`])
  ).rows[0];
  const hash = bcrypt.hashSync("password123", 10);
  const mkUser = async (name: string, locale: "ar" | "en") =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, $4) returning id`,
        [`${name.toLowerCase().replace(/\W+/g, "-")}-${tag}@test.local`, hash, name, locale]
      )
    ).rows[0].id as string;
  const owner = await mkUser("QA Owner", "ar");
  const docA = await mkUser("Dr Adam", "en");
  const docB = await mkUser("د. بشرى", "ar");
  const rec = await mkUser("QA Reception", "ar");
  const stranger = await mkUser("QA Stranger", "ar");
  const member = async (clinicId: string, userId: string, role: string, isOwner = false) =>
    (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, reminder_minutes)
         values ($1, $2, $3, $4, 30) returning id`,
        [clinicId, userId, role, isOwner]
      )
    ).rows[0].id as string;
  await member(clinic.id, owner, "other", true);
  const mA = await member(clinic.id, docA, "doctor");
  const mB = await member(clinic.id, docB, "doctor");
  await member(clinic.id, rec, "receptionist");
  await member(other.id, stranger, "receptionist");
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164) values ($1, 'سلمى النجار', '+962790001234') returning id`,
      [clinic.id]
    )
  ).rows[0].id as string;

  const tz = clinic.timezone as string;
  const local = () => DateTime.now().setZone(tz);
  const count = async (sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0].n as number;
  const rowsFor = async (userId: string, kind: string) =>
    (
      await db.query(
        `select title, body, dedupe_key from notifications where user_id = $1 and kind = $2 order by created_at`,
        [userId, kind]
      )
    ).rows as { title: string; body: string; dedupe_key: string | null }[];
  const appt = async (startsAt: DateTime, opts: { doctor?: string; status?: string } = {}) =>
    (
      await db.query(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $4::timestamptz + interval '30 minutes', $5) returning id`,
        [clinic.id, patient, opts.doctor ?? mA, startsAt.toUTC().toISO(), opts.status ?? "confirmed"]
      )
    ).rows[0].id as string;
  console.log(`fixture clinic ${slug}`);

  /* ================================================== 1. the registry */
  console.log("\n[1. which switch, which level, when quiet ends]");
  check(
    "the AI receptionist's bookings obey the same switch as the booking link's",
    kinds.prefKeyFor("ai_booking") === "new_booking" && kinds.prefKeyFor("booking") === "new_booking"
  );
  check(
    "a cancellation and a move share the switch that used to control nothing",
    kinds.prefKeyFor("appointment_cancelled") === "cancellation" &&
      kinds.prefKeyFor("appointment_rescheduled") === "cancellation"
  );
  check(
    "a test and an integrity failure answer to no switch",
    kinds.prefKeyFor("test") === null && kinds.prefKeyFor("document_integrity") === null
  );
  check("every document kind is one switch", kinds.prefKeyFor("document_expired") === "documents");
  check(
    "a switch set to false before levels existed still means 'not on my phone'",
    kinds.levelOf({ day_end: false }, "day_end") === "app" && kinds.levelOf({}, "day_end") === "push"
  );
  check(
    "the WhatsApp alerts can go quiet but never away",
    kinds.levelOf({ whatsapp: "off" }, "whatsapp") === "app" && kinds.mutableKey("whatsapp") === null
  );
  const q = { on: true, from: "22:00", to: "07:00", urgent: true };
  const at = (hm: string) => DateTime.fromISO(`2026-09-29T${hm}`, { zone: tz });
  check(
    "late evening waits until tomorrow's end of quiet",
    kinds.quietUntil(q, at("23:30"))?.toISO() === at("07:00").plus({ days: 1 }).toISO()
  );
  check("early morning waits until this morning's", kinds.quietUntil(q, at("06:59"))?.toISO() === at("07:00").toISO());
  check("midday is not quiet", kinds.quietUntil(q, at("12:00")) === null);
  check(
    "a window inside one day works too",
    kinds.quietUntil({ ...q, from: "13:00", to: "15:00" }, at("14:10"))?.toISO() === at("15:00").toISO()
  );
  check(
    "equal ends and a switched-off window are no window",
    kinds.quietUntil({ ...q, to: "22:00" }, at("22:30")) === null && kinds.quietUntil({ ...q, on: false }, at("23:30")) === null
  );
  check(
    "a reminder knocks hard and goes stale; a digest does neither",
    kinds.deliveryFor("doctor_reminder").prompt &&
      kinds.deliveryFor("doctor_reminder").dropWhenQuiet &&
      !kinds.deliveryFor("day_end").prompt
  );

  /* ============================================== 2. the delivery plan */
  console.log("\n[2. what reaches the phone, and when]");
  const quietNow = (() => {
    const n = local();
    const from = n.minus({ hours: 1 }).toFormat("HH:00");
    const to = n.plus({ hours: 2 }).toFormat("HH:00");
    return { on: true, from, to, urgent: true };
  })();
  const pend = (over: Partial<import("../worker/notifications").Pending>) =>
    ({
      id: randomUUID(),
      user_id: owner,
      clinic_id: clinic.id,
      kind: "booking",
      title: "t",
      body: "",
      url: null,
      read_at: null,
      push_after: null,
      phone_e164: null,
      notification_prefs: {},
      locale: "ar",
      tz,
      slug,
      ...over,
    }) as import("../worker/notifications").Pending;

  const plain = pend({});
  const read = pend({ read_at: new Date().toISOString() });
  const appOnly = pend({ notification_prefs: { new_booking: "app" } });
  const quietDigest = pend({ kind: "day_end", notification_prefs: { quiet: quietNow } });
  const quietBooking = pend({ notification_prefs: { quiet: quietNow } });
  const quietReminder = pend({ kind: "doctor_reminder", notification_prefs: { quiet: quietNow } });
  const quietUrgent = pend({ kind: "ai_escalation", notification_prefs: { quiet: quietNow } });
  const quietUrgentHeld = pend({ kind: "ai_escalation", notification_prefs: { quiet: { ...quietNow, urgent: false } } });
  const quietTest = pend({ kind: "test", notification_prefs: { quiet: quietNow } });
  const due = new Date(Date.now() - 1000).toISOString();
  const heldA1 = pend({ user_id: docA, push_after: due });
  const heldA2 = pend({ user_id: docA, kind: "day_end", push_after: due });
  const heldB = pend({ user_id: docB, push_after: due });
  const plan = worker.planDelivery([
    plain, read, appOnly, quietDigest, quietBooking, quietReminder, quietUrgent, quietUrgentHeld, quietTest, heldA1, heldA2, heldB,
  ]);
  const pushed = new Set(plan.push.map((p) => p.id));
  const held = new Map(plan.hold.map((h) => [h.id, h.until]));
  check("an ordinary one goes straight to the phone", pushed.has(plain.id));
  check("one already read in the app is not pushed after the fact", plan.skip.includes(read.id));
  check("'app only' keeps it off the phone", plan.skip.includes(appOnly.id));
  check("in quiet hours a summary waits for the morning", held.has(quietDigest.id));
  check(
    "and waits exactly until quiet hours end",
    held.get(quietDigest.id) === kinds.quietUntil(quietNow, local())?.toUTC().toISO()
  );
  check("a booking waits too, rather than being lost", held.has(quietBooking.id));
  check("a reminder that would arrive late is not held at all", plan.skip.includes(quietReminder.id));
  check("an urgent one comes through when allowed", pushed.has(quietUrgent.id));
  check("and waits when the person said not even those", held.has(quietUrgentHeld.id));
  check("a test the person asked for always comes through", pushed.has(quietTest.id));
  check(
    "what was held for one person comes out as a single summary",
    plan.summaries.get(docA)?.length === 2 && !pushed.has(heldA1.id)
  );
  check("a single held one is simply pushed", pushed.has(heldB.id) && !plan.summaries.has(docB));

  /* ============================================ 3. writing a notification */
  console.log("\n[3. telling a colleague, and switches that silence]");
  const ctx = { userId: rec, clinicId: clinic.id, role: "receptionist", isAdmin: false };
  let threw = "";
  try {
    await withCtx(ctx, (c) =>
      notifyClinicStaff(c, clinic.id, {
        kind: "document_signed",
        title: `signed ${tag}`,
        roles: ["owner", "receptionist"],
      })
    );
  } catch (e) {
    threw = (e as Error).message;
  }
  check("a member can notify a colleague from inside their own transaction", !threw, threw);
  check(
    "and the colleague has it",
    (await count(`select count(*)::int n from notifications where user_id = $1 and title = $2`, [owner, `signed ${tag}`])) === 1
  );
  threw = "";
  try {
    await withCtx(ctx, (c) =>
      notifyUser(c, stranger, { clinicId: other.id, kind: "document_signed", title: `leak ${tag}` })
    );
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    "someone outside the clinic is skipped, not written and not an error",
    !threw &&
      (await count(`select count(*)::int n from notifications where user_id = $1`, [stranger])) === 0,
    threw
  );

  const setPrefs = (userId: string, prefs: Record<string, unknown>) =>
    db.query(`update users set notification_prefs = $2 where id = $1`, [userId, JSON.stringify(prefs)]);
  await setPrefs(docB, { new_booking: "off", whatsapp: "off" });
  await workerSystem(async (c) => {
    await notifyUser(c, docB, { clinicId: clinic.id, kind: "appointment_booked", title: `muted ${tag}` });
    await notifyUser(c, docB, { clinicId: clinic.id, kind: "ai_booking", title: `muted ${tag}` });
    await notifyUser(c, docB, { clinicId: clinic.id, kind: "whatsapp_errors", title: `must ${tag}` });
    await notifyUser(c, docB, { clinicId: clinic.id, kind: "day_end", title: `other ${tag}` });
  });
  check(
    "a kind switched off never lands",
    (await count(`select count(*)::int n from notifications where user_id = $1 and title = $2`, [docB, `muted ${tag}`])) === 0
  );
  check(
    "an alert that cannot be switched off still lands",
    (await count(`select count(*)::int n from notifications where user_id = $1 and title = $2`, [docB, `must ${tag}`])) === 1
  );
  check(
    "and switching one kind off leaves the others alone",
    (await count(`select count(*)::int n from notifications where user_id = $1 and title = $2`, [docB, `other ${tag}`])) === 1
  );
  await setPrefs(docB, {});

  /* ======================================================= 4. reminders */
  console.log("\n[4. reminders]");
  // Its reminder moment five minutes ago: a worker restarting over a deploy.
  const late = await appt(local().plus({ minutes: 25 }));
  // Its moment a quarter of an hour ago: too late to be a reminder any more.
  const tooLate = await appt(local().plus({ minutes: 15 }), { doctor: mB });
  await worker.doctorReminders();
  await worker.doctorReminders();
  const remA = await rowsFor(docA, "doctor_reminder");
  check("a reminder missed by a few minutes is still sent", remA.length === 1, `${remA.length}`);
  check("in the doctor's own language", remA[0]?.title.startsWith("Your next appointment at"), remA[0]?.title);
  check("a second tick does not repeat it", remA.length === 1);
  check("one whose moment is long gone is not sent late", (await rowsFor(docB, "doctor_reminder")).length === 0);
  // Moved later, to a time whose reminder moment has just passed.
  await db.query(`update appointments set starts_at = $2, ends_at = $2::timestamptz + interval '30 minutes' where id = $1`, [
    late,
    local().plus({ minutes: 29 }).toUTC().toISO(),
  ]);
  await worker.doctorReminders();
  const remA2 = await rowsFor(docA, "doctor_reminder");
  check("moving the appointment earns a reminder at its new time", remA2.length === 2, `${remA2.length}`);
  await db.query(`update appointments set status = 'cancelled' where id = any($1::uuid[])`, [[late, tooLate]]);

  /* ============================================== 5. instant alerts */
  console.log("\n[5. booked, cancelled, moved]");
  const job = () => randomUUID();
  const tomorrow10 = local().plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  const x = await appt(tomorrow10);
  await worker.appointmentAlerts("appointment_created", clinic.id, { appointmentId: x, actorUserId: rec, source: "staff" }, job());
  const bookedA = await rowsFor(docA, "appointment_booked");
  check("the doctor hears a new appointment is theirs", bookedA.length === 1, bookedA[0]?.title);
  check("in their own words", bookedA[0]?.title === NT.en.bookedOwn("سلمى النجار"), bookedA[0]?.title);
  check("the person who booked it is not told", (await rowsFor(rec, "appointment_booked")).length === 0);
  check("and nobody the alert does not name", (await rowsFor(owner, "appointment_booked")).length === 0);

  const sameJob = job();
  const y = await appt(tomorrow10.plus({ hours: 1 }));
  await worker.appointmentAlerts("appointment_created", clinic.id, { appointmentId: y, actorUserId: docA }, sameJob);
  check("a doctor booking their own patient is not told about it", (await rowsFor(docA, "appointment_booked")).length === 1);

  await db.query(
    `update clinic_staff_alerts set roles = array['doctor','owner','receptionist']::text[] where clinic_id = $1 and kind = 'appointment_booked'`,
    [clinic.id]
  );
  const z = await appt(tomorrow10.plus({ hours: 2 }));
  await worker.appointmentAlerts("appointment_created", clinic.id, { appointmentId: z, source: "booking_link" }, job());
  check(
    "a booking-link booking reaches the doctor but not the desk again",
    (await rowsFor(docA, "appointment_booked")).length === 2 &&
      (await rowsFor(owner, "appointment_booked")).length === 0 &&
      (await rowsFor(rec, "appointment_booked")).length === 0
  );
  const zz = await appt(tomorrow10.plus({ hours: 3 }), { doctor: mB });
  const zzJob = job();
  await worker.appointmentAlerts("appointment_created", clinic.id, { appointmentId: zz, actorUserId: rec, source: "staff" }, zzJob);
  await worker.appointmentAlerts("appointment_created", clinic.id, { appointmentId: zz, actorUserId: rec, source: "staff" }, zzJob);
  const ownerBooked = await rowsFor(owner, "appointment_booked");
  check("the team members an alert names hear it too", ownerBooked.length === 1, ownerBooked[0]?.title);
  check("with the doctor's name in it", ownerBooked[0]?.body.includes("د. بشرى"), ownerBooked[0]?.body);
  check("a retried job does not send twice", (await rowsFor(docB, "appointment_booked")).length === 1);
  await db.query(
    `update clinic_staff_alerts set roles = array['doctor']::text[] where clinic_id = $1 and kind = 'appointment_booked'`,
    [clinic.id]
  );

  const pending = await appt(tomorrow10.plus({ hours: 4 }), { status: "pending_approval" });
  await worker.appointmentAlerts("appointment_created", clinic.id, { appointmentId: pending, source: "booking_link" }, job());
  check("a request still awaiting approval is not on anybody's list yet", (await rowsFor(docA, "appointment_booked")).length === 2);
  await db.query(`update appointments set status = 'confirmed' where id = $1`, [pending]);
  await worker.appointmentAlerts(
    "appointment_status_changed",
    clinic.id,
    { appointmentId: pending, status: "confirmed", previousStatus: "pending_approval", actorUserId: rec },
    job()
  );
  check("approving it is when the doctor hears", (await rowsFor(docA, "appointment_booked")).length === 3);

  await db.query(`update appointments set status = 'cancelled' where id = $1`, [x]);
  await worker.appointmentAlerts(
    "appointment_status_changed",
    clinic.id,
    { appointmentId: x, status: "cancelled", previousStatus: "confirmed", actorUserId: rec },
    job()
  );
  await worker.appointmentAlerts(
    "appointment_status_changed",
    clinic.id,
    { appointmentId: x, status: "cancelled", previousStatus: "cancelled", actorUserId: rec },
    job()
  );
  const cancelledA = await rowsFor(docA, "appointment_cancelled");
  check("the doctor hears of a cancellation", cancelledA.length === 1, cancelledA[0]?.title);
  check("cancelling what was already cancelled is not a second one", cancelledA.length === 1);

  const wasAt = tomorrow10.plus({ hours: 1 });
  await db.query(
    `update appointments set starts_at = $2, ends_at = $2::timestamptz + interval '30 minutes' where id = $1`,
    [y, tomorrow10.plus({ hours: 5 }).toUTC().toISO()]
  );
  const movedJob = (
    await db.query(
      `insert into jobs (clinic_id, kind, payload, status, dedupe_key) values ($1, 'trigger:appointment_rescheduled', '{}', 'done', $2) returning id`,
      [clinic.id, `appointment_rescheduled:${y}`]
    )
  ).rows[0].id;
  await worker.appointmentAlerts(
    "appointment_rescheduled",
    clinic.id,
    { appointmentId: y, actorUserId: rec, previousStartsAt: wasAt.toUTC().toISO(), previousDoctorMemberId: mA },
    movedJob
  );
  const movedA = await rowsFor(docA, "appointment_rescheduled");
  check("a move tells the doctor where it went and where it was", movedA.length === 1 && movedA[0].body.includes("(was"), movedA[0]?.body);
  check(
    "and frees the key, so the next move is its own event",
    (await db.query(`select dedupe_key from jobs where id = $1`, [movedJob])).rows[0].dedupe_key === null
  );

  await db.query(`update appointments set doctor_member_id = $2 where id = $1`, [y, mB]);
  await worker.appointmentAlerts(
    "appointment_rescheduled",
    clinic.id,
    { appointmentId: y, actorUserId: rec, previousStartsAt: tomorrow10.plus({ hours: 5 }).toUTC().toISO(), previousDoctorMemberId: mA },
    job()
  );
  const away = await rowsFor(docA, "appointment_rescheduled");
  const arrived = await rowsFor(docB, "appointment_rescheduled");
  check("handing it to another doctor tells the one who lost it", away.length === 2 && away[1].title === NT.en.awayTitle("سلمى النجار"), away[1]?.title);
  check("and the one who gained it", arrived.length === 1 && arrived[0].title === NT.ar.bookedOwn("سلمى النجار"), arrived[0]?.title);

  await worker.appointmentAlerts(
    "appointment_rescheduled",
    clinic.id,
    { appointmentId: y, previousStartsAt: tomorrow10.plus({ hours: 5 }).toUTC().toISO(), previousDoctorMemberId: mB },
    job()
  );
  check("moved and moved back inside the minute is nothing", (await rowsFor(docB, "appointment_rescheduled")).length === 1);

  const past = await appt(local().minus({ days: 1 }));
  await worker.appointmentAlerts("appointment_created", clinic.id, { appointmentId: past, actorUserId: rec }, job());
  check("yesterday's walk-in entered today wakes nobody", (await rowsFor(docA, "appointment_booked")).length === 3);

  await db.query(`update clinic_staff_alerts set enabled = false where clinic_id = $1 and kind = 'appointment_cancelled'`, [clinic.id]);
  await db.query(`update appointments set status = 'cancelled' where id = $1`, [zz]);
  await worker.appointmentAlerts(
    "appointment_status_changed",
    clinic.id,
    { appointmentId: zz, status: "cancelled", previousStatus: "confirmed", actorUserId: rec },
    job()
  );
  check("an alert the clinic switched off stays off", (await rowsFor(docB, "appointment_cancelled")).length === 0);
  await db.query(`update clinic_staff_alerts set enabled = true where clinic_id = $1 and kind = 'appointment_cancelled'`, [clinic.id]);

  /* ============================================== 6. role summaries */
  console.log("\n[6. summaries by role]");
  const alertRow = async (kind: string, roles: string[], extra: Record<string, unknown> = {}) => {
    await db.query(`update clinic_staff_alerts set roles = $3 where clinic_id = $1 and kind = $2`, [clinic.id, kind, roles]);
    const a = (
      await db.query(
        `select a.id, a.clinic_id, a.kind, a.roles, a.at_hour, a.weekday, a.threshold, cl.slug, cl.timezone, cl.currency
           from clinic_staff_alerts a join clinics cl on cl.id = a.clinic_id where a.clinic_id = $1 and a.kind = $2`,
        [clinic.id, kind]
      )
    ).rows[0];
    return { ...a, ...extra } as import("../worker/notifications").DigestAlert;
  };
  // Tomorrow now holds: y (docB, moved), z (docA), pending (docA, confirmed), zz (cancelled), x (cancelled).
  await appt(tomorrow10.plus({ hours: 6 }), { status: "scheduled" });
  await appt(tomorrow10.plus({ hours: 7 }), { doctor: mB, status: "scheduled" });
  const now = local();
  await workerSystem(async (c) => worker.sendDigest(c, await alertRow("unconfirmed_tomorrow", ["owner", "receptionist"]), now));
  const unconf = await rowsFor(rec, "unconfirmed_tomorrow");
  check("reception is told how many of tomorrow's are unconfirmed", unconf.length === 1 && unconf[0].title.includes("2"), unconf[0]?.title);
  check("so is the owner, once", (await rowsFor(owner, "unconfirmed_tomorrow")).length === 1);
  check("and a doctor the alert does not name is not", (await rowsFor(docA, "unconfirmed_tomorrow")).length === 0);

  await workerSystem(async (c) => worker.sendDigest(c, await alertRow("tomorrow_schedule", ["doctor", "receptionist"]), now));
  const tomA = await rowsFor(docA, "tomorrow_schedule");
  const tomRec = await rowsFor(rec, "tomorrow_schedule");
  check("a doctor gets their own list for tomorrow", tomA[0]?.title === NT.en.tomorrowOwn(NT.en.appts(3)), tomA[0]?.title);
  check("reception gets the clinic's", tomRec[0]?.title === NT.ar.tomorrowClinic(NT.ar.appts(5)), tomRec[0]?.title);

  // One completed visit in the week, so there is a week to report at all. The
  // takings are then the owner's line whatever they come to — even 0.00 is a
  // number a doctor without the permission must not be sent.
  await appt(local().minus({ days: 3 }).set({ hour: 11 }), { status: "completed" });
  await workerSystem(async (c) => worker.sendDigest(c, await alertRow("weekly_summary", ["owner", "doctor"]), now));
  const weekOwner = await rowsFor(owner, "weekly_summary");
  const weekDoc = await rowsFor(docA, "weekly_summary");
  check("the owner's week carries the takings", weekOwner[0]?.body.includes("JOD") ?? false, weekOwner[0]?.body);
  check("a doctor's week does not", !!weekDoc[0] && !weekDoc[0].body.includes("JOD"), weekDoc[0]?.body);

  await db.query(`insert into conversations (clinic_id, phone_e164, unread_count) values ($1, '+962790009876', 4)`, [clinic.id]);
  await workerSystem(async (c) =>
    worker.sendDigest(c, { ...(await alertRow("unread_digest", ["doctor", "receptionist"])), threshold: 0 }, now)
  );
  check("reception hears about unread messages", (await rowsFor(rec, "unread_digest")).length === 1);
  check("a doctor who cannot open the inbox is not sent a link to it", (await rowsFor(docA, "unread_digest")).length === 0);

  // The weekday gate. Only meaningful inside the catch-up window after the hour.
  if (now.minute < 14) {
    await db.query(
      `update clinic_staff_alerts set at_hour = $2, weekday = $3, roles = array['owner']::text[] where clinic_id = $1 and kind = 'weekly_summary'`,
      [clinic.id, now.hour, (now.weekday % 7) + 1]
    );
    await db.query(`delete from notifications where user_id = $1 and kind = 'weekly_summary'`, [owner]);
    await worker.dailyDigests();
    check("the weekly summary waits for its own weekday", (await rowsFor(owner, "weekly_summary")).length === 0);
  } else {
    console.log("  · weekday gate not checked: outside the catch-up window this hour");
  }

  /* ========================================= 7. realtime read events */
  console.log("\n[7. one event per mark-all, to every tab]");
  const listener = new Client({ connectionString: PG });
  await listener.connect();
  const heard: { op: string; user_id?: string }[] = [];
  listener.on("notification", (m) => {
    try {
      const e = JSON.parse(m.payload ?? "{}");
      if (e.t === "notifications" && e.user_id === docA) heard.push(e);
    } catch {}
  });
  await listener.query("listen app_events");
  await db.query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [docA]);
  await wait(400);
  check("marking everything read is one event, not one per row", heard.filter((e) => e.op === "update").length === 1, `${heard.length}`);
  await db.query(`update notifications set push_sent = true where user_id = $1`, [docA]);
  await wait(300);
  check("the worker marking rows pushed wakes nobody", heard.length === 1, `${heard.length}`);
  await listener.end();

  /* =================================================== 8. the browser */
  console.log("\n[8. in the app]");
  const up = await fetch(`${BASE}/login`).then((r) => r.ok).catch(() => false);
  if (!up) {
    check("the dev server is up for the browser checks", false, BASE);
  } else {
    const browser = await chromium.launch({ channel: "chromium" });
    const errors: string[] = [];
    const login = async (email: string, viewport = { width: 1280, height: 860 }) => {
      const context = await browser.newContext({ viewport });
      /*
        Count live connections: every EventSource the page opens, and how many
        are open at once. A string, not a function: tsx compiles a function with
        helpers (`__name`) that do not exist inside the page.
      */
      await context.addInitScript(`
        (() => {
          const Native = window.EventSource;
          window.__es = { open: 0, max: 0 };
          class Counted extends Native {
            constructor(url, init) {
              super(url, init);
              window.__es.open++;
              window.__es.max = Math.max(window.__es.max, window.__es.open);
            }
            close() {
              if (this.readyState !== 2) window.__es.open--;
              super.close();
            }
          }
          window.EventSource = Counted;
        })();
      `);
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${BASE}/login`);
      await page.waitForLoadState("networkidle");
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="password"]', "password123");
      await page.click('button[type="submit"]');
      await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
      return page;
    };
    const text = async (page: Page, sel = "body") => (await page.locator(sel).first().innerText()).replace(/\s+/g, " ");

    const page = await login(`qa-reception-${tag}@test.local`);
    /*
      Compile the routes the header calls before timing it. On a dev server the
      first request to a route compiles it — ten seconds and more — and a pop-up
      that arrives after its own eight seconds on screen have already run out
      looks exactly like one that never came.
    */
    await page.evaluate(async () => {
      await fetch("/api/me/notifications?count");
      await fetch(`/api/me/notifications?since=${encodeURIComponent(new Date().toISOString())}`);
    });
    await db.query(`update notifications set read_at = now() where user_id = $1`, [rec]);
    await page.goto(`${BASE}/c/${slug}/patients`);
    await page.waitForLoadState("networkidle");
    const bell = page.locator(`aside a[href="/c/${slug}/notifications"]`);
    check("the bell starts with nothing unread", (await bell.getAttribute("data-unread")) === "0");

    const title = `حجز جديد: اختبار ${tag}`;
    await workerSystem((c) =>
      notifyUser(c, rec, { clinicId: clinic.id, kind: "booking", title, body: "كشفية · غداً", url: `/c/${slug}/calendar` })
    );
    const popup = page.locator("[data-notification-popup]").first();
    const shown = await popup.waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    check("a new notification pops up on whatever screen is open", shown && (await text(page, "[data-notification-popup]")).includes(title));
    check(
      "and the bell counts it",
      !!(await until(async () => (await bell.getAttribute("data-unread")) === "1", 5000)) && (await bell.innerText()).includes("1")
    );
    await popup.locator("button").first().click();
    await page.waitForURL((u) => u.pathname.endsWith("/calendar"), { timeout: 15000 }).catch(() => {});
    check("tapping it opens what it is about", page.url().includes(`/c/${slug}/calendar`), page.url());
    check(
      "and marks it read",
      !!(await until(
        async () =>
          (await count(`select count(*)::int n from notifications where user_id = $1 and title = $2 and read_at is not null`, [rec, title])) === 1
      ))
    );
    check("so the bell clears", !!(await until(async () => (await bell.getAttribute("data-unread")) === "0", 8000)));

    /*
      One live connection per tab, whatever the screen. Loaded fresh on the
      inbox, then moved to the calendar and patients inside the app — the moves
      are where the connection changes hands, so they are what is checked.
    */
    await page.goto(`${BASE}/c/${slug}/conversations`);
    await page.waitForLoadState("networkidle");
    await page.locator(`aside a[href="/c/${slug}/calendar"]`).click();
    await page.waitForURL((u) => u.pathname.endsWith("/calendar"), { timeout: 15000 });
    await wait(800);
    await page.locator(`aside a[href="/c/${slug}/patients"]`).click();
    await page.waitForURL((u) => u.pathname.endsWith("/patients"), { timeout: 15000 });
    await wait(800);
    const es = await page.evaluate(() => (window as unknown as { __es: { open: number; max: number } }).__es);
    check("the header and the screen share one live connection", es.open === 1, JSON.stringify(es));
    check("never more than a brief overlap while it changes hands", es.max <= 2, JSON.stringify(es));

    await page.goto(`${BASE}/c/${slug}/notifications?tab=settings`);
    await page.waitForLoadState("networkidle");
    const settingsText = await text(page, "main");
    check(
      "the settings show reception's switches",
      settingsText.includes(ar.notifications.prefs.new_booking.label) && settingsText.includes(ar.notifications.prefs.unread_digest.label),
      settingsText.slice(0, 120)
    );
    check("and not a doctor's", !settingsText.includes(ar.notifications.prefs.doctor_reminder.label));
    await page.locator('[data-pref="new_booking"] select').selectOption("app");
    check(
      "choosing 'app only' is saved",
      !!(await until(async () => (await db.query(`select notification_prefs->>'new_booking' v from users where id = $1`, [rec])).rows[0].v === "app"))
    );
    await page.getByRole("switch", { name: ar.notifications.quietOn }).click();
    check(
      "quiet hours are saved",
      !!(await until(async () => (await db.query(`select notification_prefs->'quiet'->>'on' v from users where id = $1`, [rec])).rows[0].v === "true"))
    );
    await page.getByRole("switch", { name: ar.notifications.popups }).click();
    check(
      "turning pop-ups off is saved",
      !!(await until(async () => (await db.query(`select notification_prefs->>'popups' v from users where id = $1`, [rec])).rows[0].v === "false"))
    );
    await page.goto(`${BASE}/c/${slug}/patients`);
    await page.waitForLoadState("networkidle");
    await workerSystem((c) => notifyUser(c, rec, { clinicId: clinic.id, kind: "booking", title: `quiet ${tag}` }));
    await until(async () => (await bell.getAttribute("data-unread")) === "1", 8000);
    await wait(1200);
    check("with pop-ups off the bell still counts", (await bell.getAttribute("data-unread")) === "1");
    check("but nothing pops up", (await page.locator("[data-notification-popup]").count()) === 0);

    await page.goto(`${BASE}/c/${slug}/notifications?tab=settings`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: ar.notifications.sendTest }).click();
    check(
      "'send me a test' sends one",
      !!(await until(async () => (await count(`select count(*)::int n from notifications where user_id = $1 and kind = 'test'`, [rec])) >= 1))
    );
    const api = await page.evaluate(async () => (await fetch("/api/me/notifications?count")).json());
    const dbUnread = await count(`select count(*)::int n from notifications where user_id = $1 and read_at is null`, [rec]);
    check("the badge's count is the database's", api.unread === dbUnread, `${api.unread} vs ${dbUnread}`);

    await page.getByRole("tab", { name: ar.notifications.tabInbox }).click();
    await page.getByRole("button", { name: ar.notifications.filterUnread }).click();
    await wait(800);
    const inbox = await text(page, "main");
    check("the unread filter lists what is unread", inbox.includes(`quiet ${tag}`), inbox.slice(0, 160));
    await page.getByRole("button", { name: ar.notifications.markAllRead }).click();
    check(
      "mark all read clears it everywhere",
      !!(await until(async () => (await bell.getAttribute("data-unread")) === "0", 8000))
    );

    // On a phone the notifications are in the More sheet: the sheet's button carries the news.
    const phone = await login(`qa-reception-${tag}@test.local`, { width: 390, height: 844 });
    await phone.goto(`${BASE}/c/${slug}/patients`);
    await phone.waitForLoadState("networkidle");
    await workerSystem((c) => notifyUser(c, rec, { clinicId: clinic.id, kind: "booking", title: `phone ${tag}` }));
    const more = phone.locator("nav button[aria-expanded]");
    check(
      "on a phone the More button says there is something unread",
      !!(await until(async () => ((await more.getAttribute("aria-label")) ?? "").includes("(1)"), 8000)),
      (await more.getAttribute("aria-label")) ?? "none"
    );

    // The owner's side: templates for each role on the team-alerts tab.
    const op = await login(`qa-owner-${tag}@test.local`);
    await op.goto(`${BASE}/c/${slug}/automations?tab=alerts`);
    await op.waitForLoadState("networkidle");
    const alertsText = await text(op, "main");
    check(
      "the new team alerts are listed",
      alertsText.includes(ar.automations.alertKinds.appointment_booked) && alertsText.includes(ar.automations.alertKinds.weekly_summary)
    );
    const before = await count(`select count(*)::int n from clinic_staff_alerts where clinic_id = $1`, [clinic.id]);
    await op.getByRole("button", { name: ar.automations.addAlert }).first().click();
    const dialog = op.getByRole("dialog");
    await dialog.waitFor({ timeout: 15000 });
    check("templates are offered by role", (await dialog.innerText()).includes(ar.automations.templatesFor.receptionist));
    await dialog.locator('[data-template="rec-unconfirmed"]').click();
    await dialog.getByRole("button", { name: ar.common.save }).click();
    const added = await until(async () => {
      const r = await db.query(
        `select kind, roles, at_hour from clinic_staff_alerts where clinic_id = $1 order by created_at desc limit 1`,
        [clinic.id]
      );
      const n = await count(`select count(*)::int n from clinic_staff_alerts where clinic_id = $1`, [clinic.id]);
      return n === before + 1 ? r.rows[0] : null;
    });
    check(
      "and picking one saves exactly that alert",
      added?.kind === "unconfirmed_tomorrow" && added.roles.join() === "receptionist" && added.at_hour === 17,
      JSON.stringify(added)
    );

    check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await browser.close();
    void en;
  }

  /* ---------------------------------------------------------- teardown */
  await db.query(`delete from clinics where id = any($1::uuid[])`, [[clinic.id, other.id]]);
  await db.query(`delete from users where id = any($1::uuid[])`, [[owner, docA, docB, rec, stranger]]);
  await db.end();
  await workerPool.end();

  console.log(`\n  notifications: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
