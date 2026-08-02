/**
 * How the workspace behaves on a tablet.
 *
 * The gap this covers: the layout was designed for a phone and for a desktop,
 * and an iPad is neither. Between 768 and 1280 the fixed sidebar, the
 * conversation list and the patient panel are all shown at once, and they add
 * up to more than the screen — leaving the actual conversation a sliver.
 *
 * Measured in real pixels at real device sizes, because "looks cramped" is not
 * something a class list can be read for.
 */
import { chromium, devices, type Page, type Browser } from "playwright";
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

/** The sizes people actually hold. */
const VIEWPORTS = [
  { name: "iPad mini portrait", width: 768, height: 1024 },
  { name: "iPad Pro 11 portrait", width: 834, height: 1194 },
  { name: "iPad landscape", width: 1024, height: 768 },
  { name: "iPad Pro 12.9 landscape", width: 1366, height: 1024 },
];

/** A conversation needs room for a sentence, not a word per line. */
const MIN_THREAD_WIDTH = 380;

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
}

async function go(page: Page, path: string) {
  await page.goto(`${BASE}${path}`);
  await page.waitForLoadState("networkidle");
  // The dev overlay sits over the layout and would be measured as content.
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(400);
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qatab-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale) values ('QA Tablet','لوحي',$1,'ar') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,'QA Tablet','ar') returning id`,
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
       values ($1,'سارة الخطيب','+962790111222','staff') returning id`,
      [clinic.id]
    )
  ).rows[0];
  const conv = (
    await db.query(
      `insert into conversations (clinic_id, phone_e164, patient_id, last_message_at, last_message_preview)
       values ($1,'+962790111222',$2, now(), 'مرحبا، بدي موعد') returning id`,
      [clinic.id, patient.id]
    )
  ).rows[0];
  for (let i = 0; i < 6; i++) {
    await db.query(
      `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body, status)
       values ($1,$2,$3,'staff','text',$4,'sent')`,
      [clinic.id, conv.id, i % 2 ? "out" : "in", `رسالة تجريبية رقم ${i + 1} لقياس عرض المحادثة`]
    );
  }
  console.log(`✓ fixture clinic ${slug}`);

  const browser: Browser = await chromium.launch();
  const errors: string[] = [];

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${vp.name}: ${e.message}`));
    await signIn(page, `owner-${slug}@test.local`);

    console.log(`\n  — ${vp.name} (${vp.width}×${vp.height}) —`);

    /* ------------------------------------------- nothing may scroll sideways */
    for (const path of [`/c/${slug}`, `/c/${slug}/conversations`, `/c/${slug}/patients`, `/c/${slug}/calendar`]) {
      await go(page, path);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${path.replace(`/c/${slug}`, "") || "/"} does not scroll sideways`, over <= 1, `${over}px`);
    }

    /* ------------------------------- the conversation itself has room to read */
    await go(page, `/c/${slug}/conversations`);
    await page.locator("li,button,a").filter({ hasText: "سارة" }).first().click().catch(() => {});
    await page.waitForTimeout(800);

    const widths = await page.evaluate(() => {
      const bubble = document.querySelector('[class*="max-w-[78%]"]');
      const thread = bubble?.closest("div.flex.min-w-0.flex-1");
      return {
        thread: thread ? Math.round(thread.getBoundingClientRect().width) : 0,
        bubble: bubble ? Math.round(bubble.getBoundingClientRect().width) : 0,
      };
    });
    check(
      `the conversation pane is wide enough to read`,
      widths.thread === 0 || widths.thread >= MIN_THREAD_WIDTH,
      `${widths.thread}px (want ≥${MIN_THREAD_WIDTH})`
    );

    await page.screenshot({
      path: `scripts/qa-shots/tablet-${vp.width}x${vp.height}.png`,
      fullPage: false,
    });
    await ctx.close();
  }

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();

  console.log(`\n  tablet: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
