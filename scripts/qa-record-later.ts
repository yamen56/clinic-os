/**
 * Yamen's requests of 2026-11-20, checked end to end.
 *
 *  1. A patient's WhatsApp message reaches the staff who answer the inbox at
 *     once — one line per conversation, the latest on it, cleared when it is
 *     answered — and nobody else.
 *  2. The installed app asks for notifications, camera and microphone.
 *  3. A member without `invoices.history` sees only today's invoices and
 *     payments, and can still open what a patient owes.
 *  4. An invoice, a payment, a visit and chart work can be dated another day.
 *  5. (wording — scripts/qa-treatment.ts checks «المتبقي».)
 *  6. Cancelled and removed things are out of the way and can be deleted:
 *     staff added by mistake, a patient's cancelled visits, a stopped campaign.
 *  7. An expense paid only in part leaves the rest owed.
 *
 *   npx tsx scripts/qa-record-later.ts       (against a warm dev server)
 */
import "../worker/env";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { pastDayInstant } from "../src/lib/dates";
import { redateMarks } from "../src/lib/charts/redate";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const TZ = "Asia/Amman";

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
async function until(fn: () => Promise<boolean>, ms = 15000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function signIn(browser: Browser, email: string, opts: { width?: number; standalone?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: 1000 } });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  if (opts.standalone) {
    // As the installed app: display-mode standalone.
    await ctx.addInitScript(`(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => (String(q).includes("display-mode: standalone")
        ? { matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } }
        : real(q));
    })()`);
  }
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { timeout: 180000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
  return page;
}

const hydrated = (page: Page, sel: string) =>
  page.waitForFunction(
    `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && Object.keys(e).some((k) => k.startsWith("__reactProps")); })()`,
    undefined,
    { timeout: 120000 }
  );

