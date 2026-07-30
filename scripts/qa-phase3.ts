/** Browser QA for Phase 3: staff, services, hours, calendar, conflicts, drag, realtime. */
import { chromium, type Page } from "playwright";
import { DateTime } from "luxon";

const BASE = "http://localhost:3000";
// Clinic-local date (Asia/Amman): after midnight there the UTC date is still
// "yesterday", which can fall outside the displayed week.
const CLINIC_TODAY = DateTime.now().setZone("Asia/Amman").toISODate()!;

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await login(page, "admin@makan.agency", "admin1234");
  const slug = `qa3-${Date.now().toString(36)}`;
  await page.goto(`${BASE}/admin/clinics/new`);
  await page.fill('input[name="name"]', "QA3 Clinic");
  await page.fill('input[name="slug"]', slug);
  await page.fill('input[name="ownerName"]', "QA Owner");
  await page.fill('input[name="ownerEmail"]', `owner-${slug}@test.local`);
  await page.fill('input[name="ownerPassword"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL(`**/admin/clinics/${slug}`, { timeout: 20000 });
  await page.click("text=Open workspace");
  await page.waitForURL(`**/c/${slug}`);
  console.log(`✓ in workspace ${slug}`);

  // 1. Add a doctor
  await page.goto(`${BASE}/c/${slug}/settings/staff`);
  await page.waitForLoadState("networkidle");
  await page.click("text=Add staff member");
  await page.waitForSelector('div[role="dialog"]');
  const dlg = page.locator('div[role="dialog"]');
  await dlg.locator("input").nth(0).fill("د. سارة العمري");
  await dlg.locator('input[type="email"]').fill(`dr-${slug}@test.local`);
  // No password here: staff are invited by email and choose their own, so the
  // dialog has none to fill. This suite only needs the member to exist.
  await dlg.locator("select").selectOption("doctor");
  await dlg.locator("button:has-text('Add')").last().click();
  await page.waitForSelector("text=د. سارة العمري", { timeout: 10000 });
  console.log("✓ doctor added");

  // 2. Add a service assigned to the doctor
  await page.goto(`${BASE}/c/${slug}/settings/services`);
  await page.waitForLoadState("networkidle");
  await page.click("text=Add service");
  await page.waitForSelector('div[role="dialog"]');
  const sdlg = page.locator('div[role="dialog"]');
  await sdlg.locator("input").nth(0).fill("Dental Cleaning");
  await sdlg.locator('input[dir="rtl"]').fill("تنظيف الأسنان");
  await sdlg.locator("button:has-text('د. سارة العمري')").click();
  await sdlg.locator("button:has-text('Save')").click();
  await page.waitForSelector("text=Dental Cleaning", { timeout: 10000 });
  console.log("✓ service added");

  // 3. Working hours page saves
  await page.goto(`${BASE}/c/${slug}/settings/hours`);
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("text=Working hours");
  console.log("✓ hours page renders");

  // 4. Calendar: create appointment with inline new patient
  await page.goto(`${BASE}/c/${slug}/calendar`);
  await page.waitForSelector("text=New appointment", { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  await page.click("text=New appointment");
  await page.waitForSelector("aside");
  const aside = page.locator("aside");
  await aside.locator("text=Create new patient").click();
  await aside.locator('input[placeholder="Full name"]').fill("ليلى حداد");
  await aside.locator('input[placeholder="0790744070"]').fill("0795556677");
  await aside.locator("select").nth(0).selectOption({ index: 1 }); // Dental Cleaning
  await aside.locator("select").nth(1).selectOption({ index: 1 }); // doctor
  await aside.locator('input[type="date"]').fill(CLINIC_TODAY);
  await aside.locator('input[type="time"]').fill("10:00");
  await aside.locator("button:has-text('Save')").click();
  await page.waitForSelector("text=Appointment booked", { timeout: 10000 });
  await page.waitForSelector("div[data-appt]:has-text('ليلى حداد')", { timeout: 10000 });
  console.log("✓ appointment created and rendered on grid");

  // 5. Conflict detection: same doctor, overlapping time
  await page.click("text=New appointment");
  await page.waitForSelector("aside");
  const aside2 = page.locator("aside");
  await aside2.locator("text=Create new patient").click();
  await aside2.locator('input[placeholder="Full name"]').fill("عمر يوسف");
  await aside2.locator('input[placeholder="0790744070"]').fill("0791119988");
  await aside2.locator("select").nth(1).selectOption({ index: 1 });
  await aside2.locator('input[type="date"]').fill(CLINIC_TODAY);
  await aside2.locator('input[type="time"]').fill("10:15");
  await aside2.locator("button:has-text('Save')").click();
  await page.waitForSelector("text=This time overlaps another appointment", { timeout: 10000 });
  console.log("✓ conflict detected and blocked");
  // move it to a free slot
  await aside2.locator('input[type="time"]').fill("12:00");
  await aside2.locator("button:has-text('Save')").click();
  await page.waitForSelector("text=Appointment booked", { timeout: 10000 });
  console.log("✓ non-conflicting time accepted");

  // 6. Status transition
  await page.click("div[data-appt]:has-text('ليلى حداد')");
  await page.waitForSelector("aside");
  await page.locator("aside button:has-text('Confirmed')").click();
  await page.waitForSelector("text=Appointment updated", { timeout: 10000 });
  console.log("✓ status → confirmed");

  // 7. Drag to reschedule: move ليلى حداد down ~90px (60 min)
  const block = page.locator("div[data-appt]:has-text('ليلى حداد')").first();
  const box = await block.boundingBox();
  if (!box) throw new Error("appointment block not found");
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8 + 45, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2, box.y + 8 + 90, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector("div[data-appt]:has-text('11:00 ليلى')", { timeout: 10000 });
  console.log("✓ drag reschedule moved appointment to 11:00");

  // 8. Realtime: second context sees new appointment without reload
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await login(p2, `owner-${slug}@test.local`, "password123");
  await p2.goto(`${BASE}/c/${slug}/calendar`);
  await p2.waitForSelector("div[data-appt]", { timeout: 15000 });
  // create in page 1
  await page.click("text=New appointment");
  const aside3 = page.locator("aside");
  await aside3.locator("text=Create new patient").click();
  await aside3.locator('input[placeholder="Full name"]').fill("زيد الرواشدة");
  await aside3.locator('input[placeholder="0790744070"]').fill("0777771234");
  await aside3.locator('input[type="date"]').fill(CLINIC_TODAY);
  await aside3.locator('input[type="time"]').fill("15:00");
  await aside3.locator("button:has-text('Save')").click();
  await page.waitForSelector("text=Appointment booked", { timeout: 10000 });
  await p2.waitForSelector("div[data-appt]:has-text('زيد الرواشدة')", { timeout: 15000 });
  console.log("✓ realtime: second session saw the new appointment live");
  await ctx2.close();

  // 9. Views switch
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await page.waitForSelector("text=ليلى حداد", { timeout: 8000 });
  await page.getByRole("button", { name: "Day", exact: true }).click();
  await page.waitForSelector("div[data-appt]:has-text('زيد الرواشدة')", { timeout: 8000 });
  console.log("✓ month and day views render (incl. unassigned-doctor column)");

  await page.screenshot({ path: "scripts/qa-shots/phase3-calendar.png" });
  await browser.close();
  const real = errors.filter((e) => !e.includes("hydra"));
  if (real.length) {
    console.error("page errors:", real.slice(0, 5));
    process.exit(1);
  }
  console.log("PHASE 3 QA PASSED");
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
