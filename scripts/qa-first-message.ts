/**
 * Writing first.
 *
 * Every other outbound path in the platform answers a patient who has already
 * written in. This one does not: a file the clinic just created belongs to
 * someone who, by definition, has never messaged them. Two things had to be
 * true for that to work, and neither was:
 *
 *   - a conversation has to be creatable from the clinic's side, because the
 *     send route is keyed by conversation id and nothing else made one;
 *   - adding a patient has to emit `patient_created`, which the booking link did
 *     and the patients page did not.
 *
 * The import guard is tested too, and is the reason this file is careful about
 * *which* way a patient is created. Greeting one patient is a greeting; greeting
 * four hundred at once is what gets a WhatsApp number banned.
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

/** Polls until `fn` returns something truthy, or gives up. */
async function until<T>(fn: () => Promise<T | null>, ms = 20000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000 });
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qafm${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale) values ('QA First','أول',$1,'en') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,'Owner','en') returning id`,
      [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, owner.id]
  );

  /* ------------------------------------------------------ the recipe itself */
  const tpl = (
    await db.query(`select * from recipe_templates where key = 'welcome_new_patient'`)
  ).rows[0];
  check("the welcome recipe is seeded", !!tpl);
  check("and listens for a new patient", tpl?.trigger_type === "patient_created", tpl?.trigger_type);
  const steps = (tpl?.steps ?? []) as { step_type: string; config: { message?: string } }[];
  check("with a WhatsApp step", steps[0]?.step_type === "send_whatsapp");
  check(
    "whose message greets the patient by name",
    (steps[0]?.config?.message ?? "").includes("{{patient.first_name}}")
  );

  /*
    The fixture clinic is inserted directly, so it never went through clinic
    creation and has no recipes copied into it. Copy this one the way both
    clinic creation and migration 0023 do, which also proves the template's
    steps are well-formed enough to become real rows.
  */
  const auto = (
    await db.query(
      `insert into automations (clinic_id, name, trigger_type, trigger_config, active, recipe_key)
       values ($1, $2, $3, $4, true, $5) returning id`,
      [clinic.id, tpl.name, tpl.trigger_type, tpl.trigger_config, tpl.key]
    )
  ).rows[0];
  for (const [i, s] of steps.entries()) {
    await db.query(
      `insert into automation_steps (clinic_id, automation_id, sort, step_type, config)
       values ($1,$2,$3,$4,$5)`,
      [clinic.id, auto.id, i, s.step_type, JSON.stringify(s.config ?? {})]
    );
  }
  console.log(`✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, `owner-${slug}@test.local`);

  /* ------------------------------------ adding a patient sends the greeting */
  await page.goto(`${BASE}/c/${slug}/patients`);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.getByRole("button", { name: /new patient/i }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  /*
    Positional, not by label: `Field` puts an explicit htmlFor on the label that
    matches no id, so Playwright resolves neither the explicit nor the implicit
    association. The dialog has exactly two inputs, name then phone.
  */
  await dialog.locator("input").first().fill("Nadia Salem");
  await dialog.locator('input[dir="ltr"]').fill("0790555111");
  await dialog.getByRole("button", { name: /^create$/i }).click();
  await page.waitForURL(/\/patients\/[0-9a-f-]{36}/, { timeout: 30000 });
  const patientId = page.url().split("/patients/")[1].split("?")[0];

  const job = await until(async () => {
    const r = await db.query(
      `select payload from jobs where clinic_id = $1 and kind = 'trigger:patient_created'`,
      [clinic.id]
    );
    return r.rowCount ? r.rows[0] : null;
  }).catch(() => null);
  check("adding a patient raises the trigger", !!job);
  check("and names the patient it was for", job?.payload?.patientId === patientId);

  const greeting = await until(async () => {
    const r = await db.query(
      `select m.body, m.status, m.sender_kind from messages m
        join conversations cv on cv.id = m.conversation_id
       where cv.clinic_id = $1 and cv.patient_id = $2 and m.direction = 'out'`,
      [clinic.id, patientId]
    );
    return r.rowCount ? r.rows[0] : null;
  }).catch(() => null);
  check("a welcome message is queued for them", !!greeting, greeting?.status);
  check("addressed to them by first name", (greeting?.body ?? "").includes("Nadia"), greeting?.body?.slice(0, 40));
  check("and attributed to the automation", greeting?.sender_kind === "automation");

  /* ------------------------------ a bulk import must not greet everyone at once */
  const before = (
    await db.query(`select count(*)::int n from jobs where clinic_id = $1 and kind = 'trigger:patient_created'`, [clinic.id])
  ).rows[0].n;
  await db.query(
    `insert into patients (clinic_id, full_name, phone_e164, source)
     values ($1,'Imported One','+962790555222','import'), ($1,'Imported Two','+962790555333','import')`,
    [clinic.id]
  );
  await new Promise((r) => setTimeout(r, 1500));
  const after = (
    await db.query(`select count(*)::int n from jobs where clinic_id = $1 and kind = 'trigger:patient_created'`, [clinic.id])
  ).rows[0].n;
  check("an import greets nobody", after === before, `${before} → ${after}`);

  /* ------------------------------------- starting a thread with a fresh patient */
  const fresh = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source)
       values ($1,'Omar Fresh','+962790555444','staff') returning id`,
      [clinic.id]
    )
  ).rows[0];
  const convBefore = (
    await db.query(`select count(*)::int n from conversations where clinic_id = $1 and phone_e164 = '+962790555444'`, [clinic.id])
  ).rows[0].n;
  check("this patient has never written in", convBefore === 0);

  await page.goto(`${BASE}/c/${slug}/patients/${fresh.id}`);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  const msgBtn = page.getByRole("button", { name: /^message$/i }).first();
  check("the file offers to message them", (await msgBtn.count()) > 0);
  await msgBtn.click();
  await page.waitForURL(/\/conversations\?open=/, { timeout: 30000 });
  const openedId = new URL(page.url()).searchParams.get("open");

  const conv = (
    await db.query(
      `select id, patient_id from conversations where clinic_id = $1 and phone_e164 = '+962790555444'`,
      [clinic.id]
    )
  ).rows[0];
  check("clicking it opens a thread that did not exist", !!conv);
  check("the inbox was pointed at that thread", openedId === conv?.id, `${openedId}`);
  check("and the thread is tied to the patient file", conv?.patient_id === fresh.id);
  await page.screenshot({ path: "scripts/qa-shots/first-message.png" });

  // Twice must not make two threads — the phone number is the thread's identity.
  await page.goto(`${BASE}/c/${slug}/patients/${fresh.id}`);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.getByRole("button", { name: /^message$/i }).first().click();
  await page.waitForURL(/\/conversations\?open=/, { timeout: 30000 });
  const dupes = (
    await db.query(`select count(*)::int n from conversations where clinic_id = $1 and phone_e164 = '+962790555444'`, [clinic.id])
  ).rows[0].n;
  check("asking twice reuses the same thread", dupes === 1, `${dupes} thread(s)`);

  /* ------------------------------------------- a patient with no number at all */
  const noPhone = (
    await db.query(
      `insert into patients (clinic_id, full_name, source) values ($1,'No Number','staff') returning id`,
      [clinic.id]
    )
  ).rows[0];
  await page.goto(`${BASE}/c/${slug}/patients/${noPhone.id}`);
  await page.waitForLoadState("networkidle");
  check(
    "a patient with no number is not offered one",
    (await page.getByRole("button", { name: /^message$/i }).count()) === 0
  );

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();

  console.log(`\n  first message: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