async function main() {
  const { recordMessage } = await import("../worker/wa/inbound");
  const db = new Client({ connectionString: PG });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const slug = `qalater${tag}`;
  const today = DateTime.now().setZone(TZ).toISODate()!;
  const daysAgo = (n: number) => DateTime.now().setZone(TZ).minus({ days: n }).toISODate()!;
  const dayOf = (d: Date | string) => DateTime.fromJSDate(new Date(d)).setZone(TZ).toISODate();

  const [clinic] = await q(`insert into clinics (name, slug, currency, timezone) values ('QA Later', $1, 'JOD', $2) returning id`, [slug, TZ]);
  await q(`select seed_expense_categories($1)`, [clinic.id]);
  const user = async (who: string, name: string) =>
    (
      await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`, [
        `${who}-${tag}@test.local`,
        bcrypt.hashSync("password123", 10),
        name,
      ])
    )[0].id as string;
  const ownerId = await user("owner", "QA Owner");
  const deskId = await user("desk", "QA Desk");
  const docId = await user("doc", "QA Doctor");
  const [ownerM] = await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'doctor', true, '{"level":"full"}') returning id`,
    [clinic.id, ownerId]
  );
  // The desk: the inbox, patients and invoices — but only today's invoices.
  const deskCaps = { dashboard: true, conversations: true, calendar: true, patients: true, invoices: true, "invoices.history": false };
  await q(`insert into clinic_members (clinic_id, user_id, role, permissions) values ($1, $2, 'receptionist', $3)`, [
    clinic.id,
    deskId,
    JSON.stringify({ level: "custom", caps: deskCaps }),
  ]);
  // A doctor without the inbox.
  await q(`insert into clinic_members (clinic_id, user_id, role, permissions) values ($1, $2, 'doctor', $3)`, [
    clinic.id,
    docId,
    JSON.stringify({ level: "custom", caps: { dashboard: true, patients: true, calendar: true } }),
  ]);
  const [patient] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Rana Later', '+962790007070', 'staff') returning id`, [
    clinic.id,
  ]);

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    /* ── 1. A patient's WhatsApp message ───────────────────────────── */
    console.log("1. A patient's WhatsApp message reaches the inbox's staff");
    const alerts = (userId: string) =>
      q(`select id, title, body, url, read_at, dedupe_key from notifications where user_id = $1 and kind = 'whatsapp_message' order by created_at`, [userId]);
    const say = (body: string, extra: Partial<Parameters<typeof recordMessage>[1]> = {}) =>
      recordMessage(clinic.id, {
        phone: "+962790007070",
        jid: "962790007070@s.whatsapp.net",
        fromMe: false,
        waId: `M${Math.random().toString(36).slice(2)}`,
        msgType: "text",
        body,
        mediaPath: null,
        mediaMime: null,
        mediaName: null,
        pushName: "Rana WA",
        ...extra,
      });
    await say("Hello, can I book for tomorrow?");
    const [o1] = await alerts(ownerId);
    const [d1] = await alerts(deskId);
    check(!!o1 && !!d1, "the owner and the desk are told");
    check((await alerts(docId)).length === 0, "a doctor without the inbox is not");
    check(o1?.title === "Rana Later" && o1?.body === "Hello, can I book for tomorrow?", "titled with the patient's name, the message as its body", JSON.stringify(o1));
    check(String(o1?.url).endsWith(`/conversations?open=`) === false && String(o1?.url).includes(`/c/${slug}/conversations?open=`), "and it opens the conversation", o1?.url);
    await say("", { msgType: "image" });
    const o2 = await alerts(ownerId);
    check(o2.length === 1, "a second message replaces the line rather than adding one", String(o2.length));
    check(/2 new messages/.test(o2[0]?.body ?? "") && /Photo/.test(o2[0]?.body ?? ""), "it says two are waiting, and that the latest is a photo", o2[0]?.body);
    await say("old", { sentAt: Date.now() - 5 * 3600_000 });
    check((await alerts(ownerId))[0]?.body?.includes("Photo"), "a message replayed hours late does not ring anybody");
    await q(`update users set notification_prefs = '{"patient_messages":"off"}' where id = $1`, [deskId]);
    await say("Are you open?");
    const deskNow = await alerts(deskId);
    check(deskNow.length === 0, "somebody who switched it off is not told", String(deskNow.length));
    await q(`update users set notification_prefs = '{}' where id = $1`, [deskId]);
    await recordMessage(clinic.id, {
      phone: "+962790007070",
      jid: "962790007070@s.whatsapp.net",
      fromMe: true,
      waId: `R${tag}`,
      msgType: "text",
      body: "Yes, we are",
      mediaPath: null,
      mediaMime: null,
      mediaName: null,
      pushName: null,
    });
    check(!!(await alerts(ownerId))[0]?.read_at, "answered from the clinic's phone: the line is read for everybody");
    await recordMessage(clinic.id, {
      phone: "+962790009999",
      jid: "962790009999@s.whatsapp.net",
      fromMe: false,
      waId: `U${tag}`,
      msgType: "text",
      body: "Hi",
      mediaPath: null,
      mediaMime: null,
      mediaName: null,
      pushName: "Stranger Name",
    });
    const stranger = (await alerts(ownerId)).find((x) => x.body === "Hi");
    check(stranger?.title === "Stranger Name", "a number with no file is named by its WhatsApp name", stranger?.title);

    /* ── 1b. The patient's doctor (0111) ───────────────────────────── */
    console.log("1b. The patient's own doctor hears it too, and it can be switched off");
    const [docM] = await q(`select id from clinic_members where clinic_id = $1 and user_id = $2`, [clinic.id, docId]);
    const soon = DateTime.now().plus({ days: 2 });
    await q(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status, source)
       values ($1, $2, $3, $4, $5, 'scheduled', 'staff')`,
      [clinic.id, patient.id, docM.id, soon.toISO(), soon.plus({ minutes: 30 }).toISO()]
    );
    await say("Doctor, the pain is back");
    const [doc1] = await alerts(docId);
    check(String(doc1?.body ?? "").endsWith("Doctor, the pain is back"), "her doctor is told, though he cannot open the inbox", JSON.stringify(doc1));
    check(String(doc1?.url).endsWith(`/c/${slug}/conversations/team`), "and is taken to the team chat to tell the desk", doc1?.url);
    const [row] = await q(`select id, roles from clinic_staff_alerts where clinic_id = $1 and kind = 'patient_message'`, [clinic.id]);
    check(!!row && (row.roles as string[]).includes("doctor"), "it is a team alert of its own, with doctors on it", JSON.stringify(row));
    await q(`update clinic_staff_alerts set roles = array['owner', 'receptionist'] where id = $1`, [row.id]);
    await q(`delete from notifications where user_id = $1 and kind = 'whatsapp_message'`, [docId]);
    await say("Still hurts");
    check((await alerts(docId)).length === 0, "with Doctors unticked, the doctor is not told");
    check((await alerts(ownerId)).some((x) => x.body?.includes("Still hurts")), "while the owner still is");
    await q(`update clinic_staff_alerts set roles = array['owner', 'receptionist', 'doctor'] where id = $1`, [row.id]);

    /* ── 1c. A reply an automation dealt with ───────────────────────── */
    console.log("1c. A reply an automation already understood does not ring anybody");
    const [conv] = await q(`select id from conversations where clinic_id = $1 and phone_e164 = '+962790007070'`, [clinic.id]);
    const [auto] = await q(
      `insert into automations (clinic_id, name, trigger_type, active) values ($1, 'QA reminder', 'before_appointment', true) returning id`,
      [clinic.id]
    );
    const [step] = await q(
      `insert into automation_steps (clinic_id, automation_id, sort, step_type, config)
       values ($1, $2, 0, 'wait_for_reply', $3) returning id`,
      [clinic.id, auto.id, JSON.stringify({ amount: 12, unit: "hours", options: [{ label: "yes", keywords: ["1", "yes"] }] })]
    );
    await q(
      `insert into automation_runs (clinic_id, automation_id, patient_id, conversation_id, status, waiting_for, current_step_id, context)
       values ($1, $2, $3, $4, 'waiting', 'reply', $5, jsonb_build_object('waiting_since', now()))`,
      [clinic.id, auto.id, patient.id, conv.id, step.id]
    );
    await q(`update notifications set read_at = now() where user_id = $1 and kind = 'whatsapp_message'`, [ownerId]);
    await say("1");
    check(!(await alerts(ownerId)).some((x) => !x.read_at), "a 1 that confirms is not announced");
    await say("1 and can I bring my son too?");
    check((await alerts(ownerId)).some((x) => !x.read_at && x.body?.includes("bring my son")), "a longer reply that happens to contain it still is");
    await q(`delete from automations where id = $1`, [auto.id]);

    /* ── 4a. Dates, on their own ────────────────────────────────────── */
    console.log("4. Dates written down afterwards");
    check(pastDayInstant(null, TZ).ok && (pastDayInstant(null, TZ) as { at: string | null }).at === null, "no day chosen is now");
    check((pastDayInstant(today, TZ) as { at: string | null }).at === null, "today is now");
    const back = pastDayInstant(daysAgo(3), TZ) as { ok: true; at: string };
    check(back.ok && dayOf(back.at) === daysAgo(3), "three days ago lands on that day in the clinic", back.at);
    check(!pastDayInstant(DateTime.now().setZone(TZ).plus({ days: 1 }).toISODate(), TZ).ok, "tomorrow is refused");
    check(!pastDayInstant("2026-02-31", TZ).ok && !pastDayInstant("nope", TZ).ok, "a date that is not one is refused");

    // Chart work moved to another day: under that day's visit when there was one.
    const [visit] = await q(
      `insert into appointments (clinic_id, patient_id, starts_at, ends_at, status)
       values ($1, $2, ($3::date + time '10:00') at time zone $4, ($3::date + time '10:30') at time zone $4, 'completed') returning id, starts_at`,
      [clinic.id, patient.id, daysAgo(2), TZ]
    );
    const [mk] = await q(
      `insert into chart_marks (clinic_id, patient_id, chart, site, treatment_key, label, label_ar, look, kind, status, done_at)
       values ($1, $2, 'general', 'body', 'svc', 'Dressing', 'ضماد', 'general', 'procedure', 'done', now()) returning id`,
      [clinic.id, patient.id]
    );
    await db.query("begin");
    const r1 = await redateMarks(db as never, clinic.id, patient.id, [mk.id], daysAgo(2), TZ);
    const [m1] = await q(`select done_at, appointment_id from chart_marks where id = $1`, [mk.id]);
    check(r1.ok && m1.appointment_id === visit.id && +new Date(m1.done_at) === +new Date(visit.starts_at), "moved to a day with a visit: under that visit, at its time");
    await redateMarks(db as never, clinic.id, patient.id, [mk.id], daysAgo(5), TZ);
    const [m2] = await q(`select done_at, appointment_id from chart_marks where id = $1`, [mk.id]);
    check(m2.appointment_id === null && dayOf(m2.done_at) === daysAgo(5), "to a day with none: it stands by its date", JSON.stringify(m2));
    const r3 = await redateMarks(db as never, clinic.id, patient.id, [mk.id], DateTime.now().setZone(TZ).plus({ days: 2 }).toISODate()!, TZ);
    check(!r3.ok, "never to a day still to come");
    await db.query("commit");

    /* ── Fixtures for the screens ───────────────────────────────────── */
    const inv = async (n: number, ago: number, total: number, paid: number, status: string) =>
      (
        await q(
          `insert into invoices (clinic_id, patient_id, seq, number, currency, subtotal, total, amount_paid, status, created_at, issue_date)
           values ($1, $2, $3, $4, 'JOD', $5, $5, $6, $7, now() - ($8 || ' days')::interval, ($9)::date) returning id, number`,
          [clinic.id, patient.id, n, `QL${tag}-${n}`, total, paid, status, ago, daysAgo(ago)]
        )
      )[0] as { id: string; number: string };
    const oldPaid = await inv(1, 10, 100, 100, "paid");
    const oldOwed = await inv(2, 10, 80, 0, "sent");
    const todays = await inv(3, 0, 50, 20, "partially_paid");
    // The clinic's own counter, past the three made by hand, so the app numbers the next one 4.
    await q(`update clinics set invoice_counter = 3 where id = $1`, [clinic.id]);
    await q(
      `insert into payments (clinic_id, invoice_id, patient_id, amount, method, paid_at, created_at) values ($1, $2, $3, 100, 'cash', now() - interval '10 days', now() - interval '10 days')`,
      [clinic.id, oldPaid.id, patient.id]
    );
    await q(`insert into payments (clinic_id, invoice_id, patient_id, amount, method, reference) values ($1, $2, $3, 20, 'card', 'today-pay')`, [
      clinic.id,
      todays.id,
      patient.id,
    ]);

    /* ── 3. Today's invoices only ───────────────────────────────────── */
    console.log("3. Without “See every invoice”, today's only");
    const desk = await signIn(browser, `desk-${tag}@test.local`);
    desk.on("pageerror", (e) => errors.push(`desk: ${e.message}`));
    await desk.goto(`${BASE}/c/${slug}/invoices`, { timeout: 180000 });
    await desk.waitForSelector("[data-today-only]", { timeout: 120000 });
    let text = await desk.locator("main").innerText();
    check(text.includes(todays.number) && !text.includes(oldPaid.number) && !text.includes(oldOwed.number), "the list has today's invoice and nothing older", text.slice(0, 300));
    await desk.goto(`${BASE}/c/${slug}/invoices?tab=payments`, { timeout: 180000 });
    await desk.waitForLoadState("networkidle");
    text = await desk.locator("main").innerText();
    check(text.includes(todays.number) && !text.includes(oldPaid.number), "the payments list, today's payment only");
    // Streamed under a loading screen, so the status is already 200 when notFound() lands: read the page.
    await desk.goto(`${BASE}/c/${slug}/invoices/${oldPaid.id}`, { timeout: 180000 });
    await desk.waitForLoadState("networkidle");
    text = await desk.locator("body").innerText();
    check(!text.includes(oldPaid.number) && !text.includes("Record payment"), "an old, paid invoice does not open", text.slice(0, 160));
    const owedResp = await desk.goto(`${BASE}/c/${slug}/invoices/${oldOwed.id}`, { timeout: 180000 });
    check(owedResp?.status() === 200, "an old one still owed does — the desk collects it", String(owedResp?.status()));
    const pdf = await desk.request.get(`${BASE}/api/c/${slug}/invoices/${oldPaid.id}/pdf`);
    check(pdf.status() === 404, "nor does its PDF", String(pdf.status()));
    await desk.goto(`${BASE}/c/${slug}/patients/${patient.id}?tab=invoices`, { timeout: 180000 });
    await desk.waitForLoadState("networkidle");
    text = await desk.locator("main").innerText();
    check(text.includes(oldOwed.number) && !text.includes(oldPaid.number), "the patient's file lists what is owed, not the paid history");

    /* ── 6a. A patient's cancelled visits ────────────────────────────── */
    const cancelled = async (ago: number) =>
      (
        await q(
          `insert into appointments (clinic_id, patient_id, starts_at, ends_at, status)
           values ($1, $2, now() - ($3 || ' days')::interval, now() - ($3 || ' days')::interval + interval '30 minutes', 'cancelled') returning id`,
          [clinic.id, patient.id, ago]
        )
      )[0].id as string;
    const bare = await cancelled(20);
    const noted = await cancelled(21);
    await q(`insert into patient_notes (clinic_id, patient_id, appointment_id, body) values ($1, $2, $3, 'called to cancel')`, [clinic.id, patient.id, noted]);

    /* ── The owner's screens ────────────────────────────────────────── */
    const owner = await signIn(browser, `owner-${tag}@test.local`);
    owner.on("pageerror", (e) => errors.push(`owner: ${e.message}`));

    await owner.goto(`${BASE}/c/${slug}/invoices`, { timeout: 180000 });
    await owner.waitForSelector(`text=${todays.number}`, { timeout: 120000 });
    text = await owner.locator("main").innerText();
    check(text.includes(oldPaid.number) && text.includes(oldOwed.number) && !(await owner.locator("[data-today-only]").count()), "the owner sees every invoice");

    console.log("4. An invoice, a payment, a visit, dated another day");
    const [svc] = await q(`insert into services (clinic_id, name, price, duration_min) values ($1, 'QA Dated Service', 30, 30) returning id`, [clinic.id]);
    void svc;
    await owner.goto(`${BASE}/c/${slug}/invoices/new?patient=${patient.id}`, { timeout: 180000 });
    await owner.waitForSelector("[data-invoice-date]", { timeout: 120000 });
    await hydrated(owner, "[data-invoice-date]");
    check((await owner.locator("[data-invoice-date]").inputValue()) === today, "a new invoice is dated today");
    await owner.locator("[data-invoice-date]").fill(daysAgo(4));
    await owner.getByRole("button", { name: /QA Dated Service/ }).first().click();
    await owner.getByRole("button", { name: "Create", exact: true }).click();
    check(await until(async () => (await q(`select 1 from invoices where clinic_id = $1 and seq > 3`, [clinic.id])).length === 1, 60000), "it is created");
    const [made] = await q(`select issue_date::text as day, created_at from invoices where clinic_id = $1 and seq > 3`, [clinic.id]);
    check(made?.day === daysAgo(4) && dayOf(made?.created_at) === today, "dated four days ago, entered today", JSON.stringify(made));

    await owner.goto(`${BASE}/c/${slug}/invoices/${oldOwed.id}`, { timeout: 180000 });
    await owner.waitForSelector("text=Record payment", { timeout: 120000 });
    await hydrated(owner, "main button");
    await owner.getByRole("button", { name: /Record payment/ }).first().click();
    await owner.locator("[data-pay-date]").fill(daysAgo(3));
    await owner.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    check(
      await until(async () => (await q(`select 1 from payments where invoice_id = $1`, [oldOwed.id])).length === 1, 30000),
      "the payment is recorded"
    );
    const [pay] = await q(`select paid_at, created_at from payments where invoice_id = $1`, [oldOwed.id]);
    check(dayOf(pay?.paid_at) === daysAgo(3) && dayOf(pay?.created_at) === today, "paid three days ago, entered today", JSON.stringify(pay));

    // A visit on another day, from the treatment record.
    await owner.goto(`${BASE}/c/${slug}/patients/${patient.id}?tab=overview`, { timeout: 180000 });
    await owner.waitForSelector("[data-treatment-other-day]", { timeout: 120000 });
    await hydrated(owner, "[data-treatment-other-day]");
    await owner.locator("[data-treatment-other-day]").click();
    await owner.locator("[data-treatment-other-day-input]").fill(daysAgo(6));
    await owner.locator("[data-treatment-other-day-open]").click();
    check(
      await until(async () => (await q(`select 1 from appointments where patient_id = $1 and status = 'completed' and (starts_at at time zone $2)::date = $3::date`, [patient.id, TZ, daysAgo(6)])).length === 1, 30000),
      "a visit six days ago is made, already over"
    );
    const runs = await q(`select 1 from jobs where clinic_id = $1 and kind like 'trigger:patient_arrived%'`, [clinic.id]);
    check(runs.length === 0, "and nothing is sent or started for it");

    // A dental-style redate through the route: the treatment record's own entry.
    const [gen] = await q(
      `insert into chart_marks (clinic_id, patient_id, chart, site, treatment_key, label, label_ar, look, kind, status, done_at, recorded_by)
       values ($1, $2, 'general', 'body', 'svc2', 'Session', 'جلسة', 'general', 'procedure', 'done', now(), $3) returning id`,
      [clinic.id, patient.id, ownerId]
    );
    const res = await owner.evaluate(
      `fetch(${JSON.stringify(`/api/c/${slug}/patients/${patient.id}/treatment/marks/${gen.id}`)}, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "date", eventId: crypto.randomUUID(), day: ${JSON.stringify(daysAgo(2))} }) }).then((r) => r.status)`
    );
    const [g2] = await q(`select appointment_id from chart_marks where id = $1`, [gen.id]);
    const [ev] = await q(`select reason from chart_mark_events where mark_id = $1 and action = 'date'`, [gen.id]);
    check(res === 200 && g2.appointment_id === visit.id && ev?.reason === daysAgo(2), "a treatment moved two days back joins that day's visit, and its history says so", `${res} ${JSON.stringify(g2)}`);

    console.log("6. Cancelled and removed, out of the way");
    await owner.goto(`${BASE}/c/${slug}/patients/${patient.id}?tab=appointments`, { timeout: 180000 });
    await owner.waitForSelector("[data-cancelled-visits-toggle]", { timeout: 120000 });
    check((await owner.locator("[data-cancelled-visits]").getAttribute("data-cancelled-visits")) === "2", "two cancelled visits, folded");
    await hydrated(owner, "[data-cancelled-visits-toggle]");
    await owner.locator("[data-cancelled-visits-toggle]").click();
    await owner.locator("[data-delete-cancelled-visits]").click();
    await owner.getByRole("dialog").getByRole("button", { name: /Delete cancelled/ }).click();
    check(
      await until(async () => (await q(`select 1 from appointments where id = $1`, [bare])).length === 0, 30000),
      "the one with nothing under it is deleted"
    );
    check((await q(`select 1 from appointments where id = $1`, [noted])).length === 1, "the one with a note stays");

    // Staff: somebody added by mistake, and somebody who worked here.
    const mistakeId = await user("mistake", "Added By Mistake");
    const [mistake] = await q(`insert into clinic_members (clinic_id, user_id, role, active) values ($1, $2, 'receptionist', false) returning id`, [clinic.id, mistakeId]);
    const pastId = await user("past", "Former Doctor");
    const [past] = await q(`insert into clinic_members (clinic_id, user_id, role, active) values ($1, $2, 'doctor', false) returning id`, [clinic.id, pastId]);
    await q(`update appointments set doctor_member_id = $1 where id = $2`, [past.id, visit.id]);
    await owner.goto(`${BASE}/c/${slug}/settings/staff`, { timeout: 180000 });
    await owner.waitForSelector("[data-staff-removed-toggle]", { timeout: 120000 });
    text = await owner.locator("main").innerText();
    check(!text.includes("Added By Mistake") && !text.includes("Former Doctor"), "removed people are not in the list");
    await hydrated(owner, "[data-staff-removed-toggle]");
    await owner.locator("[data-staff-removed-toggle]").click();
    check((await owner.locator(`[data-staff-kept="${past.id}"]`).count()) === 1 && (await owner.locator(`[data-staff-delete="${past.id}"]`).count()) === 0, "somebody who saw patients can only be kept");
    await owner.locator(`[data-staff-delete="${mistake.id}"]`).click();
    await owner.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    check(
      await until(async () => (await q(`select 1 from clinic_members where id = $1`, [mistake.id])).length === 0, 30000),
      "somebody added by mistake is deleted"
    );
    check((await q(`select 1 from users where id = $1`, [mistakeId])).length === 1, "their account itself is left alone");

    // A stopped campaign, cleared from the list.
    const [camp] = await q(`insert into campaigns (clinic_id, name, body, status) values ($1, 'QA stopped', 'hi', 'cancelled') returning id`, [clinic.id]);
    await owner.goto(`${BASE}/c/${slug}/campaigns`, { timeout: 180000 });
    await owner.waitForSelector(`[data-campaign-delete="${camp.id}"]`, { timeout: 120000 });
    await hydrated(owner, `[data-campaign-delete="${camp.id}"]`);
    await owner.locator(`[data-campaign-delete="${camp.id}"]`).click();
    await owner.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    check(await until(async () => (await q(`select 1 from campaigns where id = $1`, [camp.id])).length === 0, 30000), "a stopped campaign is deleted from the list");

    console.log("7. An expense paid only in part");
    await owner.goto(`${BASE}/c/${slug}/expenses`, { timeout: 180000 });
    await owner.waitForSelector("text=Add expense", { timeout: 120000 });
    await hydrated(owner, "main button");
    await owner.getByRole("button", { name: "Add expense" }).first().click();
    await owner.locator("[data-expense-amount]").fill("500");
    await owner.locator("[data-part-paid] button").first().click();
    await owner.locator("[data-expense-paid-now]").fill("200");
    check((await owner.getByRole("dialog").innerText()).includes("Still to pay"), "it says what will still be owed");
    await owner.locator("[data-expense-vendor]").fill("QA Supplier");
    await owner.locator("[data-expense-save]").click();
    check(
      await until(async () => (await q(`select 1 from supplier_bills where clinic_id = $1 and vendor = 'QA Supplier'`, [clinic.id])).length === 1, 30000),
      "a bill for the full amount"
    );
    const [bill] = await q(`select id, amount::float as amount from supplier_bills where clinic_id = $1 and vendor = 'QA Supplier'`, [clinic.id]);
    const parts = await q(`select amount::float as amount, spent_on::text as day from expenses where bill_id = $1`, [bill.id]);
    check(bill.amount === 500 && parts.length === 1 && parts[0].amount === 200 && parts[0].day === today, "with 200 paid toward it today, so 300 is owed", JSON.stringify(parts));

    console.log("2. The installed app asks for what it needs");
    const app = await signIn(browser, `owner-${tag}@test.local`, { width: 390, standalone: true });
    app.on("pageerror", (e) => errors.push(`app: ${e.message}`));
    await app.goto(`${BASE}/c/${slug}`, { timeout: 180000 });
    check(await until(async () => (await app.locator("[data-permissions-prompt]").count()) > 0, 60000), "opened as the app, it asks");
    const rows: string[] = [];
    for (const el of await app.locator("[data-permission]").all()) rows.push((await el.getAttribute("data-permission")) ?? "");
    check(rows.includes("notifications"), "for notifications, with camera and microphone where the device has them", JSON.stringify(rows));
    await app.locator("[data-permissions-later]").click();
    await app.reload();
    await app.waitForLoadState("networkidle");
    check((await app.locator("[data-permissions-prompt]").count()) === 0, "Not now: it does not ask again at once");
    const browserTab = await signIn(browser, `owner-${tag}@test.local`, { width: 390 });
    await browserTab.goto(`${BASE}/c/${slug}`, { timeout: 180000 });
    await browserTab.waitForLoadState("networkidle");
    check((await browserTab.locator("[data-permissions-prompt]").count()) === 0, "in an ordinary browser tab it says nothing");

    // The switch for it, on the desk's notification preferences.
    await desk.goto(`${BASE}/c/${slug}/notifications?tab=settings`, { timeout: 180000 });
    await desk.waitForLoadState("networkidle");
    check((await desk.locator("main").innerText()).includes("Patients’ WhatsApp messages"), "the desk can choose how it hears about patients' messages");
  } finally {
    await browser.close();
    if (errors.length) {
      failed++;
      console.log(`  ✗ page errors:\n    ${errors.join("\n    ")}`);
    }
    await q(`delete from clinics where id = $1`, [clinic.id]).catch(() => {});
    await q(`delete from users where email like $1`, [`%-${tag}@test.local`]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
