/**
 * Adding staff with their pay, and adding a patient with what the file needs (0086).
 *
 * Yamen, 2026-10-28: "make sure that adding the staff like the doctor and the
 * patient align well with all the needed fields like the percentage with the
 * doctor unless he have a salary or on call".
 *
 * - Add a doctor on a percentage: asked for on the form, with the costs deal
 *   and the licence and syndicate numbers; the list says "35% share".
 * - Add a receptionist on a salary: only Salary and Not set are offered; the
 *   salary is a repeating Salaries bill in their name from the next pay day,
 *   so nothing posts for a month already paid.
 * - Add a doctor on call: each appointment of theirs completed is a visit at
 *   the fee on that day; a later fee does not rewrite it; un-completing takes
 *   it back; Earnings shows it to the owner and to the doctor.
 * - Edit: percentage → salary → percentage clears the others and switches the
 *   bill off; removing a salaried member stops their bill, adding back resumes.
 * - A delegated staff manager is never shown anybody's pay.
 * - A new patient: gender, date of birth, the national number and the clinic's
 *   own required fields are asked on adding, checked, and on the file.
 *
 * Run against a warm server.
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import type { PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { earningsForDoctor } from "../src/lib/earnings";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

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

async function signIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
  const c = db as unknown as PoolClient;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const hash = bcrypt.hashSync("password123", 10);
  const slug = `qapay${tag}`;
  const [clinic] = await q(`insert into clinics (name, slug, specialty) values ('QA Pay', $1, 'general') returning id, timezone, currency`, [slug]);
  await q(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  await q(`select seed_expense_categories($1)`, [clinic.id]);
  await q(`select seed_esign_defaults($1)`, [clinic.id]);
  // The clinic's own rules for a patient file: gender is required, and so is where they heard of us.
  await q(`update patient_field_definitions set is_required = true where clinic_id = $1 and key = 'patient.gender'`, [clinic.id]);
  await q(
    `insert into patient_field_definitions (clinic_id, scope, key, label, label_ar, field_type, is_required, storage_key, display_order)
     values ($1, 'patient', 'patient.referred_by', 'Referred by', 'عن طريق', 'text', true, 'referred_by', 90)`,
    [clinic.id]
  );
  const ownerEmail = `pay-owner-${tag}@test.local`;
  const [owner] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'Dr Owner Pay', 'en') returning id`, [ownerEmail, hash]);
  await q(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, title, permissions) values ($1, $2, 'doctor', true, 'Dr.', '{"level":"full"}')`,
    [clinic.id, owner.id]
  );
  // A delegated staff manager: the staff screen, and nobody's pay.
  const mgrEmail = `pay-mgr-${tag}@test.local`;
  const [mgr] = await q(`insert into users (email, password_hash, full_name, locale) values ($1, $2, 'Manager Pay', 'en') returning id`, [mgrEmail, hash]);
  await q(
    `insert into clinic_members (clinic_id, user_id, role, permissions) values ($1, $2, 'receptionist', '{"level":"custom","caps":{"dashboard":true,"settings":true,"settings.staff":true,"patients":true}}')`,
    [clinic.id, mgr.id]
  );
  const today = (await q(`select (now() at time zone $1)::date::text as d, extract(day from (now() at time zone $1))::int as day`, [clinic.timezone]))[0];

  const memberByEmail = async (email: string) =>
    (
      await q(
        `select cm.*, s.amount as bill_amount, s.active as bill_active, s.vendor as bill_vendor, s.day_of_month as bill_day,
                s.last_posted_on::text as bill_posted, ec.key as bill_category
           from clinic_members cm join users u on u.id = cm.user_id
           left join expense_schedules s on s.id = cm.salary_schedule_id
           left join expense_categories ec on ec.id = s.category_id
          where cm.clinic_id = $1 and lower(u.email) = lower($2)`,
        [clinic.id, email]
      )
    )[0];

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    const page = await signIn(browser, ownerEmail);
    page.on("pageerror", (e) => errors.push(e.message));
    const dialog = page.locator('[role="dialog"]');
    const field = (label: string) => dialog.locator("label", { hasText: label }).locator("input, select, textarea").first();

    const openAdd = async () => {
      await page.goto(`${BASE}/c/${slug}/settings/staff`, { timeout: 180000 });
      await page.getByRole("button", { name: "Add staff member" }).click();
      await dialog.waitFor({ timeout: 30000 });
    };
    const submitAdd = async () => {
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await until(async () => (await dialog.count()) === 0, 30000);
    };

    /* ── A doctor on a percentage ─────────────────────────────────────── */
    console.log("A doctor on a percentage");
    await openAdd();
    check((await dialog.locator("[data-pay-editor]").getAttribute("data-pay-editor")) === "none", "a receptionist starts with no pay recorded");
    check((await dialog.locator('[data-pay-kind="percent"]').count()) === 0, "and is not offered a percentage");
    await field("Full name").fill("Dr Percent");
    await field("Email").fill(`pay-pct-${tag}@test.local`);
    await field("Job").selectOption("doctor");
    check((await dialog.locator("[data-pay-editor]").getAttribute("data-pay-editor")) === "percent", "a doctor starts on a percentage");
    check(
      (await dialog.locator('[data-pay-kind]').allInnerTexts()).join("|") === "Percentage|Salary|On call|Not set",
      "a doctor is offered Percentage, Salary, On call or Not set"
    );
    const addBtn = dialog.getByRole("button", { name: "Add", exact: true });
    check(await addBtn.isDisabled(), "Add waits for the percentage");
    check((await dialog.innerText()).includes("Enter the amount for how they're paid"), "and says what is missing");
    await dialog.locator("[data-pay-percent]").fill("35");
    await dialog.locator("[data-costs-rule]").selectOption("doctor");
    await dialog.locator("[data-add-license]").fill("LIC-7781");
    await dialog.locator("[data-add-syndicate]").fill("SYN-332");
    check(!(await addBtn.isDisabled()), "with it typed, Add is ready");
    await submitAdd();
    const pct = await memberByEmail(`pay-pct-${tag}@test.local`);
    check(pct && Number(pct.commission_percent) === 35 && pct.costs_rule === "doctor", "added on 35%, costs off the doctor's share", JSON.stringify(pct && { c: pct.commission_percent, r: pct.costs_rule }));
    check(pct?.license_no === "LIC-7781" && pct?.syndicate_no === "SYN-332", "with the licence and syndicate numbers");
    check(pct?.salary_amount == null && pct?.on_call_fee == null && pct?.salary_schedule_id == null, "and no salary or per-visit fee");
    await page.reload();
    const pctRow = page.locator("li", { hasText: "Dr Percent" });
    check((await pctRow.innerText()).includes("35% share"), "the staff list says 35% share");

    /* ── A receptionist on a salary ───────────────────────────────────── */
    console.log("A receptionist on a salary");
    await openAdd();
    await field("Full name").fill("Rima Salary");
    await field("Email").fill(`pay-sal-${tag}@test.local`);
    await dialog.locator('[data-pay-kind="salary"]').click();
    await dialog.locator("[data-pay-salary]").fill("600");
    await dialog.locator("[data-pay-day]").fill("1");
    check((await dialog.innerText()).includes("repeating Salaries bill"), "the form says where the salary goes");
    await submitAdd();
    const sal = await memberByEmail(`pay-sal-${tag}@test.local`);
    check(sal && Number(sal.salary_amount) === 600 && sal.salary_day === 1 && sal.commission_percent == null, "added on a 600 salary paid on the 1st");
    check(sal?.bill_category === "salaries" && Number(sal?.bill_amount) === 600 && sal?.bill_active === true, "a repeating Salaries bill of 600, active");
    check(sal?.bill_vendor === "Rima Salary" && sal?.bill_day === 1, "in her name, on the 1st");
    check(
      today.day >= 1 ? sal?.bill_posted === today.d : sal?.bill_posted == null,
      "starting from the next pay day — this month's 1st has passed, so it is marked done",
      String(sal?.bill_posted)
    );
    const posted = await q(`select count(*)::int as n from expenses where schedule_id = $1`, [sal?.salary_schedule_id]);
    check(posted[0].n === 0, "and nothing posted for a month she was not here");
    await page.reload();
    check((await page.locator("li", { hasText: "Rima Salary" }).innerText()).includes("a month"), "the staff list shows her salary");

    // A pay day still ahead this month posts this month, on the day.
    await openAdd();
    await field("Full name").fill("Dr Late Payday");
    await field("Email").fill(`pay-late-${tag}@test.local`);
    await field("Job").selectOption("doctor");
    await dialog.locator('[data-pay-kind="salary"]').click();
    await dialog.locator("[data-pay-salary]").fill("1500");
    await dialog.locator("[data-pay-day]").fill("31");
    await submitAdd();
    const late = await memberByEmail(`pay-late-${tag}@test.local`);
    /*
      A pay day still ahead this month: this month's salary counts. A repeating
      bill is written as soon as its month is current, dated on its due day
      (worker/expenses.ts), so the worker may already have claimed it.
    */
    const due = (
      await q(
        `select (date_trunc('month', (now() at time zone $1)::date)
                 + make_interval(days => least(31, extract(day from (date_trunc('month', (now() at time zone $1)::date) + interval '1 month - 1 day'))::int) - 1))::date::text as d`,
        [clinic.timezone]
      )
    )[0].d;
    check(
      late?.bill_day === 31 && (today.day < 31 ? late?.bill_posted == null || late?.bill_posted === due : late?.bill_posted === today.d),
      "a pay day still ahead this month counts this month, dated on the day",
      String(late?.bill_posted)
    );

    /* ── A doctor on call ─────────────────────────────────────────────── */
    console.log("A doctor on call");
    const callEmail = `pay-call-${tag}@test.local`;
    await openAdd();
    await field("Full name").fill("Dr On Call");
    await field("Email").fill(callEmail);
    await field("Job").selectOption("doctor");
    await dialog.locator('[data-pay-kind="on_call"]').click();
    await dialog.locator("[data-pay-fee]").fill("25");
    await submitAdd();
    const call = await memberByEmail(callEmail);
    check(call && Number(call.on_call_fee) === 25 && call.commission_percent == null && call.salary_amount == null, "added on call at 25 a visit");

    const [pt] = await q(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Visit Patient', '+962790007711', 'staff') returning id`, [clinic.id]);
    const appt = async (status: string, hoursAgo: number) =>
      (
        await q(
          `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status)
           values ($1, $2, $3, now() - make_interval(hours => $4), now() - make_interval(hours => $4) + interval '30 minutes', $5) returning id`,
          [clinic.id, pt.id, call.id, hoursAgo, status]
        )
      )[0].id as string;
    const visit = async (id: string) => (await q(`select fee from on_call_visits where appointment_id = $1`, [id]))[0];
    const a1 = await appt("confirmed", 3);
    check(!(await visit(a1)), "a booked visit is owed nothing yet");
    await q(`update appointments set status = 'completed' where id = $1`, [a1]);
    check(Number((await visit(a1))?.fee) === 25, "completed, it is a visit at 25");

    // The fee goes up: the visit already done keeps its 25.
    await page.goto(`${BASE}/c/${slug}/settings/staff`, { timeout: 180000 });
    await page.locator("li", { hasText: "Dr On Call" }).getByRole("button", { name: "Edit" }).click();
    await dialog.waitFor();
    check((await dialog.locator("[data-pay-editor]").getAttribute("data-pay-editor")) === "on_call", "the edit form opens on On call");
    await dialog.locator("[data-pay-fee]").fill("30");
    await dialog.getByRole("button", { name: "Save" }).click();
    await until(async () => (await dialog.count()) === 0, 30000);
    check(Number((await memberByEmail(callEmail))?.on_call_fee) === 30, "the fee is now 30");
    check(Number((await visit(a1))?.fee) === 25, "and the visit already done keeps its 25");
    const a2 = await appt("completed", 2);
    check(Number((await visit(a2))?.fee) === 30, "the next completed visit is 30");
    const a3 = await appt("completed", 1);
    await q(`update appointments set status = 'no_show' where id = $1`, [a3]);
    check(!(await visit(a3)), "a visit marked no-show after all is owed nothing");
    await q(`update appointments set doctor_member_id = $2 where id = $1`, [a2, pct.id]);
    check(!(await visit(a2)), "handed to a doctor who is not on call, it is no longer his");
    await q(`update appointments set doctor_member_id = $2 where id = $1`, [a2, call.id]);
    check(Number((await visit(a2))?.fee) === 30, "handed back, it is his again at today's fee");

    const { start, end } = (
      await q(
        `select date_trunc('month', now() at time zone $1) at time zone $1 as start,
                (date_trunc('month', now() at time zone $1) + interval '1 month') at time zone $1 as end`,
        [clinic.timezone]
      )
    )[0];
    const visitsInMonth = (await q(`select coalesce(sum(fee), 0)::numeric as s from on_call_visits where doctor_member_id = $1 and visit_at >= $2 and visit_at < $3`, [call.id, start, end]))[0];
    const e = await earningsForDoctor(c, { clinicId: clinic.id, from: start, to: end }, call.id);
    check(e.earned === Number(visitsInMonth.s) && e.produced === 0, "his earnings this month are his visits' fees", `${e.earned} vs ${visitsInMonth.s}`);

    await page.goto(`${BASE}/c/${slug}/earnings`, { timeout: 180000 });
    await page.waitForSelector("main", { timeout: 60000 });
    const ownerView = await page.locator("main").innerText();
    check(ownerView.includes("Dr On Call"), "the owner's payout table lists the on-call doctor");

    // The doctor's own screen.
    await q(`update users set password_hash = $2, locale = 'en' where lower(email) = lower($1)`, [callEmail, hash]);
    const dp = await signIn(browser, callEmail);
    dp.on("pageerror", (err) => errors.push(err.message));
    check(
      await until(async () => (await dp.locator('nav a[href$="/earnings"]').count()) > 0, 30000),
      "an on-call doctor's Finance entry opens his Earnings"
    );
    await dp.goto(`${BASE}/c/${slug}/earnings`, { timeout: 180000 });
    const visitsLine = dp.locator("[data-visits-line]");
    check(await until(async () => (await visitsLine.count()) > 0, 60000), "his breakdown has the month's on-call visits");
    const own = await dp.locator("main").innerText();
    check(own.includes("a visit") && own.includes("On-call visits ·"), "with his rate as a fee a visit", own.slice(0, 200));
    const card = await dp.locator("[data-on-call]").locator("xpath=..").innerText();
    check(!card.includes("Lab costs") && !card.includes("before sales tax"), "and no billed, lab-cost or tax lines about a deal he does not have", card.slice(0, 300));
    await dp.context().close();

    /* ── Changing the deal ────────────────────────────────────────────── */
    console.log("Changing the deal");
    const editPay = async (name: string, fn: () => Promise<void>) => {
      await page.goto(`${BASE}/c/${slug}/settings/staff`, { timeout: 180000 });
      await page.locator("li", { hasText: name }).getByRole("button", { name: "Edit" }).click();
      await dialog.waitFor();
      await fn();
      await dialog.getByRole("button", { name: "Save" }).click();
      await until(async () => (await dialog.count()) === 0, 30000);
    };
    await editPay("Dr Percent", async () => {
      check((await dialog.locator("[data-pay-percent]").inputValue()) === "35", "the edit form opens on his 35%");
      await dialog.locator('[data-pay-kind="salary"]').click();
      await dialog.locator("[data-pay-salary]").fill("900");
    });
    let p2 = await memberByEmail(`pay-pct-${tag}@test.local`);
    check(p2.commission_percent == null && Number(p2.salary_amount) === 900 && p2.bill_active === true, "moved to a 900 salary: the share is gone and the bill is on");
    await editPay("Dr Percent", async () => {
      await dialog.locator('[data-pay-kind="percent"]').click();
      await dialog.locator("[data-pay-percent]").fill("40");
    });
    p2 = await memberByEmail(`pay-pct-${tag}@test.local`);
    check(Number(p2.commission_percent) === 40 && p2.salary_amount == null && p2.bill_active === false, "back on 40%: the salary is gone and its bill switched off");
    await editPay("Dr Percent", async () => {
      await field("Title").fill("Prof.");
    });
    p2 = await memberByEmail(`pay-pct-${tag}@test.local`);
    check(Number(p2.commission_percent) === 40 && p2.title === "Prof.", "a save that only changed the title leaves the pay alone");

    // Removed, the salary stops; added back, it resumes.
    await page.goto(`${BASE}/c/${slug}/settings/staff`, { timeout: 180000 });
    await page.locator("li", { hasText: "Rima Salary" }).getByRole("button", { name: "Edit" }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Deactivate" }).click();
    await until(async () => (await dialog.count()) === 0, 30000);
    check((await memberByEmail(`pay-sal-${tag}@test.local`))?.bill_active === false, "deactivated, her salary bill stops");
    await page.locator("li", { hasText: "Rima Salary" }).getByRole("button", { name: "Edit" }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Reactivate" }).click();
    await until(async () => (await dialog.count()) === 0, 30000);
    check((await memberByEmail(`pay-sal-${tag}@test.local`))?.bill_active === true, "reactivated, it resumes");

    /* ── A staff manager sees nobody's pay ────────────────────────────── */
    console.log("A staff manager");
    const mp = await signIn(browser, mgrEmail);
    mp.on("pageerror", (err) => errors.push(err.message));
    await mp.goto(`${BASE}/c/${slug}/settings/staff`, { timeout: 180000 });
    await mp.getByRole("button", { name: "Add staff member" }).click();
    const mdialog = mp.locator('[role="dialog"]');
    await mdialog.waitFor();
    check((await mdialog.locator("[data-add-pay]").count()) === 0, "the add form has no pay section for a staff manager");
    await mdialog.getByRole("button", { name: "Cancel" }).click();
    const listText = await mp.locator("main").innerText();
    check(!listText.includes("% share") && !listText.includes("a month") && !listText.includes("a visit"), "and the list shows nobody's pay");
    await mp.context().close();

    /* ── A new patient ────────────────────────────────────────────────── */
    console.log("A new patient");
    await page.goto(`${BASE}/c/${slug}/patients?new=1`, { timeout: 180000 });
    const form = page.locator("[data-new-patient]");
    await form.waitFor({ timeout: 60000 });
    const formText = await form.innerText();
    check(
      ["Full name", "Phone", "Gender", "Date of birth", "National ID", "Referred by"].every((w) => formText.includes(w)),
      "the form asks name, phone, gender, date of birth, national ID and the clinic's required field",
      formText.slice(0, 200)
    );
    const create = page.locator("[data-new-create]");
    await page.locator("[data-new-name]").fill("Lina New Patient");
    await page.locator("[data-new-phone]").fill("0791234567");
    check(await create.isDisabled(), "Create waits for the required gender and Referred by");
    await page.locator("[data-new-gender]").selectOption("female");
    await page.locator('[data-new-field="patient.referred_by"]').fill("Instagram");
    await page.locator("[data-new-birth]").fill("1990-05-04");
    await page.locator("[data-new-nid]").fill("123456789");
    check(!(await create.isDisabled()), "with them, Create is ready");
    await create.click();
    check(await until(async () => (await form.innerText()).includes("A national number is 10 digits"), 20000), "a 9-digit national number is refused on the form");
    await page.locator("[data-new-nid]").fill("9901234567");
    await create.click();
    check(await until(async () => /\/patients\/[0-9a-f-]{36}/.test(page.url()), 30000), "created, the file opens");
    const [np] = await q(
      `select gender, birth_date::text as birth, national_id, custom_fields->>'referred_by' as referred, phone_e164
         from patients where clinic_id = $1 and full_name = 'Lina New Patient'`,
      [clinic.id]
    );
    check(np?.gender === "female" && np?.birth === "1990-05-04", "with her gender and date of birth", JSON.stringify(np));
    check(np?.national_id === "9901234567" && np?.referred === "Instagram", "her national number and where she heard of us");
    check(np?.phone_e164 === "+962791234567", "and her phone");

    await page.goto(`${BASE}/c/${slug}/patients?new=1`, { timeout: 180000 });
    await form.waitFor({ timeout: 60000 });
    await page.locator("[data-new-name]").fill("Second Lina");
    await page.locator("[data-new-gender]").selectOption("female");
    await page.locator('[data-new-field="patient.referred_by"]').fill("Friend");
    await page.locator("[data-new-nid]").fill("9901234567");
    await create.click();
    check(
      await until(async () => (await form.innerText()).includes("Another patient already has this national number — Lina New Patient"), 20000),
      "the same national number again names the patient who has it"
    );
    check((await q(`select 1 from patients where clinic_id = $1 and full_name = 'Second Lina'`, [clinic.id])).length === 0, "and no second file is made");

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
