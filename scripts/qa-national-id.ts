/**
 * The national number on a patient's file — what an insurer, and Hakeem Claim,
 * matches a claim on.
 *
 * Through the real autosave route, as the profile sends it, because the rules
 * live there: a typo is refused rather than discovered as a rejected claim, a
 * number already on another file names that file, and a passport is kept as
 * typed. Then the search and the profile, read the way a person reads them.
 *
 *   npx tsx scripts/qa-national-id.ts      (dev server on :3000)
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium } from "playwright";
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

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qanid${Date.now().toString(36)}`;
  const email = `owner-${slug}@test.local`;
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency)
       values ('QA NID', 'رقم وطني', $1, 'ar', 'Asia/Amman', 'JOD') returning id`,
      [slug]
    )
  ).rows[0].id as string;
  await db.query(`select seed_esign_defaults($1)`, [clinicId]);
  const userId = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1, $2, 'QA Owner', 'ar') returning id`,
      [email, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0].id as string;
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'other', true, '{"level":"full"}')`,
    [clinicId, userId]
  );
  const mkPatient = async (name: string, phone: string) =>
    (
      await db.query(
        `insert into patients (clinic_id, full_name, phone_e164, source) values ($1, $2, $3, 'staff') returning id`,
        [clinicId, name, phone]
      )
    ).rows[0].id as string;
  const first = await mkPatient("سارة عبدالله", "+962790001111");
  const second = await mkPatient("أحمد يوسف", "+962790002222");
  console.log(`✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });

    const save = async (patientId: string, value: string) => {
      const res = await page.request.post(`${BASE}/api/c/${slug}/patients/${patientId}`, {
        data: { patch: { custom_fields: { national_id: value } } },
      });
      return (await res.json()) as {
        patient?: { custom_fields: Record<string, string>; national_id: string | null };
        rejected?: Record<string, { error: string; other?: { full_name?: string } }>;
      };
    };

    console.log("\n[typing it in]");
    const typed = await save(first, "٩٨٨ ١٢٣-٤٥٦٧");
    check(
      "Arabic digits with spaces and a dash are stored as the ten digits",
      typed.patient?.custom_fields.national_id === "9881234567" && typed.patient?.national_id === "9881234567",
      `${typed.patient?.custom_fields.national_id}/${typed.patient?.national_id}`
    );

    const short = await save(second, "98812345");
    check("nine digits is refused", short.rejected?.custom_fields?.error === "invalid_national_id",
      JSON.stringify(short.rejected));
    check("and nothing was written", !short.patient?.custom_fields.national_id);

    const dup = await save(second, "9881234567");
    check("a number already on another file is refused", dup.rejected?.custom_fields?.error === "national_id_taken",
      JSON.stringify(dup.rejected));
    check("naming that file", dup.rejected?.custom_fields?.other?.full_name === "سارة عبدالله");

    const passport = await save(second, "N1234567");
    check(
      "a passport number is kept as typed, and is not a national number",
      passport.patient?.custom_fields.national_id === "N1234567" && passport.patient?.national_id === null,
      `${passport.patient?.custom_fields.national_id}/${passport.patient?.national_id}`
    );

    const audit = await db.query(
      `select count(*)::int n from audit_log where entity_id = $1 and action = 'patient.update'`,
      [first]
    );
    check("the change is in the audit log", audit.rows[0].n >= 1, `${audit.rows[0].n}`);

    console.log("\n[finding it again]");
    await page.goto(`${BASE}/c/${slug}/patients?q=${encodeURIComponent("9881234567")}`);
    await page.waitForLoadState("networkidle");
    const list = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
    check("searching the number finds the patient", list.includes("سارة عبدالله"));
    check("and only that patient", !list.includes("أحمد يوسف"));

    await page.goto(`${BASE}/c/${slug}/patients/${first}`);
    await page.waitForLoadState("networkidle");
    const inputs = await page.locator("main input").evaluateAll((els) =>
      els.map((e) => (e as HTMLInputElement).value)
    );
    check("the profile shows it", inputs.includes("9881234567"), "");
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinicId]);
    await db.query(`delete from users where id = $1`, [userId]);
    await db.end();
  }

  console.log(`\n${failures.length ? "✗" : "✓"} ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
