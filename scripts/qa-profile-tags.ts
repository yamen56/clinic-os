/**
 * The account page, and the tag catalogue.
 *
 * The tag half matters more than it looks. Assignments live in
 * `patients.tags` — a text array with a GIN index behind the patient filter —
 * while the catalogue is a separate table. Renaming or deleting a tag has to
 * reach both, or the filter stops matching patients who visibly still carry the
 * label, which reads as data loss.
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

  const slug = `qapt-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale) values ('QA PT','ملف',$1,'en') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,'Rima Owner','en') returning id`,
      [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, owner.id]
  );
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source)
       values ($1,'Sara Khatib','+962790333444','staff') returning id`,
      [clinic.id]
    )
  ).rows[0];
  console.log(`✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, `owner-${slug}@test.local`);

  /* ------------------------------------------- the profile, on a phone */
  await page.goto(`${BASE}/c/${slug}/profile`);
  await page.waitForLoadState("networkidle");
  check("the profile page opens", (await page.locator("text=Rima Owner").count()) > 0);
  check("it shows the account's email", (await page.locator(`text=owner-${slug}@test.local`).count()) > 0);
  check("and offers a way out", (await page.getByRole("button", { name: /sign out/i }).count()) > 0);
  check("and a photo control", (await page.getByRole("button", { name: /photo/i }).count()) > 0);

  // Reachable from the phone menu, which is the whole point of it existing.
  await page.goto(`${BASE}/c/${slug}`);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.getByRole("button", { name: /more|المزيد/i }).first().click();
  await page.waitForTimeout(500);
  const link = page.locator(`a[href="/c/${slug}/profile"]`);
  check("the phone menu links to it", (await link.count()) > 0);
  await page.screenshot({ path: "scripts/qa-shots/profile-phone.png" });

  /* --------------------------------------------------- the tag catalogue */
  const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  desk.on("pageerror", (e) => errors.push(e.message));
  await signIn(desk, `owner-${slug}@test.local`);
  /*
    Type a tag on the patient file first. This is how most tags are really
    born, and it is the path that would quietly leave the catalogue out of step
    with what the patient list is filtering by.
  */
  await desk.goto(`${BASE}/c/${slug}/patients/${patient.id}`);
  await desk.waitForLoadState("networkidle");
  await desk.getByRole("button", { name: /add tag/i }).first().click();
  await desk.locator('input[list^="tags-"]').fill("diabetic");
  await desk.keyboard.press("Enter");
  await desk.waitForTimeout(1500);
  const adopted = await db.query(
    `select 1 from clinic_tags where clinic_id = $1 and name = 'diabetic'`,
    [clinic.id]
  );
  check("a tag typed on a patient file joins the catalogue", adopted.rowCount === 1);

  await desk.goto(`${BASE}/c/${slug}/settings/tags`);
  await desk.waitForLoadState("networkidle");
  check(
    "and shows in settings",
    (await desk.locator("li", { hasText: "diabetic" }).count()) === 1
  );

  // Server Action forms carry hidden inputs, so scope to the dialog's own field.
  const dialogInput = () => desk.getByRole("dialog").locator("input:not([type=hidden])").first();

  await desk.getByRole("button", { name: /new tag/i }).first().click();
  await dialogInput().waitFor({ timeout: 15000 });
  await dialogInput().fill("insurance");
  await desk.getByRole("button", { name: /^save$/i }).last().click();
  await desk.waitForTimeout(1500);
  const created = await db.query(`select name, color from clinic_tags where clinic_id = $1 and name = 'insurance'`, [clinic.id]);
  check("a new tag is created", created.rowCount === 1, created.rows[0]?.color);

  // The same name twice must be refused — that is what the catalogue is for.
  await desk.getByRole("button", { name: /new tag/i }).first().click();
  await dialogInput().waitFor({ timeout: 15000 });
  await dialogInput().fill("insurance");
  await desk.getByRole("button", { name: /^save$/i }).last().click();
  await desk.waitForTimeout(1200);
  const dupes = await db.query(`select count(*)::int n from clinic_tags where clinic_id = $1 and name = 'insurance'`, [clinic.id]);
  check("the same tag cannot be created twice", dupes.rows[0].n === 1, `${dupes.rows[0].n}`);
  await desk.keyboard.press("Escape");

  /* ------------- renaming has to follow the tag onto the patients holding it */
  await desk.goto(`${BASE}/c/${slug}/settings/tags`);
  await desk.waitForLoadState("networkidle");
  await desk.locator("li", { hasText: "diabetic" }).getByRole("button", { name: /edit/i }).click();
  await dialogInput().waitFor({ timeout: 15000 });
  await dialogInput().fill("diabetes");
  await desk.getByRole("button", { name: /^save$/i }).last().click();
  await desk.waitForTimeout(1800);

  const afterRename = (await db.query(`select tags from patients where id = $1`, [patient.id])).rows[0];
  check(
    "renaming a tag follows it onto the patient",
    afterRename.tags.includes("diabetes") && !afterRename.tags.includes("diabetic"),
    JSON.stringify(afterRename.tags)
  );

  /* ------------------------------ deleting clears it from patients as well */
  await desk.locator("li", { hasText: "diabetes" }).getByRole("button", { name: /delete/i }).click();
  await desk.waitForTimeout(400);
  await desk.getByRole("button", { name: /^delete$/i }).last().click();
  await desk.waitForTimeout(1800);
  const afterDelete = (await db.query(`select tags from patients where id = $1`, [patient.id])).rows[0];
  check(
    "deleting a tag clears it from patients too",
    !afterDelete.tags.includes("diabetes"),
    JSON.stringify(afterDelete.tags)
  );
  const gone = await db.query(`select count(*)::int n from clinic_tags where clinic_id = $1 and name = 'diabetes'`, [clinic.id]);
  check("and removes it from the catalogue", gone.rows[0].n === 0);

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [owner.id]);
  await db.end();

  console.log(`\n  profile & tags: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
