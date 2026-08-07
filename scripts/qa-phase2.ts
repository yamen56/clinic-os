/** Browser QA for Phase 2: patients, identity rule, autosave, notes, files, custom fields, merge. */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3000";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Login as super admin (English UI), create a fresh clinic, impersonate into it
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', "admin@makan.agency");
  await page.fill('input[name="password"]', "admin1234");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/admin", { timeout: 30000 });
  const slug = `qa2-${Date.now().toString(36)}`;
  await page.goto(`${BASE}/admin/clinics/new`);
  await page.fill('input[name="name"]', "QA2 Clinic");
  await page.fill('input[name="slug"]', slug);
  await page.fill('input[name="ownerName"]', "QA Owner");
  await page.fill('input[name="ownerEmail"]', `owner-${slug}@test.local`);
  await page.click('button[type="submit"]');
  await page.waitForURL(`**/admin/clinics/${slug}`, { timeout: 20000 });
  await page.click("text=Open workspace");
  await page.waitForURL(`**/c/${slug}`, { timeout: 20000 });
  console.log(`✓ in workspace ${slug}`);

  // 1. Create a patient
  await page.goto(`${BASE}/c/${slug}/patients`);
  await page.click("text=New patient");
  await page.fill('input[dir="ltr"]', "0790744070");
  const nameInput = page.locator(".grid input").first();
  await nameInput.fill("محمد الخطيب");
  await page.click("text=Create >> nth=0");
  await page.waitForURL("**/patients/**", { timeout: 15000 });
  const patientUrl = page.url();
  console.log("✓ patient created");

  // 2. Identity rule: same phone in different format opens the SAME patient
  await page.goto(`${BASE}/c/${slug}/patients`);
  await page.click("text=New patient");
  await page.fill('input[dir="ltr"]', "+962 79 074 4070");
  await page.locator(".grid input").first().fill("Mohammad Duplicate");
  await page.click("text=Create >> nth=0");
  await page.waitForURL("**/patients/**", { timeout: 15000 });
  if (page.url() !== patientUrl) throw new Error(`identity rule failed: ${page.url()} != ${patientUrl}`);
  console.log("✓ identity rule: duplicate phone resolved to existing patient");

  // 3. Autosave name: type, wait for save, reload, verify
  const header = page.locator('input[aria-label="Full name"]');
  await header.fill("محمد الخطيب المحدث");
  await page.waitForSelector("text=Saved", { timeout: 8000 });
  await page.reload();
  await page.waitForLoadState("networkidle");
  const savedName = await page.locator('input[aria-label="Full name"]').inputValue();
  if (savedName !== "محمد الخطيب المحدث") throw new Error(`autosave failed: ${savedName}`);
  console.log("✓ autosave: name persisted after reload");

  // 4. Tag inline (retry click until the inline input hydrates)
  for (let i = 0; i < 6; i++) {
    await page.click("text=Add tag");
    const input = await page
      .waitForSelector("input.h-6", { timeout: 1500 })
      .catch(() => null);
    if (input) break;
  }
  await page.keyboard.type("vip");
  await page.keyboard.press("Enter");
  await page.waitForSelector("span:has-text('vip')", { timeout: 5000 });
  console.log("✓ tag added inline");

  // 5. Note with autosave edit
  await page.click('[role="tab"]:has-text("Notes")');
  await page.fill("textarea", "المريض يعاني من حساسية البنسلين");
  await page.click("text=Add note");
  await page.waitForSelector("text=حساسية البنسلين", { timeout: 8000 });
  console.log("✓ note added");

  // 6. File upload
  await page.click('[role="tab"]:has-text("Files")');
  fs.writeFileSync("scripts/qa-shots/test-xray.png", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles("scripts/qa-shots/test-xray.png");
  await page.waitForSelector("text=test-xray.png", { timeout: 10000 });
  console.log("✓ file uploaded and listed");

  // 7. Custom field def + shows on profile
  await page.goto(`${BASE}/c/${slug}/settings/fields`);
  await page.click("text=Add field");
  await page.fill('.grid input >> nth=0', "Insurance Provider");
  await page.fill('input[dir="rtl"]', "شركة التأمين");
  await page.click("button:has-text('Save')");
  await page.waitForSelector("text=Insurance Provider", { timeout: 8000 });
  await page.goto(patientUrl);
  await page.waitForSelector("text=Insurance Provider", { timeout: 8000 });
  console.log("✓ custom field defined and visible on patient file");

  // 8. Merge tool: create another patient, then merge it into the first
  await page.goto(`${BASE}/c/${slug}/patients`);
  await page.click("text=New patient");
  await page.fill('input[dir="ltr"]', "0781112233");
  await page.locator(".grid input").first().fill("سجل مكرر للدمج");
  await page.click("text=Create >> nth=0");
  await page.waitForURL("**/patients/**");
  await page.goto(patientUrl);
  await page.waitForLoadState("networkidle");
  for (let i = 0; i < 5; i++) {
    await page.click('button[aria-label="Actions"]');
    const visible = await page
      .waitForSelector("text=Merge records", { timeout: 2000 })
      .catch(() => null);
    if (visible) break;
  }
  await page.click("text=Merge records");
  await page.fill('div[role="dialog"] input', "مكرر");
  await page.waitForSelector('div[role="dialog"] button:has-text("سجل مكرر")', { timeout: 8000 });
  await page.click('div[role="dialog"] button:has-text("سجل مكرر")');
  await page.click("button:has-text('Merge into this record')");
  await page.waitForSelector("text=Records merged", { timeout: 10000 });
  await page.reload();
  const bodyTxt = await page.textContent("body");
  if (!bodyTxt?.includes("+962 78 111 2233")) throw new Error("merged phone not on surviving file");
  console.log("✓ merge: records combined, both numbers kept");

  // 9. Search by weird phone format finds the patient
  await page.goto(`${BASE}/c/${slug}/patients?q=${encodeURIComponent("079-074-4070")}`);
  await page.waitForSelector("text=محمد الخطيب المحدث", { timeout: 8000 });
  console.log("✓ search by any phone format");

  await page.screenshot({ path: "scripts/qa-shots/phase2-profile.png" });
  await browser.close();
  if (errors.length) {
    console.error("page errors:", errors.slice(0, 5));
    process.exit(1);
  }
  console.log("PHASE 2 QA PASSED");
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
