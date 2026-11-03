/**
 * Paying the doctors (0091).
 *
 * The earnings screen said what each doctor earned in a month; this is the
 * other half — marking it paid, in one go or in parts, taking a mistake back,
 * and the doctor being told. What is still owed is never stored: it is the
 * month's earnings, read live, less what was paid. So the checks below are
 * about that subtraction holding on every screen that shows it, and about the
 * things that must not happen — a payout landing in Expenses (the share is
 * already off the clinic's profit), a colleague's pay reaching a doctor, a
 * "you were paid" notification outliving the payment it announced.
 *
 *   npx tsx scripts/qa-doctor-payouts.ts
 */
import { chromium } from "playwright";
import { Client } from "pg";
import type { PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { ROLE_DEFAULTS } from "../src/lib/permissions";
import { nextInvoiceNumber, refreshInvoiceStatus } from "../src/lib/invoices";
import { owedEarlier, payoutsForPeriod } from "../src/lib/payouts";

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const TZ = "Asia/Amman";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Polls the database until `fn` is true — a server action lands after the screen has already answered. */
async function until(fn: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const c = db as unknown as PoolClient;

  const tag = `qadpo${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, currency, default_locale, invoice_prefix, timezone)
       values ('QA Payouts', 'دفعات', $1, 'JOD', 'en', 'QAP', $2) returning id`,
      [tag, TZ]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

  const emailOf = (name: string) => `${name.replace(/\s+/g, "").toLowerCase()}-${tag}@test.local`;
  const mkUser = async (name: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`,
        [emailOf(name), bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;
  const mkDoctor = async (name: string, pct: number | null, fee: number | null) => {
    const u = await mkUser(name);
    const m = (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, permissions, commission_percent, on_call_fee)
         values ($1, $2, 'doctor', $3, $4, $5) returning id`,
        [
          clinic.id,
          u,
          JSON.stringify({ level: "custom", caps: Object.fromEntries(ROLE_DEFAULTS.doctor.map((x) => [x, true])) }),
          pct,
          fee,
        ]
      )
    ).rows[0];
    return { member: m.id as string, user: u };
  };

  const drA = await mkDoctor("Dr A", 40, null);
  const drB = await mkDoctor("Dr B", null, 10);
  const ownerUser = await mkUser("QA Owner");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
    [clinic.id, ownerUser]
  );
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164) values ($1, 'QA Patient', $2) returning id`,
      [clinic.id, `+96278${Date.now().toString().slice(-7)}`]
    )
  ).rows[0].id as string;

  /*
    The 10th at noon UTC, this month and last: clear of either edge of the month
    in Amman, so the fixture belongs to the month it says whatever day it runs.
  */
  const thisMonth = DateTime.now().setZone(TZ).startOf("month");
  const lastMonth = thisMonth.minus({ months: 1 });
  const period = thisMonth.toISODate()!;
  const lastPeriod = lastMonth.toISODate()!;
  const tenth = (m: DateTime) => new Date(Date.UTC(m.year, m.month - 1, 10, 12));

  /** One line for Dr A at 40%, paid in full on the day given. No tax, so the share is 40% of the price. */
  const billDrA = async (price: number, paidAt: Date) => {
    const n = await nextInvoiceNumber(c, clinic.id);
    const inv = (
      await db.query(
        `insert into invoices (clinic_id, patient_id, seq, number, status, currency,
                               subtotal, discount_amount, tax_rate, tax_amount, total, issue_date)
         values ($1, $2, $3, $4, 'sent', 'JOD', $5, 0, 0, 0, $5, $6::date) returning id`,
        [clinic.id, patient, n.seq, n.number, price, paidAt.toISOString().slice(0, 10)]
      )
    ).rows[0].id as string;
    const item = (
      await db.query(
        `insert into invoice_items (clinic_id, invoice_id, description, qty, unit_price, amount,
                                    discount_amount, tax_category, tax_rate, tax_amount, sort)
         values ($1, $2, 'Crown', 1, $3, $3, 0, 'O', 0, 0, 0) returning id`,
        [clinic.id, inv, price]
      )
    ).rows[0].id as string;
    await db.query(
      `insert into invoice_line_doctors (invoice_item_id, clinic_id, doctor_member_id, commission_percent)
       values ($1, $2, $3, 40)`,
      [item, clinic.id, drA.member]
    );
    await db.query(
      `insert into payments (clinic_id, invoice_id, patient_id, amount, method, paid_at)
       values ($1, $2, $3, $4, 'cash', $5)`,
      [clinic.id, inv, patient, price, paidAt]
    );
    await refreshInvoiceStatus(c, inv);
  };
  await billDrA(100, tenth(thisMonth)); // Dr A earns 40.00 this month
  await billDrA(50, tenth(lastMonth)); //  and 20.00 last month
  // Dr B is on call: one visit seen through this month is 10.00.
  await db.query(
    `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status)
     values ($1, $2, $3, $4, $4::timestamptz + interval '30 min', 'completed')`,
    [clinic.id, patient, drB.member, tenth(thisMonth)]
  );

  // ---- the library ----------------------------------------------------------
  check("nothing is paid to begin with", (await payoutsForPeriod(c, clinic.id, period)).length === 0);
  /*
    Last month earned Dr A 20.00 and nobody marked it paid — but nobody has
    marked anything paid here yet. Every clinic paid its doctors by hand before
    this existed, so those months are not debts to put in front of the owner.
  */
  check(
    "months before the clinic started paying here are not listed as owed",
    (await owedEarlier(c, clinic.id, TZ, period)).length === 0
  );

  // ---- the owner pays -------------------------------------------------------
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const mainText = async () => (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
  const signIn = async (email: string) => {
    await page.context().clearCookies();
    await page.goto(`${BASE}/login`, { timeout: 120_000 });
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 60_000 });
  };
  const row = (m: string) => page.locator(`[data-payout-row="${m}"]`);
  const stateOf = async (m: string) => row(m).locator("[data-payout-state]").getAttribute("data-payout-state");
  const payouts = async (m: string) =>
    (
      await db.query(
        `select id, amount::float8 as amount, method, to_char(period, 'YYYY-MM-DD') as period, to_char(paid_on, 'YYYY-MM-DD') as paid_on
           from doctor_payouts where clinic_id = $1 and doctor_member_id = $2 order by created_at`,
        [clinic.id, m]
      )
    ).rows as { id: string; amount: number; method: string; period: string; paid_on: string }[];
  const noticesTo = async (u: string) =>
    (
      await db.query(`select title, body, url, dedupe_key from notifications where user_id = $1 and kind = 'payout_paid'`, [u])
    ).rows as { title: string; body: string; url: string; dedupe_key: string }[];
  const hydrated = () =>
    page.waitForFunction(
      `(() => { const b = document.querySelector("[data-payout-pay]"); return !!b && Object.keys(b).some((k) => k.startsWith("__reactProps")); })()`,
      undefined,
      { timeout: 60_000 }
    );

  await signIn(emailOf("QA Owner"));
  await page.goto(`${BASE}/c/${tag}/earnings`, { timeout: 120_000 });
  await row(drA.member).waitFor({ timeout: 60_000 });
  await hydrated();

  check("the owner sees Dr A's month unpaid", (await stateOf(drA.member)) === "unpaid", String(await stateOf(drA.member)));
  check("and Dr B's on-call visits too", (await stateOf(drB.member)) === "unpaid", String(await stateOf(drB.member)));
  check("with no list of earlier months owed yet", (await page.locator("[data-payout-earlier]").count()) === 0);

  await row(drA.member).locator("[data-payout-pay]").click();
  const amount = page.locator("[data-payout-amount]");
  await amount.waitFor();
  check("Mark paid offers what the month earned", (await amount.inputValue()) === "40.00", await amount.inputValue());
  check(
    "and says whom and for which month",
    (await page.getByRole("dialog").innerText()).includes(`Pay Dr A for ${thisMonth.setLocale("en-GB").toFormat("LLLL yyyy")}`)
  );
  await page.locator("[data-payout-save]").click();
  /*
    The row answers the tap, not the server: paid within a second, while the
    action is still on its way.
  */
  const quick = await row(drA.member)
    .locator('[data-payout-state="paid"]')
    .waitFor({ timeout: 1500 })
    .then(() => true, () => false);
  check("the row turns paid at once", quick);
  check("and the server records it", await until(async () => (await payouts(drA.member)).length === 1));
  const first = (await payouts(drA.member))[0];
  check("for the month on screen, the amount, today, in cash",
    first?.period === period && first?.amount === 40 && first?.method === "cash" &&
      first?.paid_on === DateTime.now().setZone(TZ).toISODate(),
    JSON.stringify(first));
  const audited = (
    await db.query(`select 1 from audit_log where clinic_id = $1 and action = 'payout.create' and entity_id = $2`, [clinic.id, first?.id])
  ).rowCount;
  check("and audits it", audited === 1);
  check("Dr A is told", await until(async () => (await noticesTo(drA.user)).length === 1));
  const told = (await noticesTo(drA.user))[0];
  check("in words that say how much and for when",
    !!told && told.title.includes("40.00 JOD") && told.title.includes(thisMonth.setLocale("en-GB").toFormat("LLLL yyyy")) && told.body.includes("Cash"),
    `${told?.title} / ${told?.body}`);
  check("and the notification opens that month, not 'this month'",
    told?.url === `/c/${tag}/earnings?month=${period.slice(0, 7)}`, told?.url);

  // Undo on the toast takes it all back, the doctor's notification included.
  await page.locator("[data-toast-action]").click();
  check("Undo puts the row back to unpaid", await row(drA.member).locator('[data-payout-state="unpaid"]').waitFor({ timeout: 1500 }).then(() => true, () => false));
  check("and removes the payout", await until(async () => (await payouts(drA.member)).length === 0));
  check("and takes back the notification", await until(async () => (await noticesTo(drA.user)).length === 0));
  check(
    "and audits that too",
    (await db.query(`select 1 from audit_log where clinic_id = $1 and action = 'payout.delete'`, [clinic.id])).rowCount === 1
  );

  // Paid in two goes.
  await row(drA.member).locator("[data-payout-pay]").click();
  await amount.fill("25");
  await page.locator("[data-payout-save]").click();
  await row(drA.member).locator('[data-payout-state="part"]').waitFor({ timeout: 5000 }).catch(() => {});
  check("part of it paid says what is left", (await row(drA.member).innerText()).includes("15.00 JOD left"), await row(drA.member).innerText());
  await until(async () => (await payouts(drA.member)).length === 1);
  await row(drA.member).locator("[data-payout-pay]").click();
  check("Pay the rest offers the rest", (await amount.inputValue()) === "15.00", await amount.inputValue());
  await page.locator("[data-payout-save]").click();
  await row(drA.member).locator('[data-payout-state="paid"]').waitFor({ timeout: 5000 }).catch(() => {});
  check("and then the month is paid", (await stateOf(drA.member)) === "paid", String(await stateOf(drA.member)));
  check("as two payments", await until(async () => (await payouts(drA.member)).length === 2));

  // A payment recorded by mistake is taken out from the list behind the badge.
  await row(drA.member).locator("[data-payout-history]").click();
  const list = page.locator("[data-payout-list] li");
  await list.first().waitFor();
  check("the list shows both payments", (await list.count()) === 2);
  await list.first().locator("[data-payout-remove]").click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Remove", exact: true }).click();
  await row(drA.member).locator('[data-payout-state="part"]').waitFor({ timeout: 5000 }).catch(() => {});
  check("removing the 25 leaves 25 owed", (await row(drA.member).innerText()).includes("25.00 JOD left"), await row(drA.member).innerText());
  check("and leaves the 15 on record", await until(async () => {
    const p = await payouts(drA.member);
    return p.length === 1 && p[0].amount === 15;
  }));
  check("and only the 15's notification stands", await until(async () => {
    const n = await noticesTo(drA.user);
    return n.length === 1 && n[0].title.includes("15.00 JOD");
  }));
  await page.keyboard.press("Escape");

  // Dr B, by CliQ.
  await row(drB.member).locator("[data-payout-pay]").click();
  check("an on-call doctor is offered their visit fees", (await amount.inputValue()) === "10.00", await amount.inputValue());
  await page.locator("[data-payout-method]").selectOption("cliq");
  await page.locator("[data-payout-save]").click();
  check("and paid by CliQ", await until(async () => (await payouts(drB.member))[0]?.method === "cliq"));
  check("the total still owed is Dr A's 25",
    (await page.locator("[data-payout-total-left]").getAttribute("data-payout-total-left")) === "25",
    String(await page.locator("[data-payout-total-left]").getAttribute("data-payout-total-left")));

  /*
    The doctors' share already comes off what the clinic kept; a payout written
    to Expenses as well would take it off twice.
  */
  check(
    "paying a doctor writes nothing to Expenses",
    (await db.query(`select 1 from expenses where clinic_id = $1`, [clinic.id])).rowCount === 0
  );

  // ---- earlier months -------------------------------------------------------
  /*
    Once Dr A has been paid through here, a finished month left part-paid is
    something forgotten. Last month earned 20.00; 5.00 of it handed over.
  */
  await db.query(
    `insert into doctor_payouts (clinic_id, doctor_member_id, period, amount, paid_on, method)
     values ($1, $2, $3::date, 5, $3::date + 27, 'cash')`,
    [clinic.id, drA.member, lastPeriod]
  );
  await page.goto(`${BASE}/c/${tag}/earnings`, { timeout: 120_000 });
  const earlier = page.locator(`[data-payout-earlier-row="${lastPeriod}"]`);
  await earlier.waitFor({ timeout: 30_000 }).catch(() => {});
  check("last month shows as still owed", (await earlier.count()) === 1);
  check("with what is left of it", (await earlier.innerText().catch(() => "")).includes("15.00 JOD"), await earlier.innerText().catch(() => ""));
  check("and only last month — this one is on screen already", (await page.locator("[data-payout-earlier-row]").count()) === 1);
  await earlier.getByRole("link").click();
  await page.waitForURL((u) => u.searchParams.get("month") === lastPeriod.slice(0, 7), { timeout: 30_000 });
  await row(drA.member).waitFor({ timeout: 60_000 });
  await hydrated();
  check("Open goes to that month", (await mainText()).includes(lastMonth.setLocale("en-GB").toFormat("LLLL yyyy")));
  check("where Dr A has 15.00 left", (await row(drA.member).innerText()).includes("15.00 JOD left"), await row(drA.member).innerText());
  await row(drA.member).locator("[data-payout-pay]").click();
  await page.locator("[data-payout-save]").click();
  check("paying the rest settles it", await until(async () =>
    (await payouts(drA.member)).filter((p) => p.period === lastPeriod).reduce((s, p) => s + p.amount, 0) === 20));
  await page.goto(`${BASE}/c/${tag}/earnings`, { timeout: 120_000 });
  await row(drA.member).waitFor({ timeout: 60_000 });
  check("and the list of earlier months is gone", (await page.locator("[data-payout-earlier]").count()) === 0);

  // ---- on a phone -------------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await row(drA.member).waitFor({ timeout: 60_000 });
  const btn = await row(drA.member).locator("[data-payout-pay]").boundingBox();
  check("on a phone the Pay button is on the screen", !!btn && btn.x >= 0 && btn.x + btn.width <= 390, JSON.stringify(btn));
  const wide = await page.evaluate(`document.documentElement.scrollWidth`);
  check("and the page does not scroll sideways", Number(wide) <= 390, String(wide));
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---- the doctor's side ----------------------------------------------------
  // Through the notification still standing, the way the doctor arrives.
  await signIn(emailOf("Dr A"));
  const standing = (await noticesTo(drA.user)).find((n) => n.url.endsWith(`month=${period.slice(0, 7)}`));
  await page.goto(`${BASE}${standing?.url ?? `/c/${tag}/earnings`}`, { timeout: 120_000 });
  const mine = page.locator("[data-my-payout]");
  await mine.waitFor({ timeout: 60_000 });
  check("Dr A sees this month part-paid", (await mine.getAttribute("data-my-payout")) === "part", String(await mine.getAttribute("data-my-payout")));
  const mineText = await mine.innerText();
  check("with what was paid and when", mineText.includes("Paid 15.00 JOD on"), mineText);
  check("and what is still to come", mineText.includes("25.00 JOD still to be paid"), mineText);
  check("but cannot mark anything paid", (await page.locator("[data-payout-pay]").count()) === 0);
  check("nor see what Dr B was paid", (await page.locator(`[data-payout-row="${drB.member}"]`).count()) === 0 && !(await mainText()).includes("10.00"));
  await page.goto(`${BASE}/c/${tag}/earnings?month=${lastPeriod.slice(0, 7)}`, { timeout: 120_000 });
  await mine.waitFor({ timeout: 60_000 });
  check("and last month paid in full", (await mine.getAttribute("data-my-payout")) === "paid", String(await mine.getAttribute("data-my-payout")));

  await signIn(emailOf("Dr B"));
  await page.goto(`${BASE}/c/${tag}/earnings`, { timeout: 120_000 });
  await mine.waitFor({ timeout: 60_000 });
  check("Dr B, on call, sees their visits paid", (await mine.getAttribute("data-my-payout")) === "paid", String(await mine.getAttribute("data-my-payout")));

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();

  // ---- teardown -------------------------------------------------------------
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where email like $1`, [`%-${tag}@test.local`]);
  await db.end();

  console.log(`\ndoctor payouts: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
