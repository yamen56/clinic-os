/**
 * One money section, and who sees what inside it.
 *
 * Three things here are worth more than the rest of the suite.
 *
 * The first is that the clinic's own figures — what it kept, and what every
 * doctor is owed — are asserted against the **whole document** rather than
 * `innerText`. What is under test is precisely the part that is never drawn: a
 * gate on a prop hides a card and still ships the numbers in the page payload,
 * which is the bug the dashboard shipped twice. `innerText` would pass over it.
 *
 * The second is that a doctor's invoice filter is tested at every door, not
 * just the list. A filter that covers the screen and leaves the PDF route and
 * the server actions open is worse than none, because it reads as done.
 *
 * The third is that a clinic admin can be a doctor. The data model always
 * allowed it — `role` is the job and `is_owner` is a flag — but the one person
 * who would ever set it, the admin, was refused by the self-edit guard.
 *
 * Assertions read `innerText`, never `textContent`, except where noted: the
 * whole dictionary is serialised into every page, so a `textContent` check
 * passes on any screen in the app and proves nothing.
 *
 *   npx tsx scripts/qa-finance.ts
 */
import { chromium } from "playwright";
import { Client } from "pg";
import type { PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { ROLE_DEFAULTS } from "../src/lib/permissions";
import { computeInvoice, nextInvoiceNumber } from "../src/lib/invoices";
import { financeTabs } from "../src/lib/finance";

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

const caps = (list: string[]) => ({
  level: "custom" as const,
  caps: Object.fromEntries(list.map((x) => [x, true])),
});

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const c = db as unknown as PoolClient;

  // The prefix `qa%-test%` is what `npm run qa:clean` sweeps.
  const tag = Date.now().toString(36);
  const slug = `qafin-test${tag}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, currency, default_locale, invoice_prefix, timezone)
       values ('QA Finance', 'المالية', $1, 'JOD', 'en', 'QFN', 'Asia/Amman') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  await db.query(`select seed_expense_categories($1)`, [clinic.id]);
  // The signer roles, which is where the consent-form wording lives — it is a
  // per-clinic row, not a string in the app.
  await db.query(`select seed_esign_defaults($1)`, [clinic.id]);

  const emailOf = (n: string) => `${n}-${tag}@test.local`;
  const mkUser = async (n: string, name: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale)
         values ($1, $2, $3, 'en') returning id`,
        [emailOf(n), bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;

  const mkMember = async (
    n: string,
    name: string,
    role: string,
    permissions: unknown,
    opts: { owner?: boolean; commission?: number } = {}
  ) => {
    const uid = await mkUser(n, name);
    return (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions, commission_percent)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [clinic.id, uid, role, !!opts.owner, JSON.stringify(permissions), opts.commission ?? null]
      )
    ).rows[0].id as string;
  };

  /*
    The cast.

    `admin` owns the clinic and starts filed as "other", exactly as
    `provisionClinic` creates one — that is the state the self-edit fix exists
    to get out of.

    `drAnalytics` is the person in the screenshot that started this: a doctor
    who has been handed Invoices and the revenue totals by hand. Everything
    grantable, and still not the clinic's own figures.

    `manager` is on `{level:"full"}` without owning anything, which is the other
    half of the rule — full access means everything, deliberately, and carving
    an exception out of it would break a promise made two releases ago.
  */
  const admin = await mkMember("admin", "QA Admin", "other", { level: "full" }, { owner: true });
  const drAnalytics = await mkMember(
    "dranalytics",
    "QA Dr Analytics",
    "doctor",
    caps([...ROLE_DEFAULTS.doctor, "invoices", "invoices.analytics", "expenses"]),
    { commission: 40 }
  );
  const drOther = await mkMember("drother", "QA Dr Other", "doctor", caps(ROLE_DEFAULTS.doctor), {
    commission: 25,
  });
  const reception = await mkMember(
    "reception",
    "QA Reception",
    "receptionist",
    caps(ROLE_DEFAULTS.receptionist)
  );
  const manager = await mkMember("manager", "QA Manager", "other", { level: "full" });
  void admin;
  void manager;

  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164)
       values ($1, 'QA Finance Patient', $2) returning id`,
      [clinic.id, `+96279${Date.now().toString().slice(-7)}`]
    )
  ).rows[0];

  /** One invoice, one line, attributed to one doctor — and settled. */
  const mkInvoice = async (amount: number, doctor: string, pct: number) => {
    const items = [
      {
        description: `Work ${amount}`,
        qty: 1,
        unitPrice: amount,
        taxCategory: "O" as const,
        taxRate: 0,
      },
    ];
    const totals = computeInvoice(items);
    // Through the real allocator: writing `seq` by hand leaves
    // `clinics.invoice_counter` at zero and the next real invoice collides.
    const { seq, number } = await nextInvoiceNumber(c, clinic.id);
    const inv = (
      await db.query(
        `insert into invoices (clinic_id, patient_id, seq, number, status, currency,
                               subtotal, discount_amount, tax_rate, tax_amount, total, amount_paid, issue_date)
         values ($1, $2, $3, $4, 'paid', 'JOD', $5, 0, 0, 0, $6, $6, current_date) returning id, number`,
        [clinic.id, patient.id, seq, number, totals.subtotal, totals.total]
      )
    ).rows[0];
    const item = (
      await db.query(
        `insert into invoice_items (clinic_id, invoice_id, description, qty, unit_price, amount,
                                    discount_amount, tax_category, tax_rate, tax_amount, sort)
         values ($1, $2, $3, 1, $4, $4, 0, 'O', 0, 0, 0) returning id`,
        [clinic.id, inv.id, items[0].description, amount]
      )
    ).rows[0];
    await db.query(
      `insert into invoice_line_doctors (invoice_item_id, clinic_id, doctor_member_id, commission_percent)
       values ($1, $2, $3, $4)`,
      [item.id, clinic.id, doctor, pct]
    );
    // Dated inside this month, because every money screen opens on this month.
    const payAt = DateTime.now().setZone("Asia/Amman").startOf("month").plus({ days: 9, hours: 12 });
    await db.query(
      `insert into payments (clinic_id, invoice_id, patient_id, amount, method, paid_at)
       values ($1, $2, $3, $4, 'cash', $5)`,
      [clinic.id, inv.id, patient.id, amount, payAt.toUTC().toISO()]
    );
    return inv as { id: string; number: string };
  };

  /*
    517 rather than a round number on purpose: the clinic's take is then 817.00,
    which cannot collide with a Tailwind class (`text-ink-800`), a hex colour or
    a fragment of a uuid when the leak check greps the whole document. The first
    version of this test looked for "800" and failed against the stylesheet.
  */
  const mine = await mkInvoice(300, drAnalytics, 40);
  const theirs = await mkInvoice(517, drOther, 25);

  // ---- the tab list is one list, derived once ----------------------------
  const allCaps = Object.fromEntries(
    ["invoices", "invoices.analytics", "earnings", "expenses"].map((k) => [k, true])
  ) as never;
  check(
    "an admin gets every tab",
    financeTabs({ caps: allCaps, hasEarnings: true, fullControl: true }).join() ===
      "invoices,payments,earnings,expenses"
  );
  check(
    "a doctor with a share and nothing else gets only Earnings",
    financeTabs({
      caps: Object.fromEntries([["earnings", true]]) as never,
      hasEarnings: true,
      fullControl: false,
    }).join() === "earnings"
  );
  check(
    "and a doctor the clinic agreed no share with gets no section at all",
    financeTabs({
      caps: Object.fromEntries([["earnings", true]]) as never,
      hasEarnings: false,
      fullControl: false,
    }).length === 0
  );
  check(
    "the clinic's own figures are not a capability anybody can be granted",
    financeTabs({ caps: allCaps, hasEarnings: false, fullControl: false }).join() ===
      "invoices,payments,expenses"
  );

  // ---- the browser -------------------------------------------------------
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const signIn = async (email: string) => {
    await page.context().clearCookies();
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
  };
  const mainText = async () =>
    (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
  const navLabels = async () => (await page.locator("aside nav a").allTextContents()).join(", ");
  const go = async (p: string) => {
    await page.goto(`${BASE}${p}`);
    await page.waitForLoadState("networkidle");
  };

  // ---- one nav entry, three tabs ----------------------------------------
  await signIn(emailOf("admin"));
  await go(`/c/${slug}`);
  const adminNav = await navLabels();
  check("the sidebar carries one Finance entry", adminNav.includes("Finance"), adminNav);
  check(
    "and Invoices, Earnings and Expenses are no longer entries of their own",
    !/(^|,)\s*(Invoices|Earnings|Expenses)\s*(,|$)/.test(adminNav),
    adminNav
  );

  await go(`/c/${slug}/invoices`);
  const tabs = await page.locator('[role="tablist"] [role="tab"]').allTextContents();
  check(
    "the strip carries all four tabs for an admin",
    ["Invoices", "Payments", "Earnings", "Expenses"].every((x) => tabs.some((t) => t.includes(x))),
    tabs.join(", ")
  );

  // ---- the URLs did not move --------------------------------------------
  for (const [name, path] of [
    ["the invoice list", `/c/${slug}/invoices`],
    ["the payments tab", `/c/${slug}/invoices?tab=payments`],
    ["a status filter", `/c/${slug}/invoices?status=paid`],
    ["earnings", `/c/${slug}/earnings`],
    ["last month's earnings", `/c/${slug}/earnings?m=-1`],
    ["expenses", `/c/${slug}/expenses`],
    ["one invoice", `/c/${slug}/invoices/${mine.id}`],
  ] as [string, string][]) {
    const r = await page.goto(`${BASE}${path}`);
    check(`${name} is still at its own URL`, r?.status() === 200, `${r?.status()}`);
  }

  // ---- what the clinic kept ---------------------------------------------
  await go(`/c/${slug}/earnings`);
  const adminEarnings = await mainText();
  check(
    "an admin sees what the clinic kept",
    adminEarnings.includes("What the clinic kept"),
    adminEarnings.slice(0, 120)
  );
  check("and every doctor's payout", adminEarnings.includes("By doctor"));
  check("with the other doctor named", adminEarnings.includes("QA Dr Other"));

  await signIn(emailOf("manager"));
  await go(`/c/${slug}/earnings`);
  const managerEarnings = await mainText();
  check(
    "so does somebody on full access, which still means everything",
    managerEarnings.includes("What the clinic kept") && managerEarnings.includes("By doctor"),
    managerEarnings.slice(0, 120)
  );

  /*
    The one that matters. This doctor has been granted Invoices *and* the
    revenue totals by hand — everything an owner can hand over — and still does
    not get the clinic's own figures.

    Asserted against `page.content()`, not `innerText`. A gate on the prop that
    draws the card would pass an `innerText` check while every figure sat in the
    RSC payload underneath it.
  */
  await signIn(emailOf("dranalytics"));
  await go(`/c/${slug}/earnings`);
  const docEarningsText = await mainText();
  const docEarningsDoc = await page.content();
  check(
    // Upper-cased by CSS, and `innerText` reports what is actually rendered.
    "a doctor sees their own earnings",
    /you earned/i.test(docEarningsText),
    docEarningsText.slice(0, 120)
  );
  check(
    "but not what the clinic kept",
    !docEarningsText.includes("What the clinic kept"),
    docEarningsText.slice(0, 160)
  );
  check("nor the by-doctor payout table", !docEarningsText.includes("By doctor"));
  check(
    "and the colleague's name is nowhere in the payload, drawn or not",
    !docEarningsDoc.includes("QA Dr Other"),
    `${docEarningsDoc.length} bytes`
  );
  check(
    "nor is the clinic's take (817.00)",
    !docEarningsDoc.includes("817.00"),
    "whole document"
  );

  // ---- a doctor's invoices are their own --------------------------------
  await go(`/c/${slug}/invoices`);
  const docInvoices = await mainText();
  check("a doctor sees the invoice they worked on", docInvoices.includes(mine.number), docInvoices.slice(0, 200));
  check(
    "and not the one a colleague did",
    !docInvoices.includes(theirs.number),
    docInvoices.slice(0, 200)
  );
  check(
    "the clinic's totals are gone with it",
    !docInvoices.includes("This week") && !docInvoices.includes("Outstanding"),
    docInvoices.slice(0, 200)
  );

  await go(`/c/${slug}/invoices?tab=payments`);
  const docPayments = await mainText();
  check(
    "the payments list is filtered the same way",
    docPayments.includes(mine.number) && !docPayments.includes(theirs.number),
    docPayments.slice(0, 200)
  );

  /*
    Asserted on what renders, not on the URL. `notFound()` does not redirect —
    the address stays and the not-found page is served in its place — so a URL
    check would call a working refusal a failure.
  */
  await page.goto(`${BASE}/c/${slug}/invoices/${theirs.id}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const colleague = await page.locator("body").innerText();
  check(
    "a colleague's invoice does not open",
    !colleague.includes(theirs.number) && /could not be found/i.test(colleague),
    colleague.replace(/\s+/g, " ").slice(0, 100)
  );

  const pdf = await page.request.get(`${BASE}/api/c/${slug}/invoices/${theirs.id}/pdf`);
  check("nor does its PDF", pdf.status() !== 200, `${pdf.status()}`);
  const ownPdf = await page.request.get(`${BASE}/api/c/${slug}/invoices/${mine.id}/pdf`);
  check("while their own still does", ownPdf.status() === 200, `${ownPdf.status()}`);

  // The patient file is the second list of the same invoices.
  await go(`/c/${slug}/patients/${patient.id}`);
  const file = await page.content();
  check(
    "and the patient file is not a way round it",
    file.includes(mine.number) && !file.includes(theirs.number),
    "whole document"
  );

  // ---- reception is not filtered ----------------------------------------
  await signIn(emailOf("reception"));
  await go(`/c/${slug}/invoices`);
  const recInvoices = await mainText();
  check(
    "reception still sees every invoice — settling at the desk is the job",
    recInvoices.includes(mine.number) && recInvoices.includes(theirs.number),
    recInvoices.slice(0, 200)
  );
  const recNav = await navLabels();
  check("reception has the money section", recNav.includes("Finance"), recNav);
  await go(`/c/${slug}/invoices`);
  const recTabs = await page.locator('[role="tablist"] [role="tab"]').allTextContents();
  check(
    "but no Earnings tab — there is no earnings screen for reception",
    !recTabs.some((t) => t.includes("Earnings")),
    recTabs.join(", ")
  );

  // ---- the admin can be a doctor ----------------------------------------
  await signIn(emailOf("admin"));
  await go(`/c/${slug}/settings/staff`);
  // By name, not by position: the staff list is ordered by the clinic, and
  // clicking "the first Edit" would edit whoever happens to sort first.
  await page
    .locator("li")
    .filter({ hasText: "QA Admin" })
    .getByRole("button", { name: /edit/i })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  const roleSelect = dialog.locator("select").first();
  check("an admin may set their own job", await roleSelect.isEnabled());
  await roleSelect.selectOption("doctor");
  await dialog.getByRole("button", { name: /^save$/i }).first().click();
  await page.waitForTimeout(2500);
  const adminRow = (
    await db.query(`select role, is_owner from clinic_members where id = $1`, [admin])
  ).rows[0];
  check(
    "and the clinic admin is now also a doctor",
    adminRow.role === "doctor" && adminRow.is_owner === true,
    `${adminRow.role} owner=${adminRow.is_owner}`
  );

  // Bookable is the point of it: every scheduling query keys on role alone.
  const bookable = (
    await db.query(
      `select count(*)::int as n from clinic_members
        where clinic_id = $1 and role = 'doctor' and active`,
      [clinic.id]
    )
  ).rows[0].n;
  check("so the clinic now has three bookable doctors", bookable === 3, `${bookable}`);

  /*
    Being a doctor is not the same as being paid like one. The personal half
    still waits for the clinic to have agreed a share with them — the capability
    was never what decided it, which is why a doctor at a practice that splits
    with nobody gets no screen rather than an empty one.
  */
  await go(`/c/${slug}/earnings`);
  const beforeRate = await mainText();
  check(
    "an admin who is a doctor still sees the clinic's half",
    beforeRate.includes("What the clinic kept"),
    beforeRate.slice(0, 160)
  );
  check(
    // Figure labels are upper-cased by CSS, and innerText reports what renders.
    "but no personal half until a share is actually agreed",
    !/your rate/i.test(beforeRate),
    beforeRate.slice(0, 160)
  );

  await db.query(`update clinic_members set commission_percent = 50 where id = $1`, [admin]);
  await go(`/c/${slug}/earnings`);
  const adminDoctorEarnings = await mainText();
  check(
    "and once it is, both halves are on the one page",
    adminDoctorEarnings.includes("What the clinic kept") && /your rate/i.test(adminDoctorEarnings),
    adminDoctorEarnings.slice(0, 260)
  );

  // ---- the rename --------------------------------------------------------
  await go(`/c/${slug}/settings/staff`);
  const staff = await mainText();
  check("the badge says clinic admin", staff.includes("Clinic admin"), staff.slice(0, 200));
  check("and no longer says owner", !/\bOwner\b/.test(staff), staff.slice(0, 200));

  const signer = (
    await db.query(
      `select label, label_ar from signer_roles where clinic_id = $1 and key = 'clinic_owner'`,
      [clinic.id]
    )
  ).rows[0];
  check(
    "a new clinic's consent forms say it too",
    signer?.label === "Clinic admin" && signer?.label_ar === "مدير العيادة",
    `${signer?.label} / ${signer?.label_ar}`
  );

  check("no page threw", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  await db.end();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
