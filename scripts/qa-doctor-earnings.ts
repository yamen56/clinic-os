/**
 * What the clinic owes the doctor.
 *
 * The arithmetic here is the whole feature, and the way it goes wrong is quiet:
 * allocating each payment's share independently and adding them up drifts,
 * because every instalment rounds on its own and the errors do not cancel. It
 * is invisible on a single payment and it is a payout report an accountant
 * sends back. So the first thing asserted below is that a settled invoice pays
 * a doctor *exactly* `net x rate / 100`, and the second is that the naive method
 * would have got it wrong on the same data — a test that cannot fail is not
 * evidence of anything.
 *
 * After that: the rate frozen at billing does not move when the member's rate
 * changes; the clinic's own total does not multiply by the number of lines on
 * an invoice; and a voided invoice that was paid still owes its doctor, because
 * nobody refunded the patient.
 *
 *   npx tsx scripts/qa-doctor-earnings.ts
 */
import { chromium } from "playwright";
import { Client } from "pg";
import type { PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { ROLE_DEFAULTS } from "../src/lib/permissions";
import {
  earningsForDoctor,
  earningsByDoctor,
  clinicNetRevenue,
  clinicHasCommission,
  voidedButPaid,
} from "../src/lib/earnings";
import { computeInvoice, nextInvoiceNumber, refreshInvoiceStatus, round2 } from "../src/lib/invoices";
import { sendDigest } from "../worker/notifications";
import { DateTime } from "luxon";

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

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

/** The window either side of the fixture, so every payment falls inside it. */
const FROM = new Date("2020-01-01T00:00:00Z");
const TO = new Date("2099-01-01T00:00:00Z");

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  // Every helper takes a PoolClient and uses only .query; a Client satisfies
  // that structurally, and the cast is the honest way to say so.
  const c = db as unknown as PoolClient;

  const tag = `qaearn${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, currency, default_locale, invoice_prefix, timezone)
       values ('QA Earnings', 'أرباح', $1, 'JOD', 'en', 'QAE', 'Asia/Amman') returning id`,
      [tag]
    )
  ).rows[0];

  // Every suite's fixture carries one: a clinic with no WhatsApp row is a state
  // the workspace does not otherwise occur in.
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

  const emailOf = (name: string) => `${name.replace(/\s+/g, "").toLowerCase()}-${tag}@test.local`;
  const mkDoctor = async (name: string, pct: number | null) => {
    const u = (
      await db.query(
        `insert into users (email, password_hash, full_name, locale)
         values ($1, $2, $3, 'en') returning id`,
        [emailOf(name), bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0];
    // The job's own defaults, which is how a real doctor's row is written and
    // therefore the one that proves `earnings` actually reaches them.
    const m = (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, permissions, commission_percent)
         values ($1, $2, 'doctor', $3, $4) returning id`,
        [
          clinic.id,
          u.id,
          JSON.stringify({
            level: "custom",
            caps: Object.fromEntries(ROLE_DEFAULTS.doctor.map((c) => [c, true])),
          }),
          pct,
        ]
      )
    ).rows[0];
    return m.id as string;
  };

  const drA = await mkDoctor("Dr A", 40);
  const drB = await mkDoctor("Dr B", 17.5);

  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164)
       values ($1, 'QA Patient', $2) returning id`,
      [clinic.id, `+96279${Date.now().toString().slice(-7)}`]
    )
  ).rows[0];

  /*
    Three lines so the fan-out check has something to multiply by, two rates so
    the tax is mixed, and 15.00 at 17.5% because that pair is what produced the
    worst drift when the allocation was naive.
  */
  const items = [
    { description: "Crown", qty: 1, unitPrice: 100, taxCategory: "S" as const, taxRate: 16, doctor: drA, pct: 40 },
    { description: "Consult", qty: 1, unitPrice: 15, taxCategory: "S" as const, taxRate: 16, doctor: drB, pct: 17.5 },
    { description: "Whitening", qty: 1, unitPrice: 50, taxCategory: "O" as const, taxRate: 0, doctor: drA, pct: 40 },
  ];
  const totals = computeInvoice(items);

  /*
    Through the real allocator, not a hand-written seq. Writing `seq = 1`
    directly leaves `clinics.invoice_counter` at zero, and the next invoice
    raised through the app then tries to reuse the number and trips the unique
    constraint — which looks exactly like the builder being broken.
  */
  const first = await nextInvoiceNumber(c, clinic.id);
  const inv = (
    await db.query(
      `insert into invoices (clinic_id, patient_id, seq, number, status, currency,
                             subtotal, discount_amount, tax_rate, tax_amount, total, issue_date)
       values ($1, $2, $3, $4, 'sent', 'JOD', $5, $6, $7, $8, $9, current_date) returning id`,
      [clinic.id, patient.id, first.seq, first.number, totals.subtotal, totals.discount,
       totals.taxRate, totals.taxAmount, totals.total]
    )
  ).rows[0];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const line = totals.lines[i];
    const row = (
      await db.query(
        `insert into invoice_items (clinic_id, invoice_id, description, qty, unit_price, amount,
                                    discount_amount, tax_category, tax_rate, tax_amount, sort)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [clinic.id, inv.id, it.description, it.qty, it.unitPrice, line.amount,
         line.discount, line.taxCategory, line.taxRate, line.tax, i]
      )
    ).rows[0];
    await db.query(
      `insert into invoice_line_doctors (invoice_item_id, clinic_id, doctor_member_id, commission_percent)
       values ($1, $2, $3, $4)`,
      [row.id, clinic.id, it.doctor, it.pct]
    );
  }

  console.log(`\ninvoice total ${totals.total} (subtotal ${totals.subtotal}, tax ${totals.taxAmount})`);

  /*
    Twenty-three awkward instalments, settling to the cent.

    Dated inside the current month, because the earnings screen opens on this
    month and a fixture pinned to a literal date would pass until that month
    passed. The 10th at noon with an hour between each keeps all twenty-three
    clear of either boundary in any timezone.
  */
  const instalments = [...Array(22).fill(8), round2(totals.total - 22 * 8)];
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 10, 12, 0, 0);
  for (let i = 0; i < instalments.length; i++) {
    await db.query(
      `insert into payments (clinic_id, invoice_id, patient_id, amount, method, paid_at)
       values ($1, $2, $3, $4, 'cash', $5)`,
      [clinic.id, inv.id, patient.id, instalments[i], new Date(base + i * 3600_000)]
    );
  }
  await refreshInvoiceStatus(c, inv.id);
  const status = (await db.query(`select status, amount_paid from invoices where id = $1`, [inv.id])).rows[0];
  check("the fixture settles in full", status.status === "paid", `${instalments.length} payments, status ${status.status}`);

  // ---- the exactness property -------------------------------------------
  const scope = { clinicId: clinic.id as string, from: FROM, to: TO, includeVoided: true };
  const a = await earningsForDoctor(c, scope, drA);
  const b = await earningsForDoctor(c, scope, drB);

  const trueA = round2((100 + 50) * 40 / 100);
  const trueB = round2(15 * 17.5 / 100);
  check("a settled invoice pays Dr A exactly net x rate", a.earned === trueA, `${a.earned} vs ${trueA}`);
  check("a settled invoice pays Dr B exactly net x rate", b.earned === trueB, `${b.earned} vs ${trueB}`);
  check("produced is the ex-tax net collected", a.produced === 150, `${a.produced}`);

  /*
    The test has teeth only if the method it replaced would have failed here.
    This is the arithmetic as it was first written: each payment's share rounded
    on its own, then summed.
  */
  let naiveB = 0;
  for (const p of instalments) naiveB = round2(naiveB + round2(15 * (p / totals.total) * 17.5 / 100));
  check("the naive allocation would have drifted", naiveB !== trueB, `naive ${naiveB} vs true ${trueB}`);

  // ---- the rate is frozen at billing ------------------------------------
  await db.query(`update clinic_members set commission_percent = 90 where id = $1`, [drA]);
  const afterRaise = await earningsForDoctor(c, scope, drA);
  check("raising the member's rate does not move an issued invoice",
    afterRaise.earned === trueA, `${afterRaise.earned} vs ${trueA}`);

  // ---- no fan-out over the lines ----------------------------------------
  const net = await clinicNetRevenue(c, { clinicId: clinic.id, from: FROM, to: TO });
  check("gross is the money collected, not multiplied by the line count",
    net.gross === totals.total, `${net.gross} vs ${totals.total}`);
  check("commission is the sum of both doctors' shares",
    net.commission === round2(trueA + trueB), `${net.commission} vs ${round2(trueA + trueB)}`);
  check("after commission is gross minus the doctors",
    net.afterCommission === round2(totals.total - trueA - trueB), `${net.afterCommission}`);

  // ---- the payout report -------------------------------------------------
  const by = await earningsByDoctor(c, scope);
  check("every doctor with a share appears once", by.length === 2, `${by.length} rows`);
  check("the report is ordered by what is owed", by[0].doctorMemberId === drA, "Dr A first");
  check("the clinic is flagged as sharing revenue", await clinicHasCommission(c, clinic.id));

  // ---- a voided invoice that was paid ------------------------------------
  await db.query(`update invoices set status = 'void', voided_at = now() where id = $1`, [inv.id]);
  const afterVoid = await earningsForDoctor(c, scope, drA);
  check("a voided-but-paid invoice still owes its doctor",
    afterVoid.earned === trueA, `${afterVoid.earned} vs ${trueA}`);
  const netAfterVoid = await clinicNetRevenue(c, { clinicId: clinic.id, from: FROM, to: TO });
  check("the clinic's own total drops the voided invoice from both sides",
    netAfterVoid.gross === 0 && netAfterVoid.commission === 0,
    `gross ${netAfterVoid.gross}, commission ${netAfterVoid.commission}`);
  const flagged = await voidedButPaid(c, scope);
  check("the voided-but-paid invoice is flagged for the owner",
    flagged.length === 2 && flagged.every((f) => f.number === first.number),
    `${flagged.length} rows, ${flagged.map((f) => f.number).join(",")}`);

  // ---- what each person actually sees -------------------------------------
  /*
    Un-void the invoice first. The checks above deliberately left it cancelled,
    and what this half is about is the ordinary case: a doctor opening the screen
    and reading their own number off it.
  */
  await db.query(`update invoices set status = 'paid', voided_at = null where id = $1`, [inv.id]);
  /*
    And put Dr A's rate back to 40. The freeze check above raised it to 90 to
    prove an issued invoice does not move; leaving it there would have the screen
    correctly showing a 90% rate beside earnings computed at 40, which is true,
    coherent, and a confusing thing for a test to assert about.
  */
  await db.query(`update clinic_members set commission_percent = 40 where id = $1`, [drA]);
  const token = (await db.query(`select public_token from invoices where id = $1`, [inv.id]))
    .rows[0].public_token as string;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // innerText scoped to main, never textContent: the whole dictionary ships in
  // every page's payload, so a textContent check passes anywhere at all.
  const mainText = async () =>
    (await page.locator("main").first().innerText()).replace(/\s+/g, " ");

  const signIn = async (email: string) => {
    await page.context().clearCookies();
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
  };

  await signIn(emailOf("Dr A"));
  await page.goto(`${BASE}/c/${tag}/earnings`);
  await page.waitForLoadState("networkidle");
  const aScreen = await mainText();
  check("a doctor reaches their own earnings screen", !page.url().includes("/login"));
  check("and sees what they earned", aScreen.includes("60.00"), aScreen.slice(0, 140));
  check("and the rate they are on", aScreen.includes("40%"));
  /*
    The colleague's figure, counted in the DOM rather than searched for as a
    string — 2.63 is short enough to turn up by coincidence in a date or a
    total, and a false pass on this particular check is somebody's pay leaking.
  */
  check(
    "but not a colleague's",
    (await page.getByText("2.63", { exact: false }).count()) === 0
  );
  // The clinic-wide panel belongs to `invoices.analytics`, which a doctor does
  // not have. Counted in the DOM, not searched for in the page source.
  check(
    "and not the clinic's own totals",
    (await page.getByText("After doctor commission", { exact: false }).count()) === 0 &&
      (await page.getByText("By doctor", { exact: false }).count()) === 0
  );

  /*
    Raising an invoice through the actual builder.

    Everything above ran against a fixture written straight into the database,
    which proves the arithmetic and proves nothing about whether the screen ever
    produces a row for it to work on. This is the path a clinic actually uses:
    pick a service off the grouped menu, pick the doctor, save — and the rate
    must arrive frozen from the member's record, never from the browser.
  */
  await db.query(`update clinic_members set commission_percent = 25 where id = $1`, [drB]);
  const svc = (
    await db.query(
      `insert into services (clinic_id, name, name_ar, price, duration_min)
       values ($1, 'Extraction', 'خلع', 80, 30) returning id`,
      [clinic.id]
    )
  ).rows[0];

  await signIn(emailOf("Dr A"));
  // The doctor's own caps do not include invoices, so this half runs as the
  // owner — which is who raises invoices in a real clinic anyway.
  const ownerUser = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale)
       values ($1, $2, 'QA Owner', 'en') returning id`,
      [emailOf("Owner"), bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
    [clinic.id, ownerUser.id]
  );

  await signIn(emailOf("Owner"));
  await page.goto(`${BASE}/c/${tag}/invoices/new?patient=${patient.id}`);
  await page.waitForLoadState("networkidle");

  const builder = await mainText();
  check("the builder offers the service by name", builder.includes("Extraction"), builder.slice(0, 120));

  await page.getByRole("button", { name: /Extraction/ }).click();
  /*
    `.first()` deliberately: with two doctors on the clinic the per-line override
    renders as well as the invoice-wide picker, and both are labelled "Doctor".
    The first is the one at the top, which sets every line — the ordinary case.
  */
  await page.getByLabel("Doctor", { exact: true }).first().selectOption(drB);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL((u) => /\/invoices\/[0-9a-f-]{36}$/.test(u.pathname), { timeout: 30000 });

  const written = (
    await db.query(
      `select d.doctor_member_id, d.commission_percent, ii.description
         from invoice_line_doctors d
         join invoice_items ii on ii.id = d.invoice_item_id
         join invoices i on i.id = ii.invoice_id
        where i.clinic_id = $1 and ii.description = 'Extraction'`,
      [clinic.id]
    )
  ).rows;
  check("the builder attributes the line it raised", written.length === 1, `${written.length} rows`);
  check(
    "to the doctor that was picked",
    written[0]?.doctor_member_id === drB,
    String(written[0]?.doctor_member_id)
  );
  check(
    "at the rate on their record, frozen at billing",
    Number(written[0]?.commission_percent) === 25,
    String(written[0]?.commission_percent)
  );

  /*
    Who the Earnings screen exists for.

    Holding the capability is not the test — every doctor holds it. What decides
    it is whether the clinic agreed a share with *this* person, so a doctor at a
    clinic that pays somebody else a percentage gets no nav item and no page,
    rather than an empty screen implying an arrangement nobody made.
  */
  const drNone = await mkDoctor("Dr None", null);
  await signIn(emailOf("Dr None"));
  await page.goto(`${BASE}/c/${tag}`);
  await page.waitForLoadState("networkidle");
  const noneNav = (await page.locator("aside nav a").allTextContents()).join(", ");
  check("a doctor with no share sees no Earnings item", !noneNav.includes("Earnings"), noneNav);
  check("and their dashboard still renders", noneNav.includes("Dashboard"), noneNav);

  await page.goto(`${BASE}/c/${tag}/earnings`);
  await page.waitForURL((u) => u.pathname === `/c/${tag}`, { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState("networkidle");
  check(
    "and typing the URL sends them away",
    new URL(page.url()).pathname === `/c/${tag}`,
    new URL(page.url()).pathname
  );

  // And the doctor who does have one still does.
  await signIn(emailOf("Dr A"));
  await page.goto(`${BASE}/c/${tag}`);
  await page.waitForLoadState("networkidle");
  const aNav = (await page.locator("aside nav a").allTextContents()).join(", ");
  check("a doctor with a share does see it", aNav.includes("Earnings"), aNav);

  /*
    And it survives the arrangement ending. Clearing the percentage stops new
    work accruing; it does not take away the record of what they were already
    owed, which is when somebody is most likely to go looking.
  */
  await db.query(`update clinic_members set commission_percent = null where id = $1`, [drA]);
  await page.goto(`${BASE}/c/${tag}`);
  await page.waitForLoadState("networkidle");
  const endedNav = (await page.locator("aside nav a").allTextContents()).join(", ");
  check("clearing the share keeps what they already earned reachable", endedNav.includes("Earnings"), endedNav);
  await page.goto(`${BASE}/c/${tag}/earnings`);
  await page.waitForLoadState("networkidle");
  const endedText = await mainText();
  check("and it still shows the figure", endedText.includes("60.00"), endedText.slice(0, 120));
  await db.query(`update clinic_members set commission_percent = 40 where id = $1`, [drA]);

  // Nobody on the desk sees the clinic's takings just for having Invoices.
  check(
    "a doctor never sees the clinic's revenue tile",
    (await page.getByText("Revenue this week", { exact: false }).count()) === 0
  );

  /*
    The clinic's takings must not reach a doctor's browser at all — not merely
    go undrawn. The dashboard's fourteen-day chart is hidden behind the
    capability, but the query behind it used to run for everybody, so the daily
    figures travelled in the page payload where anyone could read them.

    Asserted against the whole document rather than `innerText`, because what
    is being tested is precisely the part that is never rendered.
  */
  await signIn(emailOf("Dr A"));
  await page.goto(`${BASE}/c/${tag}`);
  await page.waitForLoadState("networkidle");
  const dashboardPayload = await page.content();
  check(
    "the clinic's takings are not in a doctor's dashboard payload",
    !dashboardPayload.includes(String(totals.total)),
    `looking for ${totals.total}`
  );

  /*
    And the same number must not arrive by notification, which is the one
    surface outside every gate the app has — it survives on a lock screen. The
    day-end digest picks its audience by job, and a job is not an access set.
  */
  const alert = {
    id: "00000000-0000-0000-0000-000000000001",
    clinic_id: clinic.id as string,
    kind: "day_end",
    roles: ["doctor", "receptionist", "owner"],
    at_hour: 20,
    threshold: 0,
    slug: tag,
    timezone: "Asia/Amman",
    currency: "JOD",
  };
  /*
    Dated to the day the instalments actually landed, not today. The digest
    reports one day and says nothing at all about an empty one — pointing it at
    a day with no money in it would prove only that it stays quiet.
  */
  const payDay = DateTime.fromJSDate(new Date(base)).setZone("Asia/Amman").startOf("day");
  /*
    One completed appointment on that day, so the doctor is in the audience at
    all. Without it they are correctly sent nothing — a recipient who may not
    see the money and has no appointments to hear about has no summary — and the
    test would be asserting about an absence for the wrong reason.
  */
  await db.query(
    `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status)
     values ($1, $2, $3, $4, $4::timestamptz + interval '30 min', 'completed')`,
    [clinic.id, patient.id, drA, payDay.plus({ hours: 10 }).toUTC().toISO()]
  );
  await sendDigest(c, alert, payDay);
  const digests = (
    await db.query(
      `select u.full_name, n.body from notifications n
         join users u on u.id = n.user_id
        where n.clinic_id = $1 and n.kind = 'day_end'`,
      [clinic.id]
    )
  ).rows;
  const drADigest = digests.find((d) => d.full_name === "Dr A");
  const ownerDigest = digests.find((d) => d.full_name === "QA Owner");
  /*
    Tested on the currency code rather than a number: the money is the only
    part of this body that carries one, and "does the string contain JOD" needs
    no escaping to be right.
  */
  check(
    "a doctor's day-end summary carries no money",
    !!drADigest && !drADigest.body.includes("JOD"),
    String(drADigest?.body)
  );
  check(
    "but still tells them about the day",
    !!drADigest && drADigest.body.includes("1"),
    String(drADigest?.body)
  );
  check(
    "the owner's does carry it",
    !!ownerDigest && ownerDigest.body.includes("JOD"),
    String(ownerDigest?.body)
  );

  // The one thing that must never be true.
  await page.goto(`${BASE}/inv/${token}`);
  await page.waitForLoadState("networkidle");
  const invoiceText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check("the percentage is nowhere on the patient's invoice", !/\b40\s*%/.test(invoiceText));
  check("nor is the doctor's share", !invoiceText.includes("60.00"));

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();

  // ---- teardown -----------------------------------------------------------
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where email like $1`, [`%-${tag}@test.local`]);
  await db.end();

  console.log(`\ndoctor earnings: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
