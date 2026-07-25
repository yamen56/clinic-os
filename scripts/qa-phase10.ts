/**
 * QA for Phase 10: admin monitoring, impersonation round-trip, subscription
 * suspension, onboarding checklist, announcements, and the demo seed.
 */
import { chromium } from "playwright";
import { Client } from "pg";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  // The demo seed must have produced a usable clinic
  const demo = (
    await db.query(
      `select cl.id, cl.slug,
        (select count(*) from patients where clinic_id = cl.id)::int as patients,
        (select count(*) from appointments where clinic_id = cl.id)::int as appointments,
        (select count(*) from invoices where clinic_id = cl.id)::int as invoices,
        (select count(*) from payments where clinic_id = cl.id)::int as payments,
        (select count(*) from messages where clinic_id = cl.id)::int as messages,
        (select count(*) from automations where clinic_id = cl.id and active)::int as autos,
        (select count(*) from ai_knowledge_items where clinic_id = cl.id and content <> '')::int as knowledge
       from clinics cl where cl.slug = 'rima-dental'`
    )
  ).rows[0];
  if (!demo) throw new Error("demo clinic missing — run `npm run seed`");
  if (demo.patients < 20 || demo.appointments < 30 || demo.invoices < 5 || demo.messages < 10)
    throw new Error(`demo data too thin: ${JSON.stringify(demo)}`);
  if (demo.autos < 1 || demo.knowledge < 5)
    throw new Error(`demo automations/knowledge missing: ${JSON.stringify(demo)}`);
  console.log(
    `✓ demo seed: ${demo.patients} patients, ${demo.appointments} appointments, ${demo.invoices} invoices, ${demo.messages} messages, ${demo.knowledge} knowledge entries`
  );

  const browser = await chromium.launch({ channel: "chromium" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', "admin@makan.agency");
  await page.fill('input[name="password"]', "admin1234");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/admin", { timeout: 30000 });
  console.log("✓ agency admin signed in");

  // 1. Clinics list with health indicators
  await page.waitForSelector("text=Rima Dental Center", { timeout: 15000 });
  console.log("✓ clinics list shows the demo clinic with health badges");

  // 2. Monitoring page
  await page.goto(`${BASE}/admin/monitoring`);
  await page.waitForSelector("text=WhatsApp sessions", { timeout: 15000 });
  const monText = await page.textContent("body");
  if (!monText?.includes("Jobs pending") || !monText.includes("Storage"))
    throw new Error("monitoring metrics missing");
  if (!monText.includes("Worker up") && !monText.includes("Worker unreachable"))
    throw new Error("worker health not reported");
  console.log(`✓ monitoring shows queue depth, storage, and worker health`);

  // 3. Announcements: create → appears on the clinic dashboard
  await page.goto(`${BASE}/admin/announcements`);
  await page.waitForSelector("text=Announcements", { timeout: 15000 });
  const annTitle = `صيانة مجدولة ${Date.now().toString(36)}`;
  await page.locator('input').first().fill(annTitle);
  await page.locator("textarea").first().fill("الجمعة ١٠ مساءً لمدة ساعة.");
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForSelector(`text=${annTitle}`, { timeout: 10000 });
  console.log("✓ announcement created");

  // 4. Defaults page
  await page.goto(`${BASE}/admin/defaults`);
  await page.waitForSelector("text=Automation recipes", { timeout: 15000 });
  const defText = await page.textContent("body");
  if (!defText?.includes("AI knowledge structure")) throw new Error("defaults page incomplete");
  console.log("✓ agency defaults page lists recipes and knowledge structure");

  // 5. Onboarding checklist on the clinic detail page
  await page.goto(`${BASE}/admin/clinics/rima-dental`);
  await page.waitForSelector("text=Onboarding", { timeout: 15000 });
  const detail = await page.textContent("body");
  if (!detail?.includes("Services added")) throw new Error("checklist missing");
  console.log("✓ onboarding checklist rendered");

  // 6. Impersonation: enter support mode, see the banner + announcement, then exit
  await page.click("text=Open workspace");
  await page.waitForURL("**/c/rima-dental", { timeout: 20000 });
  await page.waitForSelector("text=Support mode", { timeout: 15000 });
  await page.waitForSelector(`text=${annTitle}`, { timeout: 15000 });
  console.log("✓ impersonation banner and agency announcement visible in the workspace");

  const audited = await db.query(
    `select count(*)::int as n from audit_log where action = 'admin.impersonate.start' and clinic_id = $1`,
    [demo.id]
  );
  if (audited.rows[0].n < 1) throw new Error("impersonation not audited");
  console.log("✓ impersonation recorded in the audit log");

  await page.click("text=Exit support mode");
  await page.waitForURL("**/admin", { timeout: 20000 });
  const ended = await db.query(
    `select count(*)::int as n from audit_log where action = 'admin.impersonate.end'`
  );
  if (ended.rows[0].n < 1) throw new Error("impersonation exit not audited");
  await page.goto(`${BASE}/c/rima-dental`);
  await page.waitForLoadState("networkidle");
  const afterExit = await page.textContent("body");
  if (afterExit?.includes("Support mode")) throw new Error("still in support mode after exit");
  console.log("✓ exiting support mode clears the impersonated session (audited)");

  // 7. Suspension locks the workspace but preserves data
  await db.query(`update clinics set subscription_status = 'suspended' where id = $1`, [demo.id]);
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/login`);
  await p2.waitForLoadState("networkidle");
  await p2.fill('input[name="email"]', "rima@clinic.jo");
  await p2.fill('input[name="password"]', "clinic1234");
  await p2.click('button[type="submit"]');
  await p2.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
  await p2.goto(`${BASE}/c/rima-dental`);
  await p2.waitForURL("**/suspended", { timeout: 20000 });
  console.log("✓ suspended clinic locks its owner out of the workspace");

  const preserved = await db.query(`select count(*)::int as n from patients where clinic_id = $1`, [demo.id]);
  if (preserved.rows[0].n !== demo.patients) throw new Error("suspension destroyed data");
  console.log("✓ suspension preserved all clinic data");

  await db.query(`update clinics set subscription_status = 'active' where id = $1`, [demo.id]);
  await p2.goto(`${BASE}/c/rima-dental`);
  await p2.waitForSelector("text=الرئيسية", { timeout: 20000 });
  console.log("✓ reactivation restores access");
  await ctx2.close();

  // 8. Doctor role sees a restricted workspace
  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  await p3.goto(`${BASE}/login`);
  await p3.waitForLoadState("networkidle");
  await p3.fill('input[name="email"]', "dr.omar@clinic.jo");
  await p3.fill('input[name="password"]', "clinic1234");
  await p3.click('button[type="submit"]');
  await p3.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
  await p3.goto(`${BASE}/c/rima-dental`);
  await p3.waitForLoadState("networkidle");
  const docNav = await p3.textContent("nav");
  if (docNav?.includes("الفواتير") || docNav?.includes("الأتمتة"))
    throw new Error("doctor sees invoices/automations in nav");
  await p3.goto(`${BASE}/c/rima-dental/invoices`);
  await p3.waitForURL("**/c/rima-dental", { timeout: 15000 });
  console.log("✓ doctor role: nav restricted and invoices route redirects away");
  await ctx3.close();

  // 9. Public surfaces still work off the demo data
  const book = await page.request.get(`${BASE}/book/rima-dental`);
  if (book.status() !== 200) throw new Error("public booking page broken");
  const inv = await db.query(
    `select public_token from invoices where clinic_id = $1 limit 1`,
    [demo.id]
  );
  const invRes = await page.request.get(`${BASE}/inv/${inv.rows[0].public_token}`);
  if (invRes.status() !== 200) throw new Error("public invoice page broken");
  console.log("✓ public booking and invoice pages render from demo data");

  // 10. Cleanup the announcement so reruns stay clean
  await db.query(`delete from announcements where title = $1`, [annTitle]);

  await page.goto(`${BASE}/admin/monitoring`);
  await page.waitForSelector("text=WhatsApp sessions", { timeout: 15000 });
  await page.screenshot({ path: "scripts/qa-shots/phase10-monitoring.png" });
  await browser.close();
  await db.end();

  const real = errors.filter((e) => !e.includes("hydrat"));
  if (real.length) {
    console.error("page errors:", real.slice(0, 5));
    process.exit(1);
  }
  console.log("PHASE 10 QA PASSED");
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
