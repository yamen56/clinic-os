/**
 * Adding somebody back after you removed them.
 *
 * "Delete" is a deactivation in both places — a staff member keeps their user
 * row, a patient keeps their file — which is right, because the appointments,
 * invoices and notes hanging off them must not vanish. But it means adding the
 * same person again hits a record that is already there, and what happens then
 * is the whole of this suite.
 *
 * The rule being fixed: re-adding somebody who never finished joining should
 * behave like adding them for the first time. They get the invitation again,
 * and the details typed on the form are the ones that stick. What must NOT
 * happen is a real account, belonging to a person who has already chosen their
 * own name, being quietly renamed by whoever last typed their email.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { findOrCreatePatient } from "../src/lib/patients";
import type { PoolClient } from "pg";

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

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const stamp = Date.now().toString(36);
  const slug = `qareadd${stamp}`;
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, invoice_prefix)
       values ('QA Readd','إعادة',$1,'ar','Asia/Amman','JOD','QRA') returning id`,
      [slug]
    )
  ).rows[0].id as string;

  const ownerId = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,'QA Owner','ar') returning id`,
      [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0].id as string;
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinicId, ownerId]
  );

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

  const OLD = `قديم ${stamp}`;
  const NEW = `جديد ${stamp}`;
  const staffEmail = `readd-${slug}@test.local`;

  /** Fills the add-staff form and submits it. */
  const addStaff = async (name: string, email: string) => {
    await page.goto(`${BASE}/c/${slug}/settings/staff`);
    await page.waitForLoadState("networkidle");
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await page.getByRole("button", { name: /إضافة|Add/ }).first().click();
    await page.waitForTimeout(300);
    const dialog = page.locator("form, [role=dialog]").last();
    await dialog.locator("input").first().fill(name);
    await dialog.locator('input[type="email"]').fill(email);
    await page.getByRole("button", { name: /^(إرسال|حفظ|إضافة|Send|Save|Add)/ }).last().click();
    await page.waitForTimeout(1200);
  };

  const invites = async () =>
    Number(
      (
        await db.query(
          `select count(*)::int n from auth_tokens t
             join users u on u.id = t.user_id
            where u.email = $1 and t.purpose = 'invite'`,
          [staffEmail]
        )
      ).rows[0].n
    );
  const staffName = async () =>
    (await db.query(`select full_name from users where email = $1`, [staffEmail])).rows[0]
      ?.full_name as string | undefined;

  try {
    await signIn(page, `owner-${slug}@test.local`);

    /* ============================================== staff, the first time */
    console.log("\n[inviting somebody who has never joined]");
    await addStaff(OLD, staffEmail);
    check("the account is created", (await staffName()) === OLD, String(await staffName()));
    const firstInvites = await invites();
    check("and invited", firstInvites >= 1, `${firstInvites} invite token(s)`);

    /* ============================================== removed, then added back */
    console.log("\n[removing them, then adding them back with new details]");
    await db.query(
      `update clinic_members set active = false
        where clinic_id = $1 and user_id = (select id from users where email = $2)`,
      [clinicId, staffEmail]
    );

    await addStaff(NEW, staffEmail);

    check(
      "the name on the account is the one just typed",
      (await staffName()) === NEW,
      `${await staffName()} (wanted ${NEW})`
    );
    check(
      "they are invited again, not left without a link",
      (await invites()) > firstInvites,
      `${await invites()} vs ${firstInvites}`
    );
    check(
      "and their membership is live again",
      (
        await db.query(
          `select active from clinic_members
            where clinic_id = $1 and user_id = (select id from users where email = $2)`,
          [clinicId, staffEmail]
        )
      ).rows[0]?.active === true,
      ""
    );

    /* ============================================== a real account is not renamed */
    console.log("\n[somebody who already finished joining]");
    const realEmail = `real-${slug}@test.local`;
    const REAL_NAME = "اسمه الحقيقي";
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'ar')`,
      [realEmail, bcrypt.hashSync("password123", 10), REAL_NAME]
    );
    await addStaff("اسم شخص آخر", realEmail);
    check(
      "their own name survives being added by somebody else",
      (await db.query(`select full_name from users where email = $1`, [realEmail])).rows[0]
        .full_name === REAL_NAME,
      ""
    );
    check(
      "and they are not sent an invitation they do not need",
      Number(
        (
          await db.query(
            `select count(*)::int n from auth_tokens t join users u on u.id = t.user_id
              where u.email = $1 and t.purpose = 'invite'`,
            [realEmail]
          )
        ).rows[0].n
      ) === 0,
      ""
    );

    /* ============================================== patients */
    console.log("\n[a patient file that was archived]");
    const c = db as unknown as PoolClient;
    const phone = "+962791234567";

    const first = await findOrCreatePatient(c, clinicId, {
      phone,
      fullName: OLD,
      source: "staff",
    });
    check("the file is created", first.created, "");

    await db.query(`update patients set status = 'archived' where id = $1`, [first.id]);

    const again = await findOrCreatePatient(c, clinicId, {
      phone,
      fullName: NEW,
      source: "staff",
      restoreArchived: true,
    });
    check("adding the same number reaches the same file", again.id === first.id, "");
    check(
      "the file comes back out of the archive",
      (await db.query(`select status from patients where id = $1`, [first.id])).rows[0].status ===
        "active",
      (await db.query(`select status from patients where id = $1`, [first.id])).rows[0].status
    );
    check(
      "and takes the name just typed",
      (await db.query(`select full_name from patients where id = $1`, [first.id])).rows[0]
        .full_name === NEW,
      (await db.query(`select full_name from patients where id = $1`, [first.id])).rows[0].full_name
    );

    /* An active patient is somebody else's record, not a blank to overwrite. */
    console.log("\n[a patient who was never archived]");
    const live = await findOrCreatePatient(c, clinicId, {
      phone: "+962795555555",
      fullName: "مريض نشط",
      source: "staff",
    });
    await findOrCreatePatient(c, clinicId, {
      phone: "+962795555555",
      fullName: "اسم مختلف تمامًا",
      source: "staff",
      restoreArchived: true,
    });
    check(
      "an existing active file is not renamed under them",
      (await db.query(`select full_name from patients where id = $1`, [live.id])).rows[0]
        .full_name === "مريض نشط",
      ""
    );

    /* WhatsApp must never resurrect a file the clinic deliberately archived. */
    const archivedByStaff = await findOrCreatePatient(c, clinicId, {
      phone: "+962796666666",
      fullName: "مؤرشف",
      source: "staff",
    });
    await db.query(`update patients set status = 'archived' where id = $1`, [archivedByStaff.id]);
    await findOrCreatePatient(c, clinicId, {
      phone: "+962796666666",
      whatsappName: "whatsapp name",
      source: "whatsapp",
    });
    check(
      "an inbound message does not un-archive a file",
      (await db.query(`select status from patients where id = $1`, [archivedByStaff.id])).rows[0]
        .status === "archived",
      ""
    );
  } finally {
    await browser.close();
  }

  await db.query(`delete from clinics where id = $1`, [clinicId]);
  await db.query(`delete from users where email like $1`, [`%-${slug}@test.local`]);
  await db.end();

  console.log(`\n${failures.length ? "✗" : "✓"} ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
