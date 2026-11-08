/**
 * Every automation template, run for real.
 *
 * Validation only proves a template can be switched on. This proves it does
 * what its description says: each one is installed into a throwaway clinic,
 * its trigger is fired the way the app or the scheduler fires it, and the
 * engine runs — waits are fast-forwarded, patients "reply" — and the test reads
 * what came out: the WhatsApp text, the appointment booked, the task, the tag.
 *
 * It runs in its own database, created here and dropped at the end, with the
 * worker's code imported in-process. A worker left running on the main
 * database (often a day old, with older code) therefore cannot pick up these
 * jobs and run them its own way. Needs only Postgres on PG_PORT.
 *
 *   npx tsx scripts/qa-recipes.ts
 */
try {
  process.loadEnvFile?.();
} catch {
  /* rely on the real environment */
}

import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";

const PORT = process.env.PG_PORT || "5544";
const DB = `clinicos_qa_recipes_${Date.now().toString(36)}`;
const base = (url: string | undefined, fallback: string) => (url ?? fallback).replace(/\/[^/?]+(\?.*)?$/, `/${DB}$1`);
const SUPER = base(process.env.DATABASE_SUPER_URL, `postgres://postgres:postgres@127.0.0.1:${PORT}/clinicos`);
const APP = base(process.env.DATABASE_URL, `postgres://clinicos_app:clinicos_app@127.0.0.1:${PORT}/clinicos`);
const ADMIN = SUPER.replace(`/${DB}`, "/postgres");
const TZ = "Asia/Amman";

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

async function main() {
  // ---------------------------------------------------------------- a database of its own
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`create database ${DB}`);
  await admin.end();
  process.env.DATABASE_SUPER_URL = SUPER;
  process.env.DATABASE_URL = APP;
  console.log(`database ${DB}`);

  const db = new Client({ connectionString: SUPER });
  try {
    const { runMigrations } = await import("./lib-migrate");
    await runMigrations();
    await db.connect();
    const { seedAgencyDefaults, ALL_RECIPES } = await import("./seed-recipes");
    await seedAgencyDefaults(db);
    await run(db, ALL_RECIPES);
  } finally {
    await db.end().catch(() => {});
    const { pool } = await import("../worker/db");
    await pool.end().catch(() => {});
    const drop = new Client({ connectionString: ADMIN });
    await drop.connect();
    await drop.query(`drop database if exists ${DB} with (force)`).catch((e) => console.log("drop:", e.message));
    await drop.end();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  }
}

