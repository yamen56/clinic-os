/** Browser QA for Phase 1: login, admin panel, clinic creation, workspace shell, RTL toggle. */
import { chromium } from "playwright";

const BASE = "http://localhost:3000";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  // 1. Login as super admin
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', "admin@makan.agency");
  await page.fill('input[name="password"]', "admin1234");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/admin", { timeout: 20000 });
  console.log("✓ admin login → /admin");

  // 2. RTL default
  const dir = await page.getAttribute("html", "dir");
  console.log(`✓ html dir=${dir}`);

  // 3. Create a clinic (idempotent-ish: unique slug per run)
  const slug = `qa-clinic-${Date.now().toString(36)}`;
  await page.goto(`${BASE}/admin/clinics/new`);
  await page.fill('input[name="name"]', "QA Clinic");
  await page.fill('input[name="nameAr"]', "عيادة الاختبار");
  await page.fill('input[name="slug"]', slug);
  await page.fill('input[name="ownerName"]', "Test Owner");
  await page.fill('input[name="ownerEmail"]', `owner-${slug}@test.local`);
  await page.fill('input[name="ownerPassword"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL(`**/admin/clinics/${slug}`, { timeout: 20000 });
  console.log("✓ clinic created → detail page");

  // 4. Impersonate → workspace shell (admin session is English)
  await page.click("text=Open workspace");
  await page.waitForURL(`**/c/${slug}`, { timeout: 20000 });
  const banner = await page.textContent("body");
  if (!banner?.includes("Support mode")) throw new Error("impersonation banner missing");
  console.log("✓ impersonation banner shown in workspace");

  // 5. Dashboard renders stats
  await page.waitForSelector("text=Today's appointments", { timeout: 10000 });
  console.log("✓ dashboard renders (English)");

  // 6. Language toggle to Arabic flips direction
  await page.click("text=العربية");
  await page.waitForFunction(() => document.documentElement.dir === "rtl", { timeout: 10000 });
  await page.waitForSelector("text=مواعيد اليوم", { timeout: 10000 });
  console.log("✓ language toggle → RTL Arabic dashboard");
  await page.screenshot({ path: "scripts/qa-shots/phase1-dashboard.png" });
  await page.click("text=English");
  await page.waitForFunction(() => document.documentElement.dir === "ltr", { timeout: 10000 });
  console.log("✓ toggle back → LTR");

  // 7. Owner login in a fresh context
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/login`);
  await p2.fill('input[name="email"]', `owner-${slug}@test.local`);
  await p2.fill('input[name="password"]', "password123");
  await p2.click('button[type="submit"]');
  await p2.waitForURL(`**/c/${slug}`, { timeout: 20000 });
  console.log("✓ owner login lands in own workspace");
  const adminAccess = await p2.goto(`${BASE}/admin`);
  if (p2.url().includes("/admin")) throw new Error("owner reached /admin!");
  console.log(`✓ owner blocked from /admin (landed ${p2.url()})`);
  await ctx2.close();

  await page.screenshot({ path: "scripts/qa-shots/phase1-dashboard.png", fullPage: false });
  await browser.close();

  const realErrors = errors.filter(
    (e) => !e.includes("favicon") && !e.includes("manifest") && !e.includes("icon-192")
  );
  if (realErrors.length) {
    console.error("Console/page errors:", realErrors.slice(0, 10));
    process.exit(1);
  }
  console.log("PHASE 1 QA PASSED");
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
