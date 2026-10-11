/**
 * Screenshots of the Treatment tab at the sizes it is used at: a phone, an
 * iPad held both ways, and a desktop. Uses the newest clinic qa-treatment
 * left behind (run that first). Shots go to scripts/qa-shots/treatment/.
 */
import { chromium } from "playwright";
import { Client } from "pg";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = join(process.cwd(), "scripts", "qa-shots", "treatment");

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const db = new Client({ connectionString: PG });
  await db.connect();
  const [row] = (
    await db.query(
      `select cl.slug, u.email, p.id as patient
         from clinics cl
         join clinic_members cm on cm.clinic_id = cl.id and cm.role = 'doctor'
         join users u on u.id = cm.user_id
         join patients p on p.clinic_id = cl.id and p.full_name = 'Hala Nasser'
        where cl.slug like 'qatreat%'
        order by cl.created_at desc limit 1`
    )
  ).rows;
  await db.end();
  if (!row) throw new Error("run qa-treatment first");

  const browser = await chromium.launch();
  const sizes = [
    { name: "phone", width: 390, height: 844, mobile: true },
    { name: "ipad-portrait", width: 820, height: 1180, mobile: true },
    { name: "ipad-landscape", width: 1180, height: 820, mobile: true },
    { name: "desktop", width: 1440, height: 1000, mobile: false },
  ];
  for (const locale of ["en", "ar"]) {
    for (const s of sizes) {
      const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: 1, isMobile: s.mobile, hasTouch: s.mobile });
      await ctx.addCookies([{ name: "cos_locale", value: locale, url: BASE }]);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/login`, { timeout: 180000 });
      await page.fill('input[name="email"]', row.email);
      await page.fill('input[name="password"]', "password123");
      await page.click('button[type="submit"]');
      await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 180000, waitUntil: "commit" });
      await page.goto(`${BASE}/c/${row.slug}/patients/${row.patient}?tab=treatment`, { timeout: 180000 });
      await page.waitForSelector("[data-treatment-tab] [data-plan]", { timeout: 120000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(SHOTS, `tab-${locale}-${s.name}.png`), fullPage: false });
      // The root canal's steps, as the doctor opens them.
      const item = page.locator("[data-plan-item] button").first();
      if (await item.count()) {
        await item.click();
        await page.waitForSelector("[data-procedure]", { timeout: 20000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(SHOTS, `card-${locale}-${s.name}.png`), fullPage: false });
      }
      await ctx.close();
      console.log(`  · ${locale} ${s.name}`);
    }
  }
  await browser.close();
  console.log(`screenshots in ${SHOTS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
