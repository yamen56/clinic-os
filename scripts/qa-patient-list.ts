/**
 * The patient list as a table (2026-11-21): who owes, who is next in, and who
 * may see which.
 *
 * What is protected:
 *  - the Owes column and the "Owe money" preset reveal who owes the clinic, so
 *    a member without Invoices gets neither — not a hidden column, no amount in
 *    the page at all, and `?owes=1` typed into the address bar does nothing;
 *  - the amount is the one rule for owed (total − paid on draft, sent and
 *    part-paid invoices, credit notes and void left out);
 *  - a filter that matches nobody says "no results", not "no patients yet";
 *  - on a phone the chips are a thumb's height.
 */
import { chromium, devices, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

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

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000, waitUntil: "commit" });
}

async function land(page: Page, url: string) {
  await page.goto(url, { timeout: 120_000 });
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(400);
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const slug = `qaplist${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, currency) values ('QA List','قائمة',$1,'en','JOD') returning id`,
      [slug]
    )
  ).rows[0].id as string;
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic]);
  const user = async (tag: string, perms: string, owner: boolean) => {
    const id = (
      await db.query(`insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'en') returning id`, [
        `${tag}-${slug}@test.local`,
        bcrypt.hashSync("password123", 10),
        `QA ${tag}`,
      ])
    ).rows[0].id as string;
    await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'receptionist',$3,$4)`, [
      clinic,
      id,
      owner,
      perms,
    ]);
  };
  await user("owner", '{"level":"full"}', true);
  await user("desk", JSON.stringify({ level: "custom", caps: { patients: true, calendar: true } }), false);

  const patient = async (name: string) =>
    (await db.query(`insert into patients (clinic_id, full_name, source) values ($1,$2,'staff') returning id`, [clinic, name])).rows[0].id as string;
  const owes = await patient("Owes Omar");
  const paid = await patient("Paid Paula");
  const voided = await patient("Void Victor");
  const invoice = (p: string, n: number, total: number, paidAmount: number, status: string) =>
    db.query(
      `insert into invoices (clinic_id, patient_id, seq, number, subtotal, total, amount_paid, status, issue_date) values ($1,$2,$3,$4,$5,$5,$6,$7,current_date)`,
      [clinic, p, n, `QPL-${n}`, total, paidAmount, status]
    );
  await invoice(owes, 1, 300, 120, "partially_paid"); // 180 owed
  await invoice(owes, 2, 50, 0, "sent"); // + 50 = 230
  await invoice(paid, 3, 80, 80, "paid");
  await invoice(voided, 4, 999, 0, "void");
  // Next visit for Paula, so a row shows one.
  await db.query(
    `insert into appointments (clinic_id, patient_id, starts_at, ends_at, status) values ($1,$2, now() + interval '3 days', now() + interval '3 days 30 minutes', 'confirmed')`,
    [clinic, paid]
  );

  const browser = await chromium.launch();
  try {
    console.log("\n[the owner, at 1440]");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await signIn(page, `owner-${slug}@test.local`);
    await land(page, `${BASE}/c/${slug}/patients`);
    const owed = await page.locator("[data-owed]").evaluateAll((els) => els.map((e) => [e.closest("a")?.textContent ?? "", e.getAttribute("data-owed")]));
    const of = (name: string) => owed.find(([t]) => (t ?? "").includes(name))?.[1];
    check("what a patient owes is total less paid, over every open invoice", of("Owes Omar") === "230", String(of("Owes Omar")));
    check("a paid invoice owes nothing", of("Paid Paula") === "0", String(of("Paid Paula")));
    check("a void invoice owes nothing", of("Void Victor") === "0", String(of("Void Victor")));
    check("the count is in the title", (await page.locator("[data-patient-total]").innerText()).trim() === "3");
    const main = await page.locator("main").innerText();
    check("the next visit shows on its row", /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}/.test(main), main.slice(0, 200));

    await page.click('[data-preset="owes"]');
    await page.waitForURL(/owes=1/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    const owing = await page.locator("main").innerText();
    check("Owe money lists who owes, and only them", owing.includes("Owes Omar") && !owing.includes("Paid Paula") && !owing.includes("Void Victor"), owing.slice(0, 200));

    await land(page, `${BASE}/c/${slug}/patients?visit=30&tag=nobody-has-this`);
    const empty = await page.locator("main").innerText();
    check("a filter that matches nobody says no results, not 'no patients yet'", !/No patients yet/.test(empty), empty.slice(0, 160));

    await page.click("[data-filters-toggle]");
    check("the Filters menu holds the other filters", (await page.locator("[data-filters-menu] select").count()) === 4);
    await ctx.close();

    console.log("\n[a receptionist without invoices]");
    const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const desk = await dctx.newPage();
    await signIn(desk, `desk-${slug}@test.local`);
    await land(desk, `${BASE}/c/${slug}/patients`);
    const html = await desk.content();
    check("no Owes column", (await desk.locator("[data-owed]").count()) === 0);
    check("no Owe money preset", (await desk.locator('[data-preset="owes"]').count()) === 0);
    check("and no amount anywhere in the page", !html.includes("230.00") && !html.includes('"owed":230'), "");
    await land(desk, `${BASE}/c/${slug}/patients?owes=1`);
    const typed = await desk.locator("main").innerText();
    check("?owes=1 typed in does not filter for her", typed.includes("Paid Paula") && typed.includes("Owes Omar"), typed.slice(0, 160));
    const api = await desk.evaluate(async (s) => (await (await fetch(`/api/c/${s}/patients/list?owes=1&cursorTs=2999-01-01&cursorId=00000000-0000-0000-0000-000000000000`)).json()) as { patients: { owed: unknown }[] }, slug);
    check("nor does the load-more route, and its rows carry no amount", api.patients.length === 3 && api.patients.every((p) => p.owed === null), JSON.stringify(api.patients.map((p) => p.owed)));
    await dctx.close();

    console.log("\n[on a phone]");
    const pctx = await browser.newContext({ ...devices["iPhone 13"] });
    const phone = await pctx.newPage();
    await signIn(phone, `owner-${slug}@test.local`);
    await land(phone, `${BASE}/c/${slug}/patients`);
    const heights = await phone.locator("[data-preset], [data-filters-toggle]").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    check("the presets and Filters are a thumb's height", heights.length > 0 && heights.every((h) => h >= 40), heights.join(","));
    const over = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("nothing scrolls sideways", over <= 1, `${over}px`);
    await pctx.close();
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinic]);
    await db.query(`delete from users where email like $1`, [`%-${slug}@test.local`]);
    await db.end();
  }

  console.log(`\n${failures.length ? "✗" : "✓"} ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
