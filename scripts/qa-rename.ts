/**
 * A name can be changed — and only by someone entitled to change it.
 *
 * `users.full_name` was written once, by whoever sent the invitation, and then
 * nothing in the product could touch it. A typo in a colleague's name, or an
 * owner recorded under a placeholder, was permanent — on the calendar, on
 * consultation notes and on signed documents.
 *
 * The awkward part is that the name is not the clinic's. `users` is shared: the
 * same person can work at two clinics here and both read the same row. So this
 * suite has two halves. That renaming works at all, and that one clinic cannot
 * rename another clinic's doctor — asserted at the screen, at the server's own
 * guard, and at the database policy underneath both.
 *
 * Needs the dev stack: npx tsx scripts/dev-all.ts (and qa-warm first).
 *
 *   npx tsx scripts/qa-rename.ts
 */
import { chromium, type Page } from "playwright";
import { Client, Pool, type PoolClient } from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:3000";
const PG_PORT = Number(process.env.PG_PORT || 5544);
const SUPER_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/clinicos`;
const APP_URL = `postgres://clinicos_app:clinicos_app@127.0.0.1:${PG_PORT}/clinicos`;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The RLS context the app runs its clinic-scoped queries in. */
async function asClinic<T>(
  pool: Pool,
  ctx: { userId: string; clinicId: string; role: string },
  fn: (c: PoolClient) => Promise<T>
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(
      `select set_config('app.user_id', $1, true), set_config('app.clinic_id', $2, true),
              set_config('app.role', $3, true), set_config('app.is_admin', 'false', true)`,
      [ctx.userId, ctx.clinicId, ctx.role]
    );
    return await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
}

/** Opens one member's editor from the staff list, found by their email. */
async function openMember(page: Page, email: string) {
  await page.locator(`li:has-text("${email}") button[aria-label="Edit"]`).click();
  await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
}

async function nameInDb(su: Client, userId: string): Promise<string> {
  return (await su.query(`select full_name from users where id = $1`, [userId])).rows[0].full_name;
}

