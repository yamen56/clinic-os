/**
 * What the clinic spends.
 *
 * Two things here are worth more than the rest of the suite put together.
 *
 * The first is that a repeating bill posts **once**. It is driven by a
 * compare-and-swap on `last_posted_on` rather than by the clock, because the
 * scheduler's tick drifts all day and an exact-hour gate would turn a skipped
 * minute into a skipped month. So the test runs the poster twice in a row and
 * insists there is still one row — which is also what two workers look like
 * during a deploy.
 *
 * The second is that a losing month renders. Month one of any clinic is a loss,
 * and so is any month somebody buys a chair; a profit figure that only works
 * when it is positive is a profit figure nobody can trust.
 *
 * Assertions read `innerText`, never `textContent`: the whole dictionary is
 * serialised into every page's payload, so a `textContent` check passes on any
 * screen in the app and proves nothing.
 *
 *   npx tsx scripts/qa-expenses.ts
 */
import { chromium } from "playwright";
import { Client } from "pg";
import type { PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { ROLE_DEFAULTS } from "../src/lib/permissions";
import { clinicExpenses, clinicProfit, expensesByCategory } from "../src/lib/expenses";
import { postRecurringExpenses } from "../worker/expenses";

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

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const c = db as unknown as PoolClient;

  // The prefix `qa%-test%` is what `npm run qa:clean` sweeps.
  const tag = Date.now().toString(36);
  const slug = `qaexp-test${tag}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, currency, default_locale, invoice_prefix, timezone)
       values ('QA Expenses', 'مصاريف', $1, 'JOD', 'en', 'QEX', 'Asia/Amman') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  /*
    The fixture inserts the clinic directly rather than through
    `provisionClinic`, so the seeding a real clinic gets on creation has to be
    asked for here. It is the same function that path calls.
  */
  await db.query(`select seed_expense_categories($1)`, [clinic.id]);

  const emailOf = (n: string) => `${n}-${tag}@test.local`;
  const mkUser = async (n: string, name: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale)
         values ($1, $2, $3, 'en') returning id`,
        [emailOf(n), bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;

  const ownerId = await mkUser("owner", "QA Expense Owner");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
    [clinic.id, ownerId]
  );
  // A doctor on the job's own defaults, which do not include expenses.
  const docId = await mkUser("doctor", "QA Expense Doctor");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, permissions)
     values ($1, $2, 'doctor', $3)`,
    [
      clinic.id,
      docId,
      JSON.stringify({
        level: "custom",
        caps: Object.fromEntries(ROLE_DEFAULTS.doctor.map((x) => [x, true])),
      }),
    ]
  );

  const local = DateTime.now().setZone("Asia/Amman");
  const monthFrom = local.startOf("month").toISODate()!;
  const monthTo = local.startOf("month").plus({ months: 1 }).toISODate()!;
  const midMonth = local.startOf("month").plus({ days: 9 }).toISODate()!;

  // ---- categories are seeded, not empty --------------------------------
  const cats = (
    await db.query(
      `select id, key, name, is_system from expense_categories where clinic_id = $1 order by sort`,
      [clinic.id]
    )
  ).rows;
  check("a new clinic starts with categories", cats.length === 7, `${cats.length}`);
  check("and they are marked as the seeded ones", cats.every((x) => x.is_system));
  const rentCat = cats.find((x) => x.key === "rent");
  const suppliesCat = cats.find((x) => x.key === "supplies");

  // ---- an expense, and the month's total --------------------------------
  const mkExpense = async (amount: number, categoryId: string | null, vendor = "") =>
    (
      await db.query(
        `insert into expenses (clinic_id, category_id, amount, vendor, spent_on, method)
         values ($1, $2, $3, $4, $5::date, 'cash') returning id`,
        [clinic.id, categoryId, amount, vendor, midMonth]
      )
    ).rows[0].id as string;

  await mkExpense(400, rentCat.id, "Landlord");
  await mkExpense(150.5, suppliesCat.id, "Amman Dental Lab");
  await mkExpense(49.5, null, "Unfiled thing");

  const scope = { clinicId: clinic.id as string, from: monthFrom, to: monthTo };
  const total = await clinicExpenses(c, scope);
  check("the month's spend adds up", total === 600, `${total}`);

  const byCat = await expensesByCategory(c, scope);
  check("it breaks down by category", byCat.length === 3, `${byCat.length} groups`);
  check(
    "with the largest first",
    byCat[0].total === 400 && byCat[0].name === "Rent",
    `${byCat[0].name} ${byCat[0].total}`
  );
  check(
    "and an uncategorised group that keeps its money",
    byCat.some((b) => b.categoryId === null && b.total === 49.5)
  );

  /*
    A calendar-date boundary, which is the whole reason expenses are queried
    with `yyyy-MM-dd` rather than the UTC instants the payments side uses. For
    Asia/Amman a month "starts" at 21:00 the previous day, so an instant bound
    would pull this row into the previous month.
  */
  const firstOfMonth = local.startOf("month").toISODate()!;
  await db.query(
    `insert into expenses (clinic_id, amount, vendor, spent_on, method)
     values ($1, 10, 'First of the month', $2::date, 'cash')`,
    [clinic.id, firstOfMonth]
  );
  const withBoundary = await clinicExpenses(c, scope);
  check(
    "the first day of the month counts in that month",
    withBoundary === 610,
    `${withBoundary}`
  );

  // ---- deleting a category keeps the money ------------------------------
  await db.query(`delete from expense_categories where id = $1`, [suppliesCat.id]);
  const afterCatDelete = await clinicExpenses(c, scope);
  check("deleting a category does not delete its spend", afterCatDelete === 610, `${afterCatDelete}`);
  const orphaned = await db.query(
    `select count(*)::int n from expenses where clinic_id = $1 and category_id is null`,
    [clinic.id]
  );
  // Three: the one entered unfiled, the month-boundary one, and the one whose
  // category was just deleted out from under it.
  check("its expenses fall back to uncategorised", orphaned.rows[0].n === 3, `${orphaned.rows[0].n}`);

  // ---- a repeating bill posts once, and only once -----------------------
  /*
    Due today, and `last_posted_on` left null so it is owed. Running the poster
    twice is what a deploy looks like — two workers, overlapping.
  */
  const sched = (
    await db.query(
      `insert into expense_schedules
         (clinic_id, category_id, amount, vendor, method, day_of_month, active, last_posted_on)
       values ($1, $2, 1200, 'Monthly rent', 'transfer', $3, true, null) returning id`,
      [clinic.id, rentCat.id, local.day]
    )
  ).rows[0];

  await postRecurringExpenses();
  const afterOne = await db.query(
    `select count(*)::int n, coalesce(sum(amount),0) as total from expenses where schedule_id = $1`,
    [sched.id]
  );
  check("a repeating bill posts", afterOne.rows[0].n === 1, `${afterOne.rows[0].n} rows`);
  check("for the amount on the rule", Number(afterOne.rows[0].total) === 1200);

  await postRecurringExpenses();
  const afterTwo = await db.query(`select count(*)::int n from expenses where schedule_id = $1`, [
    sched.id,
  ]);
  check("and a second worker does not post it again", afterTwo.rows[0].n === 1, `${afterTwo.rows[0].n} rows`);

  /*
    Read back as text, deliberately. node-pg turns a `date` into a JS Date at
    the server's midnight, so `String(row.spent_on)` is "Mon Sep 14 ..." and any
    comparison against an ISO day is really a comparison against a locale.
  */
  const posted = (
    await db.query(
      `select spent_on::text as spent_on, method from expenses where schedule_id = $1`,
      [sched.id]
    )
  ).rows[0];
  check(
    "dated the day it was due, not the day it ran",
    posted.spent_on === local.toISODate(),
    posted.spent_on
  );
  check("carrying the rule's own method", posted.method === "transfer", posted.method);

  // A paused rule is not owed anything.
  await db.query(`update expense_schedules set active = false, last_posted_on = null where id = $1`, [
    sched.id,
  ]);
  await postRecurringExpenses();
  const afterPause = await db.query(`select count(*)::int n from expenses where schedule_id = $1`, [
    sched.id,
  ]);
  check("a paused rule posts nothing", afterPause.rows[0].n === 1, `${afterPause.rows[0].n} rows`);

  /* ---- the month is what decides, not the day -------------------------- */
  /*
    A repeating bill belongs to the month it falls in. Rent due on the 25th is
    this month's rent from the 1st, and rent due on the 3rd is still this
    month's rent when the rule is written on the 20th. Both used to record
    nothing: the poster waited for the due day, and a new rule was created with
    the current month already marked as handled.

    Everything here is torn down at the end of the block, so the month's total
    is back to 600 + 1200 for the profit assertions that follow.
  */
  const dim = local.daysInMonth!;
  const mkSched = async (day: number, amount: number, vendor: string) =>
    (
      await db.query(
        `insert into expense_schedules
           (clinic_id, category_id, amount, vendor, method, day_of_month, active, last_posted_on)
         values ($1, $2, $3, $4, 'transfer', $5, true, null) returning id`,
        [clinic.id, rentCat.id, amount, vendor, day]
      )
    ).rows[0].id as string;

  // Measured as a delta, not against a literal: this block sits after the
  // manual expenses, the boundary-date row and the rent rule, and a hardcoded
  // figure here would have to be re-derived every time one of those changes.
  const beforeSchedules = await clinicExpenses(c, scope);
  const passedDay = Math.max(1, local.day - 1);
  const behind = await mkSched(passedDay, 310, "Bill whose day has passed");
  const futureDay = Math.min(dim, local.day + 1);
  const ahead = futureDay > local.day ? await mkSched(futureDay, 320, "Bill due later this month") : null;

  await postRecurringExpenses();

  const behindRow = (
    await db.query(
      `select spent_on::text as spent_on, amount from expenses where schedule_id = $1`,
      [behind]
    )
  ).rows[0];
  check(
    "a bill whose day has already passed still counts this month",
    !!behindRow && behindRow.spent_on === local.set({ day: passedDay }).toISODate(),
    behindRow?.spent_on ?? "no row"
  );

  if (ahead) {
    const aheadRow = (
      await db.query(
        `select spent_on::text as spent_on from expenses where schedule_id = $1`,
        [ahead]
      )
    ).rows[0];
    check(
      "and one due later this month is recorded before its day arrives",
      !!aheadRow && aheadRow.spent_on === local.set({ day: futureDay }).toISODate(),
      aheadRow?.spent_on ?? "no row"
    );
  } else {
    // Only on the last day of a month is there no later day to test with.
    console.log("  --   (no later day in this month to test with)");
  }

  /*
    Moving the day after it has posted must not bill the month twice. The claim
    compares months rather than dates for exactly this: as dates, a new due day
    later in the same month is greater than `last_posted_on`, and the old
    comparison let it through.
  */
  await db.query(`update expense_schedules set day_of_month = $2 where id = $1`, [
    behind,
    Math.min(dim, passedDay + 1),
  ]);
  await postRecurringExpenses();
  const twice = await db.query(`select count(*)::int n from expenses where schedule_id = $1`, [
    behind,
  ]);
  check(
    "moving the day within the month does not bill it twice",
    twice.rows[0].n === 1,
    `${twice.rows[0].n} rows`
  );

  const withSchedules = await clinicExpenses(c, scope);
  check(
    "and the month's total carries them",
    withSchedules === beforeSchedules + 310 + (ahead ? 320 : 0),
    `${withSchedules} from ${beforeSchedules}`
  );

  // Back to where the profit assertions below expect to find it.
  for (const id of [behind, ahead].filter(Boolean) as string[]) {
    await db.query(`delete from expenses where schedule_id = $1`, [id]);
    await db.query(`delete from expense_schedules where id = $1`, [id]);
  }

  // ---- the profit chain --------------------------------------------------
  /*
    No invoices in this fixture, so nothing was collected: the month is a pure
    loss. That is the case worth testing — a clinic's first month, and any month
    somebody buys a chair.
  */
  const profit = await clinicProfit(c, {
    clinicId: clinic.id,
    from: new Date(local.startOf("month").toUTC().toISO()!),
    to: new Date(local.startOf("month").plus({ months: 1 }).toUTC().toISO()!),
    fromDate: monthFrom,
    toDate: monthTo,
  });
  check("nothing was collected", profit.collected === 0, `${profit.collected}`);
  check("expenses are the month's spend plus the posted rent", profit.expenses === 1810, `${profit.expenses}`);
  check("so the clinic kept a negative number", profit.kept === -1810, `${profit.kept}`);

  // ---- who may see it ----------------------------------------------------
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

  await signIn(emailOf("owner"));
  await page.goto(`${BASE}/c/${slug}/expenses`);
  await page.waitForLoadState("networkidle");
  const ownerSees = await mainText();
  check("an owner reaches the expenses screen", !page.url().includes("/login"));
  check("and sees the month's total", ownerSees.includes("1,810.00"), ownerSees.slice(0, 120));
  check("and the repeating bill is marked as one", ownerSees.includes("Repeating"));

  // The profit chain, on the earnings screen, for a clinic that splits with
  // nobody — the case that used to render an empty state.
  await page.goto(`${BASE}/c/${slug}/earnings`);
  await page.waitForLoadState("networkidle");
  const earnings = await mainText();
  check(
    "a clinic that splits with nobody still sees what it kept",
    earnings.includes("What the clinic kept"),
    earnings.slice(0, 120)
  );
  check("with the expenses subtracted", earnings.includes("1,810.00"));
  check("and a loss shown as negative", /-1,810\.00|−\s?1,810\.00/.test(earnings), earnings.slice(0, 200));

  // A doctor has none of it.
  await signIn(emailOf("doctor"));
  await page.goto(`${BASE}/c/${slug}`);
  await page.waitForLoadState("networkidle");
  const docNav = (await page.locator("aside nav a").allTextContents()).join(", ");
  // The nav says Finance now, and this doctor has no share and no expenses —
  // so there is no money section for them at all, which is the stronger claim.
  check("a doctor sees no money section", !docNav.includes("Finance"), docNav);

  const landed = await page.goto(`${BASE}/c/${slug}/expenses`).then(async () => {
    await page.waitForURL((u) => u.pathname === `/c/${slug}`, { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle");
    return new URL(page.url()).pathname;
  });
  check("and typing the URL sends them away", landed === `/c/${slug}`, landed);

  // The other half of every access assertion: the endpoint refuses it too.
  const apiStatus = await page.evaluate(
    async (s) => (await fetch(`/api/c/${s}/expenses/export`)).status,
    slug
  );
  check("the export API refuses them", apiStatus === 403, String(apiStatus));

  /*
    And the payments export, which was guarded one rung lower than the tiles it
    sits above — a receptionist stopped from seeing the takings could still
    download every one of them.
  */
  const paymentsStatus = await page.evaluate(
    async (s) => (await fetch(`/api/c/${s}/payments/export`)).status,
    slug
  );
  check("the payments export refuses them too", paymentsStatus === 403, String(paymentsStatus));

  /*
    Adding an expense and its bill in one pass. The upload is addressed by id
    so it cannot happen until the row exists, but that is the app's problem
    rather than the clinic's: the file is held and sent when Save returns one.
  */
  await signIn(emailOf("owner"));
  await page.goto(`${BASE}/c/${slug}/expenses`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add expense", exact: true }).first().click();
  // Not `exact`: Field appends a required marker and a hint to the label, so
  // the accessible name is never just the word.
  await page.getByLabel(/Amount/).first().fill("77.25");
  await page.getByLabel(/Paid to/).first().fill("New supplier");
  // A one-pixel PNG is a real image with a real mime, which is what the
  // download path branches on.
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "bill.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    ),
  });
  /*
    Read from body, not main: a Modal is portaled outside the main landmark, so
    the main-scoped reader every other assertion here uses cannot see it.
  */
  const modalText = (await page.locator("body").innerText()).replace(/s+/g, " ");
  check("the file is held before there is a row", modalText.includes("bill.png"), modalText.slice(0, 100));
  await page.getByRole("button", { name: "Save", exact: true }).click();

  /*
    Polled rather than slept against. The row is written by the action and the
    file is sent afterwards, in a second request — and on a cold dev server that
    route can take five seconds to compile, which a fixed wait reads as a
    missing receipt. That false failure has cost two sessions now.
  */
  let attached: { receipt_path?: string; receipt_name?: string; receipt_mime?: string } | undefined;
  for (let i = 0; i < 30; i++) {
    attached = (
      await db.query(
        `select receipt_path, receipt_name, receipt_mime from expenses
          where clinic_id = $1 and vendor = 'New supplier'`,
        [clinic.id]
      )
    ).rows[0];
    if (attached?.receipt_path) break;
    await page.waitForTimeout(500);
  }
  check("a new expense can carry its bill", !!attached?.receipt_path, String(attached?.receipt_path));
  check("keeping the file's own name", attached?.receipt_name === "bill.png", String(attached?.receipt_name));
  check("and its declared type", attached?.receipt_mime === "image/png", String(attached?.receipt_mime));
  check(
    "stored under the clinic, so deleting the clinic sweeps it",
    String(attached?.receipt_path).startsWith(`${clinic.id}/expenses/`),
    String(attached?.receipt_path)
  );

  /*
    The reported case, end to end: a repeating bill described *after* its day
    has gone by. It used to record nothing for six weeks — the rule was created
    with the current month already marked as handled — so an owner entered a 200
    rent and the month's expenses went on saying they had spent nothing.

    Driven through the form rather than the table, because the suppression lived
    in the server action rather than in the poster.
  */
  await page.goto(`${BASE}/c/${slug}/expenses`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add a repeating bill", exact: true }).first().click();
  const schedModal = page.getByRole("dialog");
  await schedModal.waitFor({ state: "visible", timeout: 10000 });
  await schedModal.getByLabel(/Amount/).first().fill("200");
  await schedModal.getByLabel(/Day of the month/).first().fill(String(Math.max(1, local.day - 1)));
  await schedModal.getByLabel(/Paid to/).first().fill("Landlord after the fact");
  await schedModal.getByRole("button", { name: "Save", exact: true }).first().click();
  await page.waitForTimeout(2500);

  const madeToday = (
    await db.query(
      `select id, last_posted_on from expense_schedules
        where clinic_id = $1 and vendor = 'Landlord after the fact'`,
      [clinic.id]
    )
  ).rows[0];
  check(
    "a rule created after its day is not marked as already handled",
    !!madeToday && madeToday.last_posted_on === null,
    String(madeToday?.last_posted_on)
  );

  await postRecurringExpenses();
  const nowPosted = (
    await db.query(
      `select count(*)::int n, coalesce(sum(amount),0)::numeric total
         from expenses where schedule_id = $1`,
      [madeToday?.id]
    )
  ).rows[0];
  check(
    "and it lands in this month rather than next",
    nowPosted.n === 1 && Number(nowPosted.total) === 200,
    `${nowPosted.n} rows, ${nowPosted.total}`
  );

  /*
    Read back rather than hardcoded: this runs after the manual expenses, the
    rent rule and the attached bill, and a literal here would have to be
    re-derived every time one of those changes.
  */
  const monthNow = await clinicExpenses(c, scope);
  const shown = monthNow.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  await page.reload();
  await page.waitForLoadState("networkidle");
  const withBill = await mainText();
  check(
    "so the month's total on screen counts it",
    withBill.includes(shown),
    `want ${shown} — ${withBill.slice(0, 100)}`
  );

  check("no client-side errors", errors.length === 0, errors.slice(0, 2).join("; "));
  await browser.close();

  // ---- teardown ----------------------------------------------------------
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where email like $1`, [`%-${tag}@test.local`]);
  await db.end();

  console.log(`\nexpenses: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
