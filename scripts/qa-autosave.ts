/**
 * "It said Saved, and when I came back it wasn't."
 *
 * Autosave was right about the database and wrong about the screen. Each check
 * below is a path a receptionist actually takes after typing: leaving at once,
 * pressing Back, hopping between settings tabs, switching tabs inside the file.
 * Every one of them used to show the value that had just been replaced — the
 * edit was still in its debounce when the next page read the database, or the
 * router restored a snapshot taken before the save.
 *
 * Needs the dev server (qa-warm first) and the local database.
 */
import { chromium } from "playwright";
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

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const slug = `qasave${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, timezone, address)
       values ('QA Save','حفظ',$1,'Asia/Amman','OLD-ADDR') returning id`,
      [slug]
    )
  ).rows[0];
  const email = `save-${slug}@test.local`;
  const user = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,'Save QA','en') returning id`,
      [email, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, user.id]
  );
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source)
       values ($1,'Old Name','+962790000123','staff') returning id`,
      [clinic.id]
    )
  ).rows[0];
  for (const [key, label, opts] of [
    ["qa_one", "QA One", ["one-a", "one-b"]],
    ["qa_two", "QA Two", ["two-a", "two-b"]],
  ] as const) {
    await db.query(
      `insert into patient_field_definitions (clinic_id, scope, key, label, field_type, options)
       values ($1,'patient',$2,$3,'select',$4)`,
      [clinic.id, key, label, JSON.stringify(opts)]
    );
  }
  console.log(`✓ fixture clinic ${slug}`);

  const dbName = async () =>
    (await db.query(`select full_name from patients where id = $1`, [patient.id])).rows[0].full_name as string;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });

    const profile = `${BASE}/c/${slug}/patients/${patient.id}`;
    const list = `a[href="/c/${slug}/patients"]`;
    const nameBox = () => page.locator('input[aria-label="Full name"]').first();
    const saved = () => page.getByText("Saved", { exact: true }).first().waitFor({ timeout: 30_000 });

    /* ------------------------------------------ type, and leave at once */
    await page.goto(profile);
    await nameBox().waitFor({ timeout: 60_000 });
    await nameBox().fill("Name A");
    await page.waitForTimeout(200);
    check(
      "nothing claims Saved while the edit is still waiting",
      !/\bSaved\b/.test(await page.locator("body").innerText())
    );
    await page.locator(list).first().click();
    await page.waitForURL((u) => u.pathname === `/c/${slug}/patients`, { timeout: 60_000 });
    await page.getByText(/Name A|Old Name/).first().waitFor({ timeout: 60_000 });
    const listText = await page.locator("body").innerText();
    check(
      "the list you land on already has the edit",
      listText.includes("Name A"),
      listText.includes("Old Name") ? "shows the old name" : ""
    );
    await page.getByText(/Name A|Old Name/).first().click();
    await nameBox().waitFor({ timeout: 60_000 });
    check("and so does the file, opened again", (await nameBox().inputValue()) === "Name A", await nameBox().inputValue());

    /* ------------------------------------------ wait for Saved, leave, Back */
    await nameBox().fill("Name B");
    await saved();
    await page.locator(list).first().click();
    await page.waitForURL((u) => u.pathname === `/c/${slug}/patients`, { timeout: 60_000 });
    await page.goBack();
    await nameBox().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(500);
    check(
      "Back shows what was saved, not the page from before it",
      (await nameBox().inputValue()) === "Name B",
      await nameBox().inputValue()
    );
    check("and the database agrees", (await dbName()) === "Name B", await dbName());

    /* ---------------------------------------- settings tab and straight back */
    await page.goto(`${BASE}/c/${slug}/settings`);
    const addr = page.locator('input[value="OLD-ADDR"]').first();
    await addr.waitFor({ timeout: 60_000 });
    await addr.fill("NEW-ADDR");
    await page.waitForTimeout(150);
    await page.locator(`a[href="/c/${slug}/settings/hours"]`).first().click();
    await page.waitForURL((u) => u.pathname.endsWith("/settings/hours"), { timeout: 60_000 });
    await page.locator(`a[href="/c/${slug}/settings"]`).first().click();
    await page.waitForURL((u) => u.pathname === `/c/${slug}/settings`, { timeout: 60_000 });
    await page.waitForTimeout(300);
    const values = await page.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    check(
      "a settings tab and back keeps the edit",
      values.includes("NEW-ADDR"),
      values.includes("OLD-ADDR") ? "shows the old address" : ""
    );

    /* ------------------------------------------- the indicator tells the truth */
    await page.goto(profile);
    await nameBox().waitFor({ timeout: 60_000 });
    await nameBox().fill("Name D1");
    await saved();
    await nameBox().fill("Name D2");
    await page.waitForTimeout(150);
    const header = await page.locator("body").innerText();
    check(
      "a new keystroke turns Saved back into Saving…",
      header.includes("Saving…") && !/\bSaved\b/.test(header)
    );
    await saved();
    check("and Saved comes back only once it is in the database", (await dbName()) === "Name D2", await dbName());

    /* ------------------------------------- two custom fields in one debounce */
    await page.locator('select:has(option[value="one-b"])').first().selectOption("one-b");
    await page.locator('select:has(option[value="two-b"])').first().selectOption("two-b");
    await saved();
    const cf = (await db.query(`select custom_fields from patients where id = $1`, [patient.id])).rows[0]
      .custom_fields;
    check(
      "two custom fields changed together both arrive",
      cf.qa_one === "one-b" && cf.qa_two === "two-b",
      JSON.stringify(cf)
    );

    /* ------------------------------------------------ a tab inside the file */
    await nameBox().fill("Name F");
    await page.getByRole("tab", { name: /Notes/ }).first().click();
    await page.getByRole("tab", { name: /Overview/ }).first().click();
    check("switching tabs inside the file keeps the edit", (await nameBox().inputValue()) === "Name F");
    await saved();

    /* ----------------------------- one bad value does not sink the others */
    const g = await page.evaluate(async (url) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: { full_name: "Name G", phone_e164: "12" } }),
      });
      return { status: r.status, body: await r.json() };
    }, `/api/c/${slug}/patients/${patient.id}`);
    check("a patch with one bad value is still accepted", g.status === 200, String(g.status));
    check("the bad value is refused by name", g.body?.rejected?.phone_e164?.error === "invalid_phone");
    check("and the name typed beside it is saved", (await dbName()) === "Name G", await dbName());
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = $1`, [user.id]);
    await db.end();
  }

  console.log(`\n  autosave: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
