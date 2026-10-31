/**
 * Setup, reminders and the desk's to-do (Release 3).
 *
 *  - The owner's dashboard says what is left to set up, from real data, each
 *    item a link; a doctor is not shown it.
 *  - A new clinic gets the confirmation (reception's bookings only) and the
 *    day-before reminder; installing again adds nothing, and nothing goes in
 *    beside a reminder the clinic built itself or switched off.
 *  - The agency sees the messages before switching them on for a live clinic.
 *  - Approving an online booking tells the patient.
 *  - What automations ask the desk to do is on the dashboard, and Done ticks it.
 *  - Settings are grouped, and point at the automatic messages.
 */
import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { installRecipes } from "../src/lib/clinic-provision";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const TZ = "Asia/Amman";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function until(fn: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 90_000 });
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const tag = Date.now().toString(36);
  const clinicIds: string[] = [];
  const userIds: string[] = [];
  const mkClinic = async (slug: string) => {
    const id = (await db.query(`insert into clinics (name, name_ar, slug, timezone) values ('QA Setup', 'عيادة التجهيز', $1, $2) returning id`, [slug, TZ])).rows[0]
      .id as string;
    clinicIds.push(id);
    return id;
  };
  const mkUser = async (email: string, name: string, admin = false) => {
    const id = (
      await db.query(
        `insert into users (email, password_hash, full_name, locale, is_super_admin, admin_permissions) values ($1, $2, $3, 'en', $4, $5) returning id`,
        [email, bcrypt.hashSync("password123", 10), name, admin, admin ? '{"level":"full"}' : "{}"]
      )
    ).rows[0].id as string;
    userIds.push(id);
    return id;
  };

  const slug = `qasetup${tag}`;
  const clinic = await mkClinic(slug);
  const owner = await mkUser(`owner-${slug}@test.local`, "QA Owner");
  await db.query(`insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, 'receptionist', true, '{"level":"full"}')`, [clinic, owner]);
  const docUser = await mkUser(`doc-${slug}@test.local`, "Dr Lama");
  const doc = (
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, permissions) values ($1, $2, 'doctor', '{"level":"custom","caps":{"dashboard":true,"calendar":true,"patients":true}}') returning id`,
      [clinic, docUser]
    )
  ).rows[0].id as string;
  await mkUser(`admin-${slug}@test.local`, "QA Agency", true);

  const browser = await chromium.launch();
  const errors: string[] = [];
  const watch = (p: Page) => p.on("pageerror", (e) => errors.push(e.message));
  const base = `${BASE}/c/${slug}`;

  try {
    /* ============================================================ the checklist */
    console.log("\n[what is left to set up]");
    const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(desk);
    await signIn(desk, `owner-${slug}@test.local`);
    await desk.goto(base);
    await desk.waitForSelector("[data-setup-card]", { timeout: 90_000 });
    const state = async () =>
      Object.fromEntries(
        await desk.locator("[data-setup-item]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-setup-item"), e.getAttribute("data-done")]))
      ) as Record<string, string>;
    const before = await state();
    // It has a doctor already (the fixture), and nothing else.
    check(
      "a new clinic has the rest still to do",
      Object.keys(before).length === 7 && before.team === "1" && ["details", "services", "whatsapp", "booking", "reminders", "patients"].every((k) => before[k] === "0"),
      JSON.stringify(before)
    );
    check("each item opens the page that does it", (await desk.locator('[data-setup-item="services"]').getAttribute("href")) === `/c/${slug}/settings/services`);
    await db.query(`insert into services (clinic_id, name, duration_min, price) values ($1, 'Consultation', 30, 25)`, [clinic]);
    await desk.reload();
    await desk.waitForSelector("[data-setup-card]", { timeout: 60_000 });
    const after = await state();
    check("it ticks itself from what the clinic did", after.services === "1", JSON.stringify(after));

    const docPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(docPage);
    await signIn(docPage, `doc-${slug}@test.local`);
    await docPage.goto(base);
    await docPage.waitForSelector("[data-today-list], main", { timeout: 60_000 });
    check("a doctor is not shown it", (await docPage.locator("[data-setup-card]").count()) === 0);

    /* ============================================================ the agency */
    console.log("\n[the agency switches reminders on for a live clinic]");
    const agency = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(agency);
    await signIn(agency, `admin-${slug}@test.local`);
    await agency.goto(`${BASE}/admin/clinics/${slug}`);
    await agency.waitForSelector("[data-default-flows]", { timeout: 90_000 });
    check("the reminder waits to be switched on", (await agency.locator('[data-pending-flow="reminder_24h"]').count()) === 1);
    check("with the message patients will read", (await agency.locator('[data-pending-flow="reminder_24h"]').innerText()).includes("للتأكيد أرسل 1"));
    check("the admin checklist says reminders are off", (await agency.locator('[data-admin-setup="reminders"]').getAttribute("data-done")) === "0");
    await agency.click("[data-apply-default-flows]");
    await agency.getByRole("button", { name: "Switch on", exact: true }).last().click();
    const flows = await until(async () => (await db.query(`select count(*)::int as n from automations where clinic_id = $1 and recipe_key = 'reminder_24h' and active`, [clinic])).rows[0].n === 1);
    check("switching them on installs the reminder", flows);
    const confirm = (await db.query(`select trigger_config from automations where clinic_id = $1 and recipe_key = 'confirm_on_booking'`, [clinic])).rows[0];
    check("and the confirmation, for reception's bookings only", JSON.stringify(confirm?.trigger_config?.sources) === '["staff"]', JSON.stringify(confirm));
    check("the card then says they are all on", await until(async () => (await agency.locator('[data-pending-flow]').count()) === 0, 30_000));
    await desk.goto(base);
    await desk.waitForSelector("[data-setup-card], [data-today-list]", { timeout: 60_000 });
    check("and the owner's checklist ticks reminders", (await desk.locator('[data-setup-item="reminders"]').getAttribute("data-done")) === "1");

    console.log("\n[installing never doubles a reminder]");
    const twice = await installRecipes(db as never, clinic, "general");
    check("installing again adds nothing", twice === 0, String(twice));
    const own = await mkClinic(`qaown${tag}`);
    await db.query(
      `insert into automations (clinic_id, name, trigger_type, trigger_config, active) values ($1, 'Our reminder', 'before_appointment', '{"hours": 24}', true)`,
      [own]
    );
    await installRecipes(db as never, own, "general");
    const ownKeys = (await db.query(`select recipe_key from automations where clinic_id = $1 and recipe_key is not null`, [own])).rows.map((r) => r.recipe_key);
    check("beside a reminder the clinic built itself, none is added", !ownKeys.includes("reminder_24h") && ownKeys.includes("confirm_on_booking"), ownKeys.join(","));
    await db.query(`update automations set active = false where clinic_id = $1 and recipe_key = 'reminder_24h'`, [clinic]);
    await installRecipes(db as never, clinic, "general");
    const offAgain = (await db.query(`select count(*)::int as n, bool_or(active) as on from automations where clinic_id = $1 and recipe_key = 'reminder_24h'`, [clinic])).rows[0];
    check("one the clinic switched off stays off", offAgain.n === 1 && offAgain.on === false, JSON.stringify(offAgain));
    const tpl = (await db.query(`select steps from recipe_templates where key = 'reminder_24h'`)).rows[0];
    check("a reply of 2 leaves the desk a task to call back", JSON.stringify(tpl.steps).includes("create_task"));

    /* ============================================================ approval */
    console.log("\n[approving an online booking tells the patient]");
    await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1, 'connected') on conflict (clinic_id) do update set status = 'connected'`, [clinic]);
    const patient = (await db.query(`insert into patients (clinic_id, full_name, phone_e164, source) values ($1, 'Hiba Saleh', '+962790771301', 'booking_link') returning id`, [clinic]))
      .rows[0].id as string;
    const pending = (
      await db.query(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status, source)
         values ($1, $2, $3, now() + interval '2 days', now() + interval '2 days 30 minutes', 'pending_approval', 'booking_link') returning id`,
        [clinic, patient, doc]
      )
    ).rows[0].id as string;
    await desk.goto(`${base}/calendar?open=${pending}`);
    await desk.locator("aside", { hasText: "Hiba Saleh" }).waitFor({ timeout: 60_000 });
    await desk.locator("aside").getByRole("button", { name: "Confirmed", exact: true }).click();
    const sent = await until(async () =>
      (await db.query(`select count(*)::int as n from messages where clinic_id = $1 and sender_kind = 'system' and body like '%تم تأكيد موعدك%'`, [clinic])).rows[0].n === 1
    );
    check("the patient is sent their confirmation", sent);

    /* ============================================================ to do */
    console.log("\n[the desk's to do]");
    const task = (
      await db.query(`insert into tasks (clinic_id, title, body, patient_id, created_by) values ($1, 'Call Hiba to reschedule', 'Tomorrow 10:00', $2, 'automation') returning id`, [
        clinic,
        patient,
      ])
    ).rows[0].id as string;
    await desk.goto(base);
    await desk.waitForSelector(`[data-todo="${task}"]`, { timeout: 60_000 });
    check("what an automation asked for is on the dashboard", (await desk.locator(`[data-todo="${task}"]`).innerText()).includes("Hiba Saleh"));
    await desk.click(`[data-todo="${task}"] [data-todo-done]`);
    check("Done ticks it off", await until(async () => (await db.query(`select done from tasks where id = $1`, [task])).rows[0].done === true));
    check("and it leaves the list", await until(async () => (await desk.locator(`[data-todo="${task}"]`).count()) === 0, 10_000));

    /* ============================================================ settings */
    console.log("\n[settings in groups]");
    await desk.goto(`${base}/settings`);
    await desk.waitForSelector('[data-settings-group="messaging"]', { timeout: 60_000 });
    const messaging = await desk.locator('[data-settings-group="messaging"]').innerText();
    check("messaging gathers WhatsApp, booking and the automatic messages", messaging.includes("WhatsApp") && messaging.includes("Automatic messages"), messaging);

    check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await browser.close();
  } finally {
    for (const id of clinicIds) await db.query(`delete from clinics where id = $1`, [id]);
    await db.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    await db.end();
  }

  console.log(`\n  setup and reminders: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
