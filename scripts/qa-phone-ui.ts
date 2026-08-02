/**
 * Phone numbers, on screen, in Arabic.
 *
 * The bug this pins: `dir="ltr"` sets the direction of a run but leaves it
 * taking part in the surrounding bidi order, so in an Arabic page the leading
 * `+` is reordered to the far end and the number reads backwards. Isolation is
 * what fixes it, and isolation is invisible in the markup — so this measures
 * where the glyphs actually land rather than reading the class list.
 */
import { chromium, type Page } from "playwright";
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
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qaphone-test${Date.now().toString(36)}`;
  // Arabic locale deliberately: the bug only appears in an RTL page.
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency)
       values ('QA Phone','هاتف',$1,'ar','Asia/Amman','JOD') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,'QA Phone Owner','ar') returning id`,
      [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, owner.id]
  );
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source)
       values ($1,'محمد القديحي','+962790744070','staff') returning id`,
      [clinic.id]
    )
  ).rows[0];
  console.log(`✓ fixture clinic ${slug} (Arabic)`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await signIn(page, `owner-${slug}@test.local`);
  await page.goto(`${BASE}/c/${slug}/patients/${patient.id}`);
  await page.waitForLoadState("networkidle");

  check("the page really is right-to-left", (await page.locator("html").getAttribute("dir")) === "rtl");

  /* ------------------------------------------- the number reads left to right */
  const el = page.locator(".num").first();
  const text = (await el.textContent())?.trim() ?? "";
  check("a phone number is shown", text.length > 0, text);
  check("it starts with the plus, not ends with it", text.startsWith("+"), text);

  // What the reader sees: the + must be physically left of the last digit.
  const geometry = await el.evaluate((node) => {
    const range = document.createRange();
    const t = node.firstChild!;
    range.setStart(t, 0);
    range.setEnd(t, 1);
    const first = range.getBoundingClientRect();
    const len = (t.textContent ?? "").length;
    range.setStart(t, len - 1);
    range.setEnd(t, len);
    const last = range.getBoundingClientRect();
    return { firstLeft: first.left, lastLeft: last.left };
  });
  check(
    "and is drawn on the left of the number, not flipped to the right",
    geometry.firstLeft < geometry.lastLeft,
    `plus at x=${geometry.firstLeft.toFixed(0)}, last digit at x=${geometry.lastLeft.toFixed(0)}`
  );

  const isolated = await el.evaluate((n) => getComputedStyle(n).unicodeBidi);
  check("because the run is isolated from the Arabic around it", /isolate/.test(isolated), isolated);

  /* --------------------------------------------- the country picker on the form */
  const cc = page.locator('select[aria-label="Country"]').first();
  check("the form offers a country", (await cc.count()) > 0);
  check("defaulted to the clinic's own", (await cc.inputValue()) === "JO", await cc.inputValue());

  const national = page.locator('input[type="tel"]').first();
  check(
    "and the number box holds only the local part",
    (await national.inputValue()) === "790744070",
    await national.inputValue()
  );

  /* ------------------------------------------- changing the country rewrites it */
  await cc.selectOption("SA");
  await national.fill("501234567");
  /*
    Two edits, each behind the autosave's debounce. Waiting a fixed span is
    what makes this flaky on a loaded machine — the timers are wall-clock but
    the work behind them is not. Wait for the value instead.
  */
  let saved = "";
  for (let i = 0; i < 40; i++) {
    saved = (await db.query(`select phone_e164 from patients where id = $1`, [patient.id])).rows[0]
      .phone_e164;
    if (saved === "+966501234567") break;
    await page.waitForTimeout(500);
  }
  check("choosing another country saves the right code", saved === "+966501234567", saved);

  await page.screenshot({ path: "scripts/qa-shots/phone-rtl.png" });

  /* ------------------------- the inbox, where a nameless thread IS a number */
  const conv = (
    await db.query(
      `insert into conversations (clinic_id, phone_e164, last_message_at, last_message_preview)
       values ($1, '+962791112233', now(), 'مرحبا') returning id`,
      [clinic.id]
    )
  ).rows[0];
  await page.goto(`${BASE}/c/${slug}/conversations`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200);

  const title = page.locator(".num").filter({ hasText: "+962" }).first();
  check("a nameless thread is titled with the number", (await title.count()) > 0);
  if (await title.count()) {
    const g = await title.evaluate((node) => {
      const t = node.firstChild!;
      const r = document.createRange();
      r.setStart(t, 0); r.setEnd(t, 1);
      const first = r.getBoundingClientRect();
      const len = (t.textContent ?? "").length;
      r.setStart(t, len - 1); r.setEnd(t, len);
      return { a: first.left, b: r.getBoundingClientRect().left };
    });
    check("and it is not reversed in the inbox", g.a < g.b, `plus x=${g.a.toFixed(0)}, last x=${g.b.toFixed(0)}`);
  }

  /* ------------------------------------- and it survives switching language */
  // The reported symptom was numbers flipping when the language changed, so the
  // check is repeated after an actual switch rather than assumed to carry over.
  await page.context().addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  await page.reload();
  await page.waitForLoadState("networkidle");
  check("switching to English keeps the page LTR", (await page.locator("html").getAttribute("dir")) === "ltr");
  const enTitle = page.locator(".num").filter({ hasText: "+962" }).first();
  if (await enTitle.count()) {
    const g = await enTitle.evaluate((node) => {
      const t = node.firstChild!;
      const r = document.createRange();
      r.setStart(t, 0); r.setEnd(t, 1);
      const first = r.getBoundingClientRect();
      const len = (t.textContent ?? "").length;
      r.setStart(t, len - 1); r.setEnd(t, len);
      return { a: first.left, b: r.getBoundingClientRect().left };
    });
    check("and the number still reads forwards in English", g.a < g.b);
  }
  await db.query(`delete from conversations where id = $1`, [conv.id]);

  check("no page errors", errors.length === 0, errors.join(" | "));

  await browser.close();
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();

  console.log(`\n  phone UI: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