async function main() {
  const su = new Client({ connectionString: SUPER_URL });
  await su.connect();
  const app = new Pool({ connectionString: APP_URL, max: 3 });

  const tag = Date.now().toString(36);
  const slugA = `qarn-a${tag}`;
  const slugB = `qarn-b${tag}`;

  const mkClinic = async (name: string, slug: string) => {
    const id = (
      await su.query(`insert into clinics (name, name_ar, slug) values ($1, $1, $2) returning id`, [
        name,
        slug,
      ])
    ).rows[0].id as string;
    await su.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [id]);
    return id;
  };
  const mkUser = async (label: string, name: string) =>
    (
      await su.query(
        `insert into users (email, password_hash, full_name, locale)
         values ($1, $2, $3, 'en') returning id`,
        [`${label}-${tag}@test.local`, bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;
  const mkMember = async (clinicId: string, userId: string, role: string, owner = false) =>
    (
      await su.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
         values ($1, $2, $3, $4, '{"level":"full"}') returning id`,
        [clinicId, userId, role, owner]
      )
    ).rows[0].id as string;

  const clinicA = await mkClinic("QA Rename", slugA);
  const clinicB = await mkClinic("QA Rename Two", slugB);

  const ownerEmail = `owner-${tag}@test.local`;
  const soloEmail = `solo-${tag}@test.local`;
  const bothEmail = `both-${tag}@test.local`;

  const ownerId = await mkUser("owner", "Ownr Plcehldr");
  const soloId = await mkUser("solo", "Mispelt Nam");
  const bothId = await mkUser("both", "Shared Person");

  await mkMember(clinicA, ownerId, "receptionist", true);
  const soloMember = await mkMember(clinicA, soloId, "doctor");
  await mkMember(clinicA, bothId, "doctor");
  // The same account, working at a second clinic. This is the row the guard exists for.
  await mkMember(clinicB, bothId, "doctor");

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    console.log("\n[the database policy underneath all of it]");
    /*
      `users_access` allows a row to write only itself. Everything above it is
      defence in depth; this is the line that would still hold if the action's
      guard were deleted tomorrow.
    */
    let refused = false;
    try {
      await asClinic(app, { userId: ownerId, clinicId: clinicA, role: "receptionist" }, (c) =>
        c.query(`update users set full_name = 'Stolen' where id = $1`, [soloId])
      );
    } catch {
      refused = true;
    }
    check("a clinic connection cannot rename a colleague directly", refused);

    const self = await asClinic(
      app,
      { userId: ownerId, clinicId: clinicA, role: "receptionist" },
      async (c) =>
        (await c.query(`update users set full_name = 'Self' where id = $1`, [ownerId])).rowCount
    );
    check("but it can rename itself", self === 1, `${self} row(s)`);

    console.log("\n[the shared-account lookup has to escape RLS]");
    /*
      The staff screen asks "does this person work anywhere else?" — and every
      row that could answer yes belongs to another clinic, which RLS hides. Asked
      from inside the tenant the answer is always no, silently, which would make
      the screen offer an edit the server then refuses. So the page asks it on a
      system connection, and both halves are asserted here.
    */
    const blind = await asClinic(
      app,
      { userId: ownerId, clinicId: clinicA, role: "receptionist" },
      async (c) =>
        (
          await c.query(
            `select 1 from clinic_members where user_id = $1 and clinic_id <> $2 limit 1`,
            [bothId, clinicA]
          )
        ).rowCount
    );
    check("inside the tenant it cannot see the other membership", blind === 0, `${blind}`);
    const seen = (
      await su.query(`select 1 from clinic_members where user_id = $1 and clinic_id <> $2 limit 1`, [
        bothId,
        clinicA,
      ])
    ).rowCount;
    check("on a system connection it can", seen === 1, `${seen}`);

    console.log("\n[a person renaming themselves]");
    await signIn(page, ownerEmail);
    await page.goto(`${BASE}/c/${slugA}/profile`);
    await page.waitForLoadState("networkidle");
    const before = await page.locator("main").innerText();
    check("the account page shows the name it was created with", before.includes("Ownr Plcehldr"));

    await page.click('button[aria-label="Change your name"]');
    await page.getByLabel("Full name").fill("Yamen Batarseh");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForSelector('button[aria-label="Change your name"]', { timeout: 15000 });

    check(
      "the new name is what the database holds",
      (await nameInDb(su, ownerId)) === "Yamen Batarseh",
      await nameInDb(su, ownerId)
    );
    await page.reload();
    await page.waitForLoadState("networkidle");
    const after = await page.locator("main").innerText();
    check(
      "and it is what the page shows on the way back",
      after.includes("Yamen Batarseh") && !after.includes("Ownr Plcehldr")
    );

    console.log("\n[an owner fixing a colleague's name]");
    await page.goto(`${BASE}/c/${slugA}/settings/staff`);
    await page.waitForLoadState("networkidle");
    await openMember(page, soloEmail);
    const soloField = page.locator('[role="dialog"]').getByLabel("Full name");
    check("the field is open for an account only this clinic knows", await soloField.isEnabled());
    await soloField.fill("Sami Al-Masri");
    await page.locator('[role="dialog"]').getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 15000 });
    check(
      "the correction reaches the database",
      (await nameInDb(su, soloId)) === "Sami Al-Masri",
      await nameInDb(su, soloId)
    );
    /*
      The list behind the modal is server-rendered and redrawn by
      `router.refresh()`, which lands a moment after the dialog closes — so this
      waits for the row rather than reading it on the same tick.
    */
    await page
      .waitForFunction(
        () => !(document.querySelector("main")?.innerText ?? "").includes("Mispelt Nam"),
        null,
        { timeout: 15000 }
      )
      .catch(() => {});
    const list = await page.locator("main").innerText();
    check(
      "and the list stops showing the misspelling",
      list.includes("Sami Al-Masri") && !list.includes("Mispelt Nam")
    );

    /*
      The membership was saved in the same click. Renaming must not have become
      an alternative to the fields that were already there.
    */
    const stillDoctor = (
      await su.query(`select role from clinic_members where id = $1`, [soloMember])
    ).rows[0].role;
    check("the rest of the member's row saved with it", stillDoctor === "doctor", stillDoctor);

    console.log("\n[the screen says yes and the server says no]");
    /*
      The guard in the action, reached the only way a real client reaches it:
      the screen was drawn while this person worked here alone, they joined a
      second clinic a moment later, and the save arrives against a page that no
      longer knows the truth. A disabled input is a courtesy; this is the part
      that actually decides.
    */
    await su.query(
      `insert into clinic_members (clinic_id, user_id, role, permissions)
       values ($1, $2, 'doctor', '{"level":"full"}')`,
      [clinicB, soloId]
    );
    await openMember(page, soloEmail);
    await page.locator('[role="dialog"]').getByLabel("Full name").fill("Renamed Behind Their Back");
    await page.locator('[role="dialog"]').getByRole("button", { name: "Save", exact: true }).click();
    await page
      .waitForFunction(() => document.body.innerText.includes("also works at another clinic here"), null, {
        timeout: 15000,
      })
      .catch(() => {});
    check(
      "a stale page is refused",
      (await nameInDb(su, soloId)) === "Sami Al-Masri",
      await nameInDb(su, soloId)
    );
    check(
      "and told why, rather than shown a generic error",
      (await page.locator("body").innerText()).includes("also works at another clinic here")
    );
    check("the editor stays open", await page.locator('[role="dialog"]').isVisible());
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 10000 });

    console.log("\n[an account that belongs to two clinics]");
    await openMember(page, bothEmail);
    const bothField = page.locator('[role="dialog"]').getByLabel("Full name");
    check("the field is locked", await bothField.isDisabled());
    const dialog = await page.locator('[role="dialog"]').innerText();
    check(
      "and says whose name it is to change",
      dialog.includes("also works at another clinic here")
    );

    // Saving the rest of the form must still work, and must leave the name alone.
    await page.locator('[role="dialog"]').getByLabel("Specialty").fill("Orthodontics");
    await page.locator('[role="dialog"]').getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 15000 });
    check(
      "saving the rest of their row leaves the name untouched",
      (await nameInDb(su, bothId)) === "Shared Person",
      await nameInDb(su, bothId)
    );

    console.log("\n[the audit trail]");
    /*
      A note signed last week carries one name and the account now carries
      another. The only thing that reconciles them is a row saying when it
      changed and what it changed from.
    */
    const renames = (
      await su.query(
        `select action, detail from audit_log
          where clinic_id = $1 and action in ('user.rename', 'staff.update')
          order by created_at`,
        [clinicA]
      )
    ).rows as { action: string; detail: Record<string, unknown> }[];
    check(
      "the self-rename recorded both names",
      renames.some(
        (r) =>
          r.action === "user.rename" &&
          JSON.stringify(r.detail).includes("Ownr Plcehldr") &&
          JSON.stringify(r.detail).includes("Yamen Batarseh")
      )
    );
    check(
      "so did the one the owner made",
      renames.some(
        (r) =>
          r.action === "staff.update" &&
          JSON.stringify(r.detail).includes("Mispelt Nam") &&
          JSON.stringify(r.detail).includes("Sami Al-Masri")
      )
    );
  } finally {
    await browser.close();
    await su.query(`delete from clinics where slug in ($1, $2)`, [slugA, slugB]);
    await su.query(`delete from users where email like $1`, [`%-${tag}@test.local`]);
    await su.end();
    await app.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
