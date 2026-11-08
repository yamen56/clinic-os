/**
 * "Book an appointment" and "Add to the waitlist", the automation steps.
 *
 * The engine is exercised in-process — startRun and advanceRun from the
 * worker, against a throwaway clinic — so the suite proves this tree's code
 * whatever worker happens to be running. Then the builder, in a browser:
 * the step is offered, its outputs are drawn, and its settings open.
 *
 *   npx tsx scripts/qa-automation-booking.ts      (needs the dev stack for the browser part)
 */
try {
  process.loadEnvFile?.();
} catch {
  /* rely on the real environment */
}

import { Client } from "pg";
import bcrypt from "bcryptjs";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { writeFlowGraph } from "../src/lib/automation/store";
import { validateFlow, providesByNode, type FlowEdge, type FlowNode } from "../src/lib/automation/graph";
import { stepOutputs } from "../src/lib/automation/catalog";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
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

const node = (type: string, config: Record<string, unknown> = {}, id = randomUUID()): FlowNode => ({ id, type, config, position: null, label: "" });

async function main() {
  const { startRun, advanceRun } = await import("../worker/automations");
  const { withSystem, pool } = await import("../worker/db");
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

  /* ---------------------------------------------------------------- validation */
  console.log("\nvalidation");
  {
    const book = node("book_appointment");
    const r = validateFlow({ trigger: "birthday", triggerConfig: {}, nodes: [book], edges: [{ from: null, handle: "next", to: book.id }] });
    check("copying a birthday flow's appointment is refused", r.some((i) => i.code === "needs_appointment" && i.nodeId === book.id));

    const pick = node("book_appointment", { service: "pick", doctor: "any" });
    const r2 = validateFlow({ trigger: "birthday", triggerConfig: {}, nodes: [pick], edges: [{ from: null, handle: "next", to: pick.id }] });
    check("a chosen service has to be chosen", r2.some((i) => i.code === "no_service"));
    check("and that is all that is wrong", r2.filter((i) => i.severity === "error").length === 1, JSON.stringify(r2));

    check("three ways out", stepOutputs("book_appointment").join() === "booked,already_booked,no_slot");

    const b = node("book_appointment", { service: "pick", service_id: randomUUID(), doctor: "any" });
    const after = node("send_whatsapp", { message: "Booked for {{appointment.date}} at {{appointment.time}}" });
    const confirm = node("update_appointment", { status: "confirmed" });
    const none = node("send_whatsapp", { message: "Nothing free — we will call {{appointment.date}}" });
    const edges: FlowEdge[] = [
      { from: null, handle: "next", to: b.id },
      { from: b.id, handle: "booked", to: after.id },
      { from: after.id, handle: "next", to: confirm.id },
      { from: b.id, handle: "no_slot", to: none.id },
    ];
    const nodes = [b, after, confirm, none];
    const seen = providesByNode(["patient"], nodes, edges);
    check("after a booking the run has an appointment", seen.get(after.id)?.includes("appointment") && seen.get(confirm.id)?.includes("appointment"));
    check("on the no-free-time path it does not", !seen.get(none.id)?.includes("appointment"));
    const r3 = validateFlow({ trigger: "birthday", triggerConfig: {}, nodes, edges });
    check("appointment words after a booking are fine", !r3.some((i) => i.nodeId === after.id));
    check("Confirm after a booking is allowed on a birthday flow", !r3.some((i) => i.nodeId === confirm.id));
    check("appointment words without one are flagged", r3.some((i) => i.nodeId === none.id && i.code === "unavailable_variable"));
  }

  /* ---------------------------------------------------------------- fixture */
  const slug = `qa-book-${Date.now().toString(36)}`;
  const hours = JSON.stringify(Object.fromEntries(["sat", "sun", "mon", "tue", "wed", "thu", "fri"].map((d) => [d, [["08:00", "21:00"]]])));
  const clinic = await one(
    `insert into clinics (name, name_ar, slug, timezone, working_hours, message_window_start, message_window_end, default_locale)
     values ('QA Booking', 'عيادة الحجز', $1, $2, $3, '00:00', '23:59', 'en') returning id`,
    [slug, TZ, hours]
  );
  const ownerEmail = `owner-${slug}@test.local`;
  const user = async (email: string, name: string) =>
    (await one(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [email, bcrypt.hashSync("password123", 10), name])).id as string;
  const owner = await user(ownerEmail, "QA Owner");
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`, [clinic.id, owner]);
  const doctor = async (name: string) => {
    const u = await user(`${name.toLowerCase().replace(/\W/g, "")}-${slug}@test.local`, name);
    return (await one(`insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'doctor') returning id`, [clinic.id, u])).id as string;
  };
  const drA = await doctor("Dr Amal");
  const drB = await doctor("Dr Basel");
  const cleaning = (await one(`insert into services (clinic_id, name, name_ar, duration_min, price) values ($1, 'Cleaning', 'تنظيف', 30, 20) returning id`, [clinic.id])).id as string;
  const checkup = (await one(`insert into services (clinic_id, name, name_ar, duration_min, price) values ($1, 'Check-up', 'فحص', 20, 15) returning id`, [clinic.id])).id as string;
  let n = 0;
  const patient = async (name: string) =>
    (await one(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, $2, $3, 'staff') returning id`, [
      clinic.id, name, `+96279${String(Date.now() % 1000000).padStart(6, "0")}${n++}`,
    ])).id as string;
  const pastVisit = async (patientId: string, serviceId: string, doctorId: string, localTime: string) => {
    const start = DateTime.now().setZone(TZ).minus({ days: 2 }).set({ hour: Number(localTime.slice(0, 2)), minute: Number(localTime.slice(3)), second: 0, millisecond: 0 });
    return (await one(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, $5, $6, 'completed') returning id`,
      [clinic.id, patientId, doctorId, serviceId, start.toUTC().toISO(), start.plus({ minutes: 30 }).toUTC().toISO()]
    )).id as string;
  };
  const flow = async (name: string, nodes: FlowNode[], edges: FlowEdge[], trigger = "appointment_status_changed") => {
    const a = await one(
      `insert into automations (clinic_id, name, trigger_type, trigger_config, active, settings, canvas)
       values ($1, $2, $3, '{}', true, '{}', '{"trigger": null}') returning id`,
      [clinic.id, name, trigger]
    );
    await withSystem((c) => writeFlowGraph(c, clinic.id, a.id, nodes, edges));
    return a.id as string;
  };
  const run = async (automationId: string, ctx: { patientId: string; appointmentId?: string | null }) => {
    const id = await withSystem((c) => startRun(c, clinic.id, automationId, ctx));
    if (!id) return null;
    await advanceRun(id);
    return (await one(`select * from automation_runs where id = $1`, [id])) as Record<string, unknown>;
  };
  const branchOf = async (runId: string, stepId: string) =>
    (await one(`select detail->>'branch' as b, detail from automation_run_logs where run_id = $1 and step_id = $2 order by created_at desc limit 1`, [runId, stepId])) as
      | { b: string | null; detail: Record<string, unknown> }
      | undefined;
  const today = DateTime.now().setZone(TZ).startOf("day");
  console.log(`\nfixture ${slug}`);

  /* ---------------------------------------------------------------- the follow-up */
  console.log("\na finished visit books its follow-up");
  const p1 = await patient("Hana Follow");
  const v1 = await pastVisit(p1, cleaning, drA, "10:00");
  const book1 = node("book_appointment", { service: "trigger", doctor: "trigger", after_days: 7, from: "now", search_days: 14, part_of_day: "any", status: "scheduled", skip_if_booked: true });
  const note1 = node("add_note", { body: "Next: {{appointment.date}} {{appointment.time}} with {{appointment.doctor}} for {{appointment.service}}" });
  const f1 = await flow("Book the follow-up", [book1, note1], [
    { from: null, handle: "next", to: book1.id },
    { from: book1.id, handle: "booked", to: note1.id },
  ]);
  const r1 = await run(f1, { patientId: p1, appointmentId: v1 });
  check("the run finishes", r1?.status === "completed", String(r1?.status ?? "not started"));
  const booked = await one(`select * from appointments where clinic_id = $1 and patient_id = $2 and id <> $3`, [clinic.id, p1, v1]);
  check("an appointment is booked", booked);
  check("marked as booked automatically", booked?.source === "automation");
  check("with the same doctor", booked?.doctor_member_id === drA);
  check("for the same service", booked?.service_id === cleaning);
  check("as booked, to be confirmed", booked?.status === "scheduled");
  const day1 = booked ? DateTime.fromJSDate(booked.starts_at).setZone(TZ) : null;
  check("about a week on, not before", day1 && day1.startOf("day") >= today.plus({ days: 7 }) && day1.startOf("day") <= today.plus({ days: 21 }), day1?.toISO() ?? "");
  check("inside the clinic's hours", day1 && day1.hour >= 8 && day1.hour < 21, day1?.toFormat("HH:mm") ?? "");
  check("thirty minutes long, as the service", booked && (booked.ends_at - booked.starts_at) / 60000 === 30);
  check("the run is now about the new appointment", r1?.appointment_id === booked?.id);
  check("and it took the Booked way", (await branchOf(String(r1?.id), book1.id))?.b === "booked");
  const n1 = await one(`select body from patient_notes where patient_id = $1 order by created_at desc limit 1`, [p1]);
  check("the next step speaks of the new appointment", n1 && !n1.body.includes("{{") && n1.body.includes(String(day1?.day)) && n1.body.includes("Dr Amal") && n1.body.includes("Cleaning"), n1?.body);
  const job = await one(`select payload from jobs where clinic_id = $1 and kind = 'trigger:appointment_created' and payload->>'appointmentId' = $2`, [clinic.id, booked?.id]);
  check("the clinic's own booking flows hear of it", job?.payload?.source === "automation");
  check("one step deeper in the chain", Number(job?.payload?.chainDepth) === 1);
  const aud = await one(`select detail from audit_log where action = 'appointment.create' and entity_id = $1`, [booked?.id]);
  check("the audit log says which automation booked it", aud?.detail?.automationId === f1);

  /* ---------------------------------------------------------------- already booked */
  console.log("\na patient with a visit ahead is not booked twice");
  const b2 = randomUUID();
  const f2 = await flow("Book again", [{ ...book1, id: b2 }], [{ from: null, handle: "next", to: b2 }]);
  const r2 = await run(f2, { patientId: p1, appointmentId: v1 });
  const count = (await one(`select count(*)::int as n from appointments where patient_id = $1 and status <> 'cancelled'`, [p1])).n;
  check("no second appointment", count === 2, String(count));
  check("it took the Already booked way", (await branchOf(String(r2?.id), b2))?.b === "already_booked");
  check("and follows the visit already ahead", r2?.appointment_id === booked?.id);

  /* ---------------------------------------------------------------- time of day, chosen service */
  console.log("\nthe evening, any doctor, a chosen service");
  const p3 = await patient("Rami Evening");
  const book3 = node("book_appointment", { service: "pick", service_id: checkup, doctor: "any", after_days: 2, part_of_day: "evening", status: "confirmed" });
  const f3 = await flow("Evening check-up", [book3], [{ from: null, handle: "next", to: book3.id }], "patient_created");
  const r3 = await run(f3, { patientId: p3 });
  const ap3 = await one(`select * from appointments where patient_id = $1`, [p3]);
  const t3 = ap3 ? DateTime.fromJSDate(ap3.starts_at).setZone(TZ) : null;
  check("booked in the evening", t3 && t3.hour >= 17, t3?.toFormat("ccc HH:mm") ?? "none");
  check("for the chosen service", ap3?.service_id === checkup);
  check("by whichever doctor was free", ap3 && [drA, drB].includes(ap3.doctor_member_id));
  check("confirmed, as asked", ap3?.status === "confirmed");
  check("a flow with no appointment gains one", r3?.appointment_id === ap3?.id);

  /* ---------------------------------------------------------------- same time as before */
  console.log("\nthe same time as the last visit");
  const p5 = await patient("Lina Weekly");
  const v5 = await pastVisit(p5, cleaning, drB, "15:30");
  const book5 = node("book_appointment", { service: "trigger", doctor: "trigger", after_days: 7, from: "appointment", part_of_day: "same_time" });
  const f5 = await flow("Weekly at the same time", [book5], [{ from: null, handle: "next", to: book5.id }]);
  await run(f5, { patientId: p5, appointmentId: v5 });
  const ap5 = await one(`select * from appointments where patient_id = $1 and id <> $2`, [p5, v5]);
  const t5 = ap5 ? DateTime.fromJSDate(ap5.starts_at).setZone(TZ) : null;
  check("booked at 15:30 again", t5?.toFormat("HH:mm") === "15:30", t5?.toISO() ?? "none");
  check("a week after the last visit", t5 && Math.round(t5.startOf("day").diff(today.minus({ days: 2 }), "days").days) === 7, t5?.toISODate() ?? "");

  /* ---------------------------------------------------------------- no free time → waitlist */
  console.log("\nno free time puts the patient on the waitlist");
  const p4 = await patient("Omar Waiting");
  const v4 = await pastVisit(p4, cleaning, drB, "11:00");
  const blocked = today.plus({ days: 3 }).toISODate()!;
  await db.query(`update clinics set blocked_dates = $2 where id = $1`, [clinic.id, JSON.stringify([blocked])]);
  const book4 = node("book_appointment", { service: "trigger", doctor: "trigger", after_days: 3, search_days: 1 });
  const wait4 = node("add_to_waitlist", { service: "trigger", doctor: "trigger", within_days: 30, note: "From the follow-up flow for {{patient.first_name}}" });
  const f4 = await flow("Follow-up or waitlist", [book4, wait4], [
    { from: null, handle: "next", to: book4.id },
    { from: book4.id, handle: "no_slot", to: wait4.id },
  ]);
  const r4 = await run(f4, { patientId: p4, appointmentId: v4 });
  check("no appointment on a closed day", !(await one(`select 1 from appointments where patient_id = $1 and id <> $2`, [p4, v4])));
  check("it took the No free time way", (await branchOf(String(r4?.id), book4.id))?.b === "no_slot");
  const w = await one(`select * from waitlist_entries where patient_id = $1`, [p4]);
  check("the patient is on the waitlist", w?.status === "waiting");
  check("for the same doctor and service", w?.doctor_member_id === drB && w?.service_id === cleaning);
  check("from today for thirty days", w && DateTime.fromJSDate(w.earliest_date).toISODate() === today.toISODate() && DateTime.fromJSDate(w.latest_date).toISODate() === today.plus({ days: 30 }).toISODate(),
    w ? `${DateTime.fromJSDate(w.earliest_date).toISODate()}…${DateTime.fromJSDate(w.latest_date).toISODate()}` : "");
  check("with the desk's note, filled in", w?.note === "From the follow-up flow for Omar", w?.note);
  const w2 = randomUUID();
  const f4b = await flow("Waitlist again", [{ ...wait4, id: w2 }], [{ from: null, handle: "next", to: w2 }]);
  const r4b = await run(f4b, { patientId: p4, appointmentId: v4 });
  const again = await one(`select status, detail from automation_run_logs where run_id = $1 and step_id = $2`, [r4b?.id, w2]);
  check("a patient already waiting is not added twice", again?.status === "skipped" && again?.detail?.reason === "already_waiting");
  await db.query(`update clinics set blocked_dates = '[]' where id = $1`, [clinic.id]);

  /* ---------------------------------------------------------------- the builder */
  console.log("\nthe builder");
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/login`, { timeout: 180000 });
    await page.fill('input[name="email"]', ownerEmail);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 300000, waitUntil: "commit" });
    await page.goto(`${BASE}/c/${slug}/automations/${f4}`, { timeout: 300000, waitUntil: "domcontentloaded" });
    await page.waitForSelector(".react-flow__node", { timeout: 180000 });
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    const canvas = await page.locator(".react-flow").innerText();
    check("the canvas names the step", canvas.includes("Book an appointment") && canvas.includes("Add to the waitlist"), canvas.slice(0, 200));
    check("and its three ways out", ["Booked", "Had a visit", "Nothing free"].every((w) => canvas.includes(w)));
    await page.locator(".react-flow__node", { hasText: "Book an appointment" }).first().click();
    await page.waitForTimeout(800);
    const panel = await page.locator("body").innerText();
    check("its settings open", ["Same as the appointment", "Same doctor", "Time of day", "Not if the patient already has a visit ahead"].every((w) => panel.includes(w)));
    check("no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
  }

  /* ---------------------------------------------------------------- clean up */
  await db.query(`delete from clinics where id = $1`, [clinic.id]).catch((e) => console.log("cleanup:", e.message));
  await db.query(`delete from users where email like $1`, [`%-${slug}@test.local`]).catch(() => {});
  await db.end();
  await pool.end();

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