async function run(db: Client, recipes: { key: string }[]) {
  const { handleTrigger, advanceRun, resumeOnReply } = await import("../worker/automations");
  const sched = await import("../worker/scheduler");
  const { withSystem } = await import("../worker/db");
  const { writeFlowGraph } = await import("../src/lib/automation/store");
  const { treeToGraph } = await import("../src/lib/automation/graph");
  const { defaultSettingsFor, normalizeTriggerConfig } = await import("../src/lib/automation/catalog");
  const { renderSystemMessage } = await import("../src/lib/system-messages");
  const { installRecipes } = await import("../src/lib/clinic-provision");

  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const all = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;

  /* ---------------------------------------------------------------- the message renderer */
  console.log("\nmessages with empty values");
  check("a line whose only value is empty goes, emoji and all", renderSystemMessage("Hi\n📍 {{clinic.address}}\nBye", { "clinic.address": "" }) === "Hi\nBye");
  check(
    "so does a lead-in whose link is missing",
    renderSystemMessage("Thanks!\nRate us on Google: {{clinic.review_link}}", { "clinic.review_link": "" }) === "Thanks!"
  );
  check("a line with one value filled keeps it", renderSystemMessage("{{a}} and {{b}}", { a: "x", b: "" }) === "x and");

  /* ---------------------------------------------------------------- fixture */
  const slug = `qa-rec-${Date.now().toString(36)}`;
  const hours = JSON.stringify(Object.fromEntries(["sat", "sun", "mon", "tue", "wed", "thu", "fri"].map((d) => [d, [["08:00", "21:00"]]])));
  const clinic = (
    await one(
      `insert into clinics (name, name_ar, slug, timezone, working_hours, message_window_start, message_window_end, default_locale,
                            address_ar, google_maps_url, google_review_url, features)
       values ('QA Recipes', 'عيادة الوصفات', $1, $2, $3, '00:00', '23:59', 'ar', 'عمّان، الدوار السابع', 'https://maps.example/x', 'https://g.page/r/review', '{"dental": true}')
       returning id`,
      [slug, TZ, hours]
    )
  ).id as string;
  await db.query(`insert into booking_links (clinic_id, slug, name) values ($1, $2, 'الرابط')`, [clinic, slug]);
  const user = async (name: string) =>
    (await one(`insert into users (email, password_hash, full_name, locale) values ($1, 'x', $2, 'ar') returning id`, [`${randomUUID()}@qa.local`, name])).id as string;
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`, [
    clinic,
    await user("المالكة"),
  ]);
  const doctor = async (name: string) =>
    (await one(`insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'doctor') returning id`, [clinic, await user(name)])).id as string;
  const drA = await doctor("د. أمل");
  const drB = await doctor("د. باسل");
  const svcClean = (await one(`insert into services (clinic_id, name, name_ar, duration_min, price) values ($1, 'Cleaning', 'تنظيف', 30, 20) returning id`, [clinic])).id as string;
  const svcCheck = (await one(`insert into services (clinic_id, name, name_ar, duration_min, price) values ($1, 'Check-up', 'فحص', 20, 15) returning id`, [clinic])).id as string;

  // Every template, installed switched off; each test switches on only its own.
  const ids = new Map<string, string>();
  for (const r of await all(`select * from recipe_templates where active`)) {
    const g = treeToGraph(r.steps, randomUUID);
    const a = await one(
      `insert into automations (clinic_id, name, description, trigger_type, trigger_config, active, recipe_key, recipe_specialty, settings, canvas)
       values ($1, $2, $3, $4, $5, false, $6, $7, $8, '{"trigger": null}') returning id`,
      [clinic, r.name_ar, r.description, r.trigger_type, JSON.stringify(normalizeTriggerConfig(r.trigger_type, r.trigger_config)), r.key, r.specialty,
        JSON.stringify(defaultSettingsFor(r.trigger_type))]
    );
    await withSystem((c) => writeFlowGraph(c, clinic, a.id, g.nodes, g.edges));
    ids.set(r.key, a.id);
  }
  check("every template is in the gallery", ids.size === recipes.length, `${ids.size}/${recipes.length}`);
  const only = (key: string) => db.query(`update automations set active = (recipe_key = $2) where clinic_id = $1`, [clinic, key]);

  let n = 0;
  const patient = async (name: string, extra: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = { clinic_id: clinic, full_name: name, phone_e164: `+9627${String(90000000 + n++ * 7919).slice(0, 8)}`, source: "staff", ...extra };
    const cols = Object.keys(row);
    const vals = Object.values(row);
    return (await one(`insert into patients (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, vals)).id as string;
  };
  const appointment = async (p: string, o: { at: DateTime; doctor?: string; service?: string; status?: string; source?: string; created?: DateTime; extra?: Record<string, unknown> }) => {
    const cols = ["clinic_id", "patient_id", "doctor_member_id", "service_id", "starts_at", "ends_at", "status", "source", "created_at", ...Object.keys(o.extra ?? {})];
    const vals = [clinic, p, o.doctor ?? drA, o.service ?? svcClean, o.at.toUTC().toISO(), o.at.plus({ minutes: 30 }).toUTC().toISO(), o.status ?? "scheduled",
      o.source ?? "staff", (o.created ?? DateTime.now().minus({ days: 5 })).toUTC().toISO(), ...Object.values(o.extra ?? {})];
    return (await one(`insert into appointments (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, vals)).id as string;
  };
  const texts = async (p: string) =>
    (await all(
      `select m.body from messages m join conversations c on c.id = m.conversation_id
        where c.patient_id = $1 and m.sender_kind = 'automation' order by m.created_at, m.id`,
      [p]
    )).map((r) => String(r.body));
  const tasks = async (p: string) => (await all(`select title from tasks where patient_id = $1 order by created_at`, [p])).map((r) => String(r.title));
  const runOf = async (key: string, p: string) =>
    one(`select * from automation_runs where automation_id = $1 and patient_id = $2 order by started_at desc limit 1`, [ids.get(key), p]);
  const booked = (p: string, not: string[] = []) =>
    all(`select * from appointments where patient_id = $1 and source = 'automation' and not (id = any($2::uuid[]))`, [p, not]);

  /** The worker's job loop, for this database only. */
  const drain = async () => {
    for (let i = 0; i < 40; i++) {
      const jobs = await all(`select id, kind, payload, clinic_id from jobs where status = 'pending' and run_at <= now() order by created_at limit 50`);
      if (!jobs.length) return;
      for (const j of jobs) {
        await db.query(`update jobs set status = 'done' where id = $1`, [j.id]);
        if (j.kind === "automation:advance") await advanceRun(j.payload.runId);
        else if (j.kind.startsWith("trigger:")) await handleTrigger(j.kind.slice(8), j.clinic_id, j.payload);
      }
    }
  };
  const fire = async (kind: string, payload: Record<string, unknown>) => {
    await handleTrigger(kind, clinic, payload);
    await drain();
  };
  /** Let whatever the run is waiting for — the clock, or a reply that never comes — come now. */
  const skip = async (key: string, p: string) => {
    const r = await runOf(key, p);
    if (!r || r.status !== "waiting") return false;
    await db.query(`update automation_runs set status = 'running', wake_at = null, waiting_for = null where id = $1 and status = 'waiting'`, [r.id]);
    await advanceRun(r.id);
    await drain();
    return true;
  };
  const reply = async (p: string, body: string) => {
    await resumeOnReply(clinic, { patientId: p, body });
    await drain();
  };
  const today = DateTime.now().setZone(TZ).startOf("day");

  /* ================================================================ general */
  console.log("\nwelcome_new_patient");
  await only("welcome_new_patient");
  const pW = await patient("سارة ترحيب");
  await fire("patient_created", { patientId: pW });
  check("a patient the team adds is welcomed", (await texts(pW)).some((t) => t.includes("أهلاً بك في عيادة الوصفات")));
  const pWb = await patient("ليث حجز", { source: "booking_link" });
  await fire("patient_created", { patientId: pWb });
  check("one who booked online is not greeted twice", (await texts(pWb)).length === 0);

  console.log("\nconfirm_on_booking");
  await only("confirm_on_booking");
  const pC = await patient("هبة تأكيد");
  const aC = await appointment(pC, { at: today.plus({ days: 3, hours: 10 }) });
  await fire("appointment_created", { appointmentId: aC, patientId: pC, source: "staff" });
  const tC = (await texts(pC))[0] ?? "";
  check("says booked, with the day, time and address", tC.includes("تم حجز موعدك") && tC.includes("عمّان") && !tC.includes("تم تأكيد"), tC.slice(0, 60));

  console.log("\nfirst_visit_welcome");
  await only("first_visit_welcome");
  const pF = await patient("نور أولى");
  const aF = await appointment(pF, { at: today.plus({ days: 2, hours: 11 }) });
  await fire("appointment_created", { appointmentId: aF, patientId: pF, source: "staff" });
  check("waits ten minutes", (await runOf("first_visit_welcome", pF))?.status === "waiting");
  await skip("first_visit_welcome", pF);
  const tF = (await texts(pF))[0] ?? "";
  check("then the address, the map and what to bring", tF.includes("📍 عمّان") && tF.includes("maps.example") && tF.includes("الهوية"));

  console.log("\nreminder_24h");
  await only("reminder_24h");
  const pR = await patient("رامي تذكير");
  const aR = await appointment(pR, { at: DateTime.now().plus({ hours: 23, minutes: 58 }) });
  await sched.appointmentReminders();
  await drain();
  check("a day ahead, it reminds", (await texts(pR)).some((t) => t.includes("تذكير بموعدك") && t.includes("أرسل 1")));
  await reply(pR, "1");
  check("1 confirms the appointment", (await one(`select status from appointments where id = $1`, [aR])).status === "confirmed");
  check("and says so", (await texts(pR)).some((t) => t.includes("تم تأكيد موعدك")));
  await sched.appointmentReminders();
  await drain();
  check("a later tick does not remind again", (await texts(pR)).filter((t) => t.includes("تذكير بموعدك")).length === 1);

  const pRl = await patient("لينا متأخر");
  await appointment(pRl, { at: DateTime.now().plus({ hours: 18 }), created: DateTime.now().minus({ hours: 2 }) });
  const pRn = await patient("نادر الآن");
  await appointment(pRn, { at: DateTime.now().plus({ hours: 18 }), created: DateTime.now().minus({ minutes: 10 }) });
  await sched.appointmentReminders();
  await drain();
  check("booked 18 hours ahead, two hours ago: reminded (it used to get nothing)", (await texts(pRl)).some((t) => t.includes("تذكير بموعدك")));
  check("booked ten minutes ago: not yet, the confirmation is enough for now", (await texts(pRn)).length === 0);

  const pR2 = await patient("خالد تغيير");
  await appointment(pR2, { at: DateTime.now().plus({ hours: 23, minutes: 59 }) });
  await sched.appointmentReminders();
  await drain();
  await reply(pR2, "2");
  check("2 gives reception a call to make", (await tasks(pR2)).some((t) => t.includes("لتغيير موعده")));
  const pR3 = await patient("منى صامتة");
  const aR3 = await appointment(pR3, { at: DateTime.now().plus({ hours: 23, minutes: 59 }) });
  await sched.appointmentReminders();
  await drain();
  await skip("reminder_24h", pR3);
  check("no answer: a 'call to confirm' task", (await tasks(pR3)).some((t) => t.includes("لتأكيد موعده")));

  // Moved after its reminder: reminded again before the new time.
  const firstRun = await runOf("reminder_24h", pR3);
  await db.query(`update automation_runs set started_at = now() - interval '4 days' where id = $1`, [firstRun.id]);
  await db.query(`update appointments set starts_at = now() + interval '23 hours 59 minutes', ends_at = now() + interval '24 hours 29 minutes' where id = $1`, [aR3]);
  await sched.appointmentReminders();
  await drain();
  const again = await runOf("reminder_24h", pR3);
  check("an appointment moved after its reminder is reminded before its new time", again.id !== firstRun.id && again.status === "waiting", again.status);
  if (process.env.QA_DEBUG) console.log(await all(`select s.step_type, l.status, l.detail from automation_run_logs l left join automation_steps s on s.id = l.step_id where l.run_id = $1 order by l.created_at`, [again.id]));

  console.log("\nreminder_2h");
  await only("reminder_2h");
  const p2h = await patient("سامي ساعتين");
  await appointment(p2h, { at: DateTime.now().plus({ hours: 1, minutes: 59 }) });
  await sched.appointmentReminders();
  await drain();
  check("the same-day nudge, with the map", (await texts(p2h)).some((t) => t.includes("موعدك اليوم") && t.includes("maps.example")));

  console.log("\nrescheduled_notice");
  await only("rescheduled_notice");
  const pM = await patient("ريم نقل");
  const aM = await appointment(pM, { at: today.plus({ days: 4, hours: 13 }), doctor: drB });
  await fire("appointment_rescheduled", { appointmentId: aM, patientId: pM });
  check("the new time and the doctor", (await texts(pM)).some((t) => t.includes("تم تعديل موعدك") && t.includes("د. باسل")));

  console.log("\nnext_visit_due_book");
  await only("next_visit_due_book");
  const pN = await patient("وليد مراجعة");
  const visitN = await appointment(pN, {
    at: today.minus({ days: 12 }).plus({ hours: 10 }),
    status: "completed",
    doctor: drA,
    service: svcCheck,
    extra: { next_visit_days: 14, next_visit_member_id: drB },
  });
  const pNb = await patient("سلمى محجوزة");
  await appointment(pNb, { at: today.minus({ days: 12 }).plus({ hours: 10 }), status: "completed", extra: { next_visit_days: 14 } });
  await appointment(pNb, { at: today.plus({ days: 3, hours: 10 }) });
  await sched.nextVisitsDue({ force: true });
  await drain();
  check("two days before the doctor's 'come back', the patient is asked", (await texts(pN)).some((t) => t.includes("طلب منك طبيبك")));
  check("not one who already booked", (await texts(pNb)).length === 0);
  await sched.nextVisitsDue({ force: true });
  await drain();
  check("and only once", (await texts(pN)).filter((t) => t.includes("طلب منك طبيبك")).length === 1);
  await reply(pN, "تمام");
  const bN = await booked(pN);
  check("a yes books it", bN.length === 1);
  check("with the doctor the finish sheet named", bN[0]?.doctor_member_id === drB);
  check("for the same service, confirmed", bN[0]?.service_id === svcCheck && bN[0]?.status === "confirmed");
  check("and tells them when", (await texts(pN)).some((t) => t.includes("حجزنالك موعد") && t.includes("د. باسل")));
  void visitN;

  console.log("\nno_show_followup");
  await only("no_show_followup");
  const pX = await patient("طارق غائب");
  const aX = await appointment(pX, { at: today.plus({ hours: 9 }), status: "no_show", doctor: drB });
  await fire("appointment_status_changed", { appointmentId: aX, patientId: pX, status: "no_show" });
  check("tags the patient", ((await one(`select tags from patients where id = $1`, [pX])).tags as string[]).includes("لم يحضر"));
  await skip("no_show_followup", pX);
  check("an hour later, a kind message", (await texts(pX)).some((t) => t.includes("افتقدناك")));
  await reply(pX, "نعم");
  const bX = await booked(pX);
  check("a yes books the first free time with the same doctor", bX.length === 1 && bX[0].doctor_member_id === drB);

  console.log("\ncancelled_rebook");
  await only("cancelled_rebook");
  const pK = await patient("دانة ملغي");
  const aK = await appointment(pK, { at: today.plus({ days: 2, hours: 9 }), status: "cancelled" });
  await fire("appointment_status_changed", { appointmentId: aK, patientId: pK, status: "cancelled" });
  await skip("cancelled_rebook", pK);
  check("an hour later, an offer to rebook", (await texts(pK)).some((t) => t.includes("تم إلغاء موعدك") && t.includes("أرسل 1")));
  await reply(pK, "بعد العيد إن شاء الله");
  check("an answer that is not a yes goes to a person", (await one(`select flagged from conversations where patient_id = $1`, [pK])).flagged === true);
  check("and nothing is booked", (await booked(pK)).length === 0);

  console.log("\npost_visit_review");
  await only("post_visit_review");
  const pV = await patient("مها تقييم");
  const aV = await appointment(pV, { at: today.plus({ hours: 8 }), status: "completed" });
  await fire("appointment_status_changed", { appointmentId: aV, patientId: pV, status: "completed" });
  await skip("post_visit_review", pV);
  check("asks for a 1–5 rating", (await texts(pV)).some((t) => t.includes("من 1 إلى 5")));
  await reply(pV, "5");
  check("a 5 gets the Google review link", (await texts(pV)).some((t) => t.includes("g.page/r/review")));
  await db.query(`update clinics set google_review_url = null where id = $1`, [clinic]);
  const pV2 = await patient("عمر بلا رابط");
  const aV2 = await appointment(pV2, { at: today.plus({ hours: 8 }), status: "completed" });
  await fire("appointment_status_changed", { appointmentId: aV2, patientId: pV2, status: "completed" });
  await skip("post_visit_review", pV2);
  await reply(pV2, "ممتاز");
  const thanks = (await texts(pV2)).find((t) => t.includes("يسعدنا")) ?? "";
  check("without a review link, the thanks goes without an empty invitation", thanks.length > 0 && !thanks.includes("Google"), thanks);
  await db.query(`update clinics set google_review_url = 'https://g.page/r/review' where id = $1`, [clinic]);
  const pV3 = await patient("بشرى غير راضية");
  const aV3 = await appointment(pV3, { at: today.plus({ hours: 8 }), status: "completed" });
  await fire("appointment_status_changed", { appointmentId: aV3, patientId: pV3, status: "completed" });
  await skip("post_visit_review", pV3);
  await reply(pV3, "2");
  check("a 2 reaches the owner with a task to call", (await tasks(pV3)).some((t) => t.includes("بخصوص تقييمه")));

  console.log("\nrecall_6_months");
  await only("recall_6_months");
  const recallVisit = today.minus({ days: 180 }).plus({ hours: 12 });
  const pS = await patient("فراس دوري", { last_visit_at: recallVisit.toUTC().toISO() });
  await appointment(pS, { at: recallVisit, status: "completed", doctor: drB, service: svcCheck });
  const pSb = await patient("جنى لديها موعد", { last_visit_at: recallVisit.toUTC().toISO() });
  await appointment(pSb, { at: today.plus({ days: 5, hours: 10 }) });
  await sched.recallReminders({ force: true });
  await drain();
  check("six months on, the invitation", (await texts(pS)).some((t) => t.includes("6 أشهر")));
  check("not to a patient with a visit ahead", (await texts(pSb)).length === 0);
  await reply(pS, "1");
  const bS = await booked(pS);
  check("a yes books the same service with the same doctor as the last visit", bS.length === 1 && bS[0].doctor_member_id === drB && bS[0].service_id === svcCheck);

  console.log("\nbirthday");
  await only("birthday");
  const pB = await patient("لمى ميلاد", { birth_date: today.minus({ years: 30 }).toISODate() });
  await sched.birthdays({ force: true });
  await drain();
  check("a greeting on the day", (await texts(pB)).length === 1);
  await sched.birthdays({ force: true });
  await drain();
  check("once a day", (await texts(pB)).length === 1);
  // A year on: last year's greeting and run are a year old.
  await db.query(`update automation_runs set started_at = started_at - interval '365 days' where patient_id = $1`, [pB]);
  await db.query(`update messages set created_at = created_at - interval '365 days' where conversation_id in (select id from conversations where patient_id = $1)`, [pB]);
  await sched.birthdays({ force: true });
  await drain();
  check("and again next year (the same text used to be skipped for ever)", (await texts(pB)).length === 2);

  console.log("\nprescription_check_in");
  await only("prescription_check_in");
  const pP = await patient("حسن وصفة");
  await fire("prescription_sent", { patientId: pP });
  await skip("prescription_check_in", pP);
  check("three days on, how are you", (await texts(pP)).some((t) => t.includes("كيف حالك مع العلاج")));
  await reply(pP, "الحمد لله أحسن");
  check("an answer is flagged for the doctors", (await one(`select flagged from conversations where patient_id = $1`, [pP])).flagged === true);

  console.log("\nresults_ready");
  await only("results_ready");
  const pT = await patient("أسيل نتائج", { last_visit_at: today.minus({ days: 9 }).toUTC().toISO() });
  await appointment(pT, { at: today.minus({ days: 9 }).plus({ hours: 10 }), status: "completed", doctor: drB });
  await fire("tag_added", { patientId: pT, tag: "نتائج جاهزة" });
  check("the patient hears their results are in", (await texts(pT)).some((t) => t.includes("نتائج فحوصاتك وصلت")));
  await reply(pT, "1");
  check("and a yes books the review with the same doctor", (await booked(pT))[0]?.doctor_member_id === drB);

  console.log("\nbooking_needs_approval");
  await only("booking_needs_approval");
  const pA = await patient("سهى موافقة", { source: "booking_link" });
  const aA = await appointment(pA, { at: today.plus({ days: 2, hours: 12 }), status: "pending_approval", source: "booking_link" });
  await fire("booking_submitted", { appointmentId: aA, patientId: pA, status: "pending_approval" });
  check("a task for reception", (await tasks(pA)).some((t) => t.includes("راجع طلب حجز")));

  console.log("\nunpaid_invoice");
  await only("unpaid_invoice");
  const pI = await patient("زيد فاتورة");
  const sent = today.minus({ days: 3 }).plus({ hours: 12 });
  await db.query(
    `insert into invoices (clinic_id, patient_id, seq, number, status, subtotal, total, amount_paid, sent_at) values ($1, $2, 1, 'QA-1', 'sent', 40, 40, 10, $3)`,
    [clinic, pI, sent.toUTC().toISO()]
  );
  const pIp = await patient("سعاد مدفوعة");
  await db.query(
    `insert into invoices (clinic_id, patient_id, seq, number, status, subtotal, total, amount_paid, sent_at) values ($1, $2, 2, 'QA-2', 'paid', 40, 40, 40, $3)`,
    [clinic, pIp, sent.toUTC().toISO()]
  );
  await sched.unpaidInvoices({ force: true });
  await drain();
  check("three days unpaid: the balance and the link", (await texts(pI)).some((t) => t.includes("QA-1") && t.includes("30.00")));
  check("a paid one is left alone", (await texts(pIp)).length === 0);

  /* ================================================================ specialty */
  console.log("\ndental_ortho_recall");
  await only("dental_ortho_recall");
  const orthoVisit = today.minus({ days: 28 }).plus({ hours: 12 });
  const pO = await patient("ياسمين تقويم", { last_visit_at: orthoVisit.toUTC().toISO(), tags: ["تقويم"] });
  await appointment(pO, { at: orthoVisit, status: "completed", doctor: drB });
  const pOn = await patient("مازن عادي", { last_visit_at: orthoVisit.toUTC().toISO() });
  await sched.recallReminders({ force: true });
  await drain();
  check("braces patients are reminded", (await texts(pO)).some((t) => t.includes("شد التقويم")));
  check("other dental patients are not (it used to write to all of them)", (await texts(pOn)).length === 0);
  await reply(pO, "احجز");
  check("a yes books the adjustment", (await booked(pO)).length === 1);

  console.log("\nobgyn: antenatal and postpartum");
  await only("obgyn_antenatal_recall");
  const pG = await patient("رنا حامل", { last_visit_at: orthoVisit.toUTC().toISO(), tags: ["حامل"] });
  const pGn = await patient("علا غير حامل", { last_visit_at: orthoVisit.toUTC().toISO() });
  await sched.recallReminders({ force: true });
  await drain();
  check("pregnant patients are asked to their follow-up", (await texts(pG)).some((t) => t.includes("متابعة الحمل")));
  check("others are not", (await texts(pGn)).length === 0);
  await only("obgyn_postpartum_checkin");
  await fire("tag_added", { patientId: pG, tag: "ولادة" });
  check("after delivery the pregnancy tag comes off", !((await one(`select tags from patients where id = $1`, [pG])).tags as string[]).includes("حامل"));
  await skip("obgyn_postpartum_checkin", pG);
  check("forty days on, her own check", (await texts(pG)).some((t) => t.includes("فحص ما بعد الولادة")));

  console.log("\npeds_vaccine_recall");
  await only("peds_vaccine_recall");
  const vacVisit = today.minus({ days: 60 }).plus({ hours: 12 });
  const pBaby = await patient("رضيع", { last_visit_at: vacVisit.toUTC().toISO(), birth_date: today.minus({ months: 8 }).toISODate() });
  const pKid = await patient("طفل كبير", { last_visit_at: vacVisit.toUTC().toISO(), birth_date: today.minus({ years: 6 }).toISODate() });
  await sched.recallReminders({ force: true });
  await drain();
  check("an infant's parents are reminded", (await texts(pBaby)).some((t) => t.includes("مطعوم")));
  if (process.env.QA_DEBUG) { const rb = await runOf("peds_vaccine_recall", pBaby); console.log(rb?.status, rb && await all(`select s.step_type, l.status, l.detail from automation_run_logs l left join automation_steps s on s.id = l.step_id where l.run_id = $1 order by l.created_at`, [rb.id]), await one(`select birth_date, last_visit_at, status from patients where id = $1`, [pBaby])); }
  check("a six-year-old's are not", (await texts(pKid)).length === 0);
  await reply(pBaby, "1");
  check("a yes becomes a call to arrange it", (await tasks(pBaby)).some((t) => t.includes("موعد مطعوم")));

  console.log("\nphysio_lapsed_series");
  await only("physio_lapsed_series");
  const phVisit = today.minus({ days: 14 }).plus({ hours: 12 });
  const pPh = await patient("كريم علاج", { last_visit_at: phVisit.toUTC().toISO() });
  await appointment(pPh, { at: phVisit, status: "completed", doctor: drB });
  const pPd = await patient("هالة أنهت", { last_visit_at: phVisit.toUTC().toISO(), tags: ["أنهى البرنامج"] });
  await sched.recallReminders({ force: true });
  await drain();
  check("two weeks off a course: asked back", (await texts(pPh)).some((t) => t.includes("أسبوعين")));
  check("not one who finished", (await texts(pPd)).length === 0);
  await skip("physio_lapsed_series", pPh);
  check("no answer: a call on the to-do list", (await tasks(pPh)).some((t) => t.includes("متابعة انقطاع")));

  console.log("\npsych_discreet_reminder");
  await only("psych_discreet_reminder");
  const pY = await patient("مريض خاص");
  await appointment(pY, { at: DateTime.now().plus({ hours: 23, minutes: 58 }) });
  await sched.appointmentReminders();
  await drain();
  const tY = (await texts(pY))[0] ?? "";
  check("the time, and nothing that names the clinic", tY.includes("تذكير بموعدك") && !tY.includes("عيادة") && !tY.includes("تنظيف"), tY);
  await reply(pY, "1");
  check("1 confirms", (await all(`select status from appointments where patient_id = $1`, [pY]))[0].status === "confirmed");

  console.log("\nprep at booking (dermatology)");
  await only("derm_pre_session_prep");
  const pD = await patient("سلوى ليزر");
  const aD = await appointment(pD, { at: today.plus({ days: 6, hours: 10 }) });
  await fire("appointment_created", { appointmentId: aD, patientId: pD, source: "staff" });
  await skip("derm_pre_session_prep", pD);
  check("the preparation goes out at booking, days ahead", (await texts(pD)).some((t) => t.includes("الريتينول")));

  console.log("\nplastic surgery: instructions when surgery is scheduled");
  await only("plastic_pre_op_instructions");
  const pPl = await patient("عمر عملية");
  await fire("tag_added", { patientId: pPl, tag: "موعد عملية" });
  const tPl = (await texts(pPl))[0] ?? "";
  check("sent the moment it is scheduled", tPl.includes("تعليمات ما قبل العملية"));
  check("never tells the patient to stop a medicine on its own", tPl.includes("لا توقف أي دواء من نفسك"));

  /* ================================================================ a new clinic's defaults */
  console.log("\nwhat a new clinic starts with");
  const fresh = async (specialty: string) => {
    const id = (await one(`insert into clinics (name, slug, specialty) values ('Fresh', $1, $2) returning id`, [`qa-fresh-${randomUUID().slice(0, 8)}`, specialty])).id;
    await withSystem((c) => installRecipes(c, id, specialty as never));
    return (await all(`select recipe_key from automations where clinic_id = $1 and active`, [id])).map((r) => r.recipe_key as string);
  };
  const general = await fresh("general");
  check("reminders, confirmation and the doctor's recall are on", ["reminder_24h", "confirm_on_booking", "next_visit_due_book"].every((k) => general.includes(k)), general.join(","));
  const psych = await fresh("psychiatry");
  check("a psychiatry clinic gets the discreet reminder instead", psych.includes("psych_discreet_reminder") && !psych.includes("reminder_24h"), psych.join(","));

  /* ================================================================ the engine */
  console.log("\nengine");
  const failed = await all(`select r.error, a.recipe_key from automation_runs r join automations a on a.id = r.automation_id where r.status = 'failed'`);
  check("no run failed", failed.length === 0, failed.map((f) => `${f.recipe_key}: ${f.error}`).join(" | "));
  const stuck = await all(`select a.recipe_key from automation_runs r join automations a on a.id = r.automation_id where r.status = 'running'`);
  check("no run left stuck 'running'", stuck.length === 0, stuck.map((s) => s.recipe_key).join(","));
}

main().catch((e) => {
  console.error("QA FAILED:", e);
  process.exit(1);
});
