/**
 * Compile the app before the suites time themselves against it.
 *
 * In dev, Next builds each route the first time it is asked for, and that
 * first hit can take longer than the 10–20s waits the browser suites use. On a
 * freshly started stack that reads as a dozen unrelated failures; the second
 * run of the same suites passes untouched. Walking the routes once here means
 * the suites measure the app rather than the compiler.
 */
import { chromium } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

const ROUTES = [
  "",
  "/conversations",
  "/calendar",
  "/patients",
  "/invoices",
  "/documents",
  "/automations",
  "/campaigns",
  "/ai",
  "/tasks",
  "/profile",
  "/notifications",
  "/signature",
  "/settings",
  "/settings/staff",
  "/settings/services",
  "/settings/hours",
  "/settings/fields",
  "/settings/tags",
  "/settings/documents",
  "/settings/booking",
  "/settings/whatsapp",
  "/settings/invoicing",
];

/*
  The public routes, which need tokens the warm-up has no way to mint. A bad
  token still compiles the route, which is the whole point — the signing suite
  budgets its first journey at 15s and was spending 20 of them on the compiler.
*/
const PUBLIC_ROUTES = ["/sign/warmup", "/inv/warmup", "/doc-print/warmup", "/invite/warmup"];

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qawarm${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug) values ('QA Warm','تهيئة',$1) returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const user = (
    await db.query(
      `insert into users (email, password_hash, full_name) values ($1,$2,'QA Warm') returning id`,
      [`warm-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, user.id]
  );

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const t0 = Date.now();

  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', `warm-${slug}@test.local`);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000 });

  const visit = async (url: string, label: string) => {
    try {
      await page.goto(url, { timeout: 120000 });
      await page.waitForLoadState("networkidle", { timeout: 60000 });
    } catch {
      // A route that will not compile is the suites' problem to report, not
      // ours — warming is best effort.
      console.log(`  · ${label} did not settle`);
    }
  };

  for (const r of ROUTES) await visit(`${BASE}/c/${slug}${r}`, r || "/");
  for (const r of PUBLIC_ROUTES) await visit(`${BASE}${r}`, r);

  await browser.close();
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [user.id]);
  await db.end();
  console.log(`✓ warmed ${ROUTES.length + PUBLIC_ROUTES.length} routes in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((e) => {
  console.error("warm-up failed:", e.message);
  process.exit(1);
});
