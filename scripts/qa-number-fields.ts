/**
 * QA: a number field you can empty.
 *
 * Reported from a real desk: selecting a price and pressing delete left a `0`
 * behind that could not be removed, so typing 50 over it produced 050. The cause
 * was every numeric field in the app being a controlled input whose handler read
 * `Number(e.target.value) || fallback` — the empty string becomes 0, 0 is falsy,
 * the fallback goes into state, and React puts it straight back in the box.
 *
 * This drives the keyboard rather than the props, because the bug only exists in
 * the round trip between them: the state was always correct, and the box was
 * always wrong. Nothing short of typing reproduces it.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
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

/** Select everything in the focused field and delete it, as a person would. */
async function clearField(page: Page, selector: string) {
  await page.click(selector);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  await db.query(`delete from auth_attempts`);

  const stamp = Date.now().toString(36);
  const slug = `qanum${stamp}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, invoice_prefix)
       values ('QA Numbers','أرقام',$1,'ar','Asia/Amman','JOD','QAN') returning id`,
      [slug]
    )
  ).rows[0];
  const user = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale)
       values ($1,$2,'QA Owner','ar') returning id`,
      [`num-${stamp}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, user.id]
  );
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164) values ($1,'QA Patient',$2) returning id`,
      [clinic.id, `+96279${Math.floor(1000000 + Math.random() * 8999999)}`]
    )
  ).rows[0].id as string;
  await db.query(
    `insert into services (clinic_id, name, name_ar, price, duration_min)
     values ($1,'Cleaning','تنظيف',25,30)`,
    [clinic.id]
  );
  console.log(`\n✓ fixtures: ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  try {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', `num-${stamp}@test.local`);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });

    /* ================================================================== */
    console.log("\n[the price on an invoice line]");

    await page.goto(`${BASE}/c/${slug}/invoices/new?patient=${patient}`);
    await page.waitForLoadState("networkidle");
    // Add the clinic's service, which arrives with a price already in the box —
    // the state the bug needs: something to delete.
    await page.getByRole("button", { name: /تنظيف/ }).first().click();
    await page.waitForTimeout(300);

    const price = 'input[aria-label="السعر"]';
    check("the line starts with the service's price", (await page.locator(price).inputValue()) === "25", await page.locator(price).inputValue());

    await clearField(page, price);
    check(
      "deleting it leaves the box empty, not holding a 0",
      (await page.locator(price).inputValue()) === "",
      `"${await page.locator(price).inputValue()}"`
    );

    await page.keyboard.type("50");
    check(
      "so typing a new price gives 50, not 050",
      (await page.locator(price).inputValue()) === "50",
      await page.locator(price).inputValue()
    );

    /* The total has to follow the box, or the preview is lying about the bill. */
    const shown = await page.locator("main").first().innerText();
    check("and the invoice total follows what was typed", shown.includes("50"), "");

    /*
      Leaving it genuinely empty must still produce a number, because the
      invoice is arithmetic — an empty box that reached the server as NaN would
      be a bill for nothing.
    */
    await clearField(page, price);
    await page.locator('input[aria-label="الكمية"]').click();
    await page.waitForTimeout(200);
    check(
      "walking away from an empty box settles it at zero",
      (await page.locator(price).inputValue()) === "0",
      await page.locator(price).inputValue()
    );

    /* ================================================================== */
    console.log("\n[a field with a floor, which is the harder case]");

    const qty = 'input[aria-label="الكمية"]';
    await clearField(page, qty);
    check(
      "a minimum of 1 does not stop the box being emptied",
      (await page.locator(qty).inputValue()) === "",
      `"${await page.locator(qty).inputValue()}"`
    );
    /*
      The reason clamping happens on blur. Clamped per keystroke, a field whose
      minimum is 5 can never be typed up to 50: the 5 is rejected before the 0
      arrives.
    */
    await page.keyboard.type("12");
    check(
      "and a value above the floor types straight through",
      (await page.locator(qty).inputValue()) === "12",
      await page.locator(qty).inputValue()
    );
    await page.locator(price).click();
    await page.waitForTimeout(200);
    check("which then stays as typed", (await page.locator(qty).inputValue()) === "12", await page.locator(qty).inputValue());

    /* ================================================================== */
    console.log("\n[the service price in settings]");

    await page.goto(`${BASE}/c/${slug}/settings/services`);
    await page.waitForLoadState("networkidle");
    // The editor opens from the pencil beside the row, not from the row itself.
    await page.getByRole("button", { name: "تعديل" }).first().click();
    await page.waitForTimeout(600);

    /* The price box on the editor, found by its label rather than by position. */
    const svcPrice = page
      .locator("label")
      .filter({ hasText: /السعر/ })
      .locator('input[type="number"]')
      .first();
    if (await svcPrice.count()) {
      await svcPrice.click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Delete");
      check(
        "a service price clears the same way",
        (await svcPrice.inputValue()) === "",
        `"${await svcPrice.inputValue()}"`
      );
      await page.keyboard.type("40");
      check("and accepts the new figure cleanly", (await svcPrice.inputValue()) === "40", await svcPrice.inputValue());
    } else {
      check("the service editor exposes its price field", false, "not found");
    }

    /* ================================================================== */
    console.log("\n[nothing else regressed]");
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (const path of ["/settings/booking", "/settings/documents", "/notifications", "/ai"]) {
      await page.goto(`${BASE}/c/${slug}${path}`);
      await page.waitForLoadState("networkidle");
    }
    check("every screen carrying a number field still renders", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }

  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [user.id]);
  await db.end();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
