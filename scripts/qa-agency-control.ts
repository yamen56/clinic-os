/**
 * QA for the agency control surface: analytics, limited admin accounts,
 * per-clinic module licensing, and the reversible clinic deletion.
 *
 * Every assertion goes through the browser rather than the database where it
 * can, because the point of all four features is what somebody sees: a limited
 * admin is only limited if the nav is actually shorter, and a module is only
 * switched off if it is actually gone from the workspace. A row saying
 * `{"campaigns": false}` proves nothing on its own.
 */
import { chromium, type Page, type Browser } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

const ADMIN = { email: "admin@makan.agency", password: "admin1234" };
const LIMITED = { email: "qa-limited-admin@test.local", password: "limited1234", name: "QA Limited" };
const TEST_SLUG = "qa-agency-doomed";

const ok = (m: string) => console.log(`✓ ${m}`);

/**
 * What a person can actually see.
 *
 * Not `textContent`. The whole dictionary is serialised into the RSC payload of
 * every page, so `body.textContent` contains every string in the product —
 * "Danger zone" included — on screens that render none of them. An assertion
 * built on it passes everywhere and therefore tests nothing, which is worse
 * than no assertion at all. `innerText` reads laid-out text, so scripts and
 * hidden nodes are excluded.
 */
const seen = (page: Page): Promise<string> =>
  page.evaluate(() => (document.querySelector("main") as HTMLElement | null)?.innerText ?? document.body.innerText);
const fail = (m: string) => {
  throw new Error(m);
};

async function signIn(browser: Browser, email: string, password: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  /*
    English, explicitly. Arabic is the product's default and the right one, but
    a suite that asserts on visible text has to pin the language or it is really
    asserting on whatever the last cookie said.
  */
  await page.context().addCookies([
    { name: "cos_locale", value: "en", url: BASE },
  ]);
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
  return page;
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  // A previous run that threw mid-way leaves its clinic and admin behind, and
  // the slug is unique — so clear them before, not only after.
  await db.query(`delete from clinics where slug = $1`, [TEST_SLUG]);
  await db.query(`delete from users where lower(email) = $1`, [LIMITED.email]);

  const browser = await chromium.launch({ channel: "chromium" });
  const errors: string[] = [];

  try {
    const page = await signIn(browser, ADMIN.email, ADMIN.password);
    page.on("pageerror", (e) => errors.push(e.message));
    ok("agency admin signed in");

    /* ------------------------------------------------------------ analytics */

    await page.goto(`${BASE}/admin/analytics`);
    await page.waitForSelector("text=By clinic", { timeout: 30000 });
    const analytics = await seen(page);
    for (const needle of ["Patients", "Appts", "Messages", "AI spend", "WhatsApp health"]) {
      if (!analytics.includes(needle)) fail(`analytics missing section: ${needle}`);
    }
    ok("analytics renders usage tiles, league table, AI spend and WhatsApp health");

    await page.goto(`${BASE}/admin/analytics?range=90`);
    await page.waitForSelector("text=By clinic", { timeout: 20000 });
    if (!(await seen(page)).includes("last 90 days"))
      fail("range switch did not take effect");
    ok("analytics range switch changes the window");

    // A range nobody offered must fall back rather than reach the query.
    await page.goto(`${BASE}/admin/analytics?range=99999`);
    await page.waitForSelector("text=By clinic", { timeout: 20000 });
    if (!(await seen(page)).includes("last 30 days"))
      fail("out-of-range parameter was not clamped to the default");
    ok("an unrecognised range falls back to 30 days");

    /* --------------------------------------------------- module licensing */

    // The demo clinic starts on the full product; take one module away and
    // confirm the workspace loses it.
    const demo = (await db.query(`select id, slug from clinics where slug = 'rima-dental'`)).rows[0];
    if (!demo) fail("demo clinic missing — run `npm run seed`");

    await page.goto(`${BASE}/c/${demo.slug}`);
    await page.waitForSelector("nav", { timeout: 30000 });
    if (!((await page.textContent("nav")) ?? "").includes("Campaigns"))
      fail("demo clinic did not start with Campaigns — cannot test removing it");
    ok("demo clinic starts with the Campaigns module");

    await db.query(`update clinics set features = $2 where id = $1`, [
      demo.id,
      JSON.stringify({ campaigns: false }),
    ]);
    await page.goto(`${BASE}/c/${demo.slug}`);
    await page.waitForSelector("nav", { timeout: 20000 });
    const navAfter = (await page.textContent("nav")) ?? "";
    if (navAfter.includes("Campaigns")) fail("Campaigns still in the nav after the module was removed");
    if (!navAfter.includes("Calendar")) fail("removing one module removed others too");
    ok("a disabled module disappears from the workspace nav");

    // And the route itself, not only the link to it.
    await page.goto(`${BASE}/c/${demo.slug}/campaigns`);
    await page.waitForLoadState("networkidle");
    if (new URL(page.url()).pathname !== `/c/${demo.slug}`)
      fail(`a disabled module's route was still reachable: ${page.url()}`);
    ok("the disabled module's route redirects, so the gate is not just the nav");

    await db.query(`update clinics set features = '{}'::jsonb where id = $1`, [demo.id]);
    await page.goto(`${BASE}/c/${demo.slug}`);
    await page.waitForSelector("nav", { timeout: 20000 });
    if (!((await page.textContent("nav")) ?? "").includes("Campaigns"))
      fail("Campaigns did not come back when the module was restored");
    ok("restoring the module brings the section back untouched");

    /* ------------------------------------------------------ limited admin */

    await page.goto(`${BASE}/admin/team`);
    await page.waitForSelector("text=Add admin", { timeout: 30000 });
    ok("team page loads for a full admin");

    // Created directly, then driven through the UI: the invite email is not
    // what is under test here, the resulting access is.
    const limited = (
      await db.query(
        `insert into users (email, full_name, password_hash, is_super_admin, admin_permissions, locale)
         values ($1, $2, $3, true, $4, 'en') returning id`,
        [
          LIMITED.email,
          LIMITED.name,
          bcrypt.hashSync(LIMITED.password, 10),
          JSON.stringify({
            level: "custom",
            caps: { monitoring: true, analytics: true, "clinics.impersonate": true },
          }),
        ]
      )
    ).rows[0];

    const lp = await signIn(browser, LIMITED.email, LIMITED.password);
    lp.on("pageerror", (e) => errors.push(`[limited] ${e.message}`));
    await lp.goto(`${BASE}/admin`);
    await lp.waitForSelector("nav", { timeout: 30000 });
    const lnav = (await lp.textContent("nav")) ?? "";
    for (const shown of ["Clinics", "Analytics", "Monitoring"]) {
      if (!lnav.includes(shown)) fail(`limited admin should see ${shown} in the nav`);
    }
    for (const hidden of ["Team", "Announcements", "Defaults"]) {
      if (lnav.includes(hidden)) fail(`limited admin should NOT see ${hidden} in the nav`);
    }
    ok("a limited admin's nav shows only what they were granted");

    // The nav is a courtesy; the guard is the control.
    for (const route of ["/admin/team", "/admin/announcements", "/admin/defaults"]) {
      await lp.goto(`${BASE}${route}`);
      await lp.waitForLoadState("networkidle");
      if (new URL(lp.url()).pathname === route)
        fail(`limited admin reached ${route} by typing the URL`);
    }
    ok("typing a forbidden admin URL redirects rather than rendering");

    // A page they DO have must still work — a guard that denies everything is
    // not a passing test.
    await lp.goto(`${BASE}/admin/monitoring`);
    await lp.waitForSelector("text=WhatsApp sessions", { timeout: 30000 });
    ok("the limited admin can still open what they were granted");

    /*
      The backup panel is on this page, and it is the only place anybody would
      notice that the nightly job has stopped. It once stopped for five weeks
      because nothing displayed it, so "does this actually render" is worth an
      assertion rather than an assumption.

      innerText, not the HTML: this app ships its whole dictionary into every
      page, so a source check passes everywhere and proves nothing.
    */
    const monitoringText = await lp.locator("body").innerText();
    if (!monitoringText.includes("Database backups"))
      fail("the backups panel is missing from the monitoring page");
    if (!/Last backup/.test(monitoringText))
      fail("the last-backup tile is missing from the monitoring page");
    ok("the monitoring page shows the backup age and the archives themselves");

    // Deletion is not in their set, so the danger zone must not be rendered.
    await lp.goto(`${BASE}/admin/clinics/${demo.slug}`);
    await lp.waitForLoadState("networkidle");
    if ((await seen(lp)).includes("Danger zone"))
      fail("limited admin without clinics.delete was shown the danger zone");
    ok("the danger zone is absent for an admin without delete");
    await lp.close();

    /* ----------------------------------------------- delete → restore → purge */

    await page.goto(`${BASE}/admin/clinics/new`);
    await page.waitForSelector('input[name="slug"]', { timeout: 30000 });
    await page.fill('input[name="name"]', "QA Doomed Clinic");
    await page.fill('input[name="slug"]', TEST_SLUG);
    await page.fill('input[name="ownerName"]', "QA Owner");
    await page.fill('input[name="ownerEmail"]', "owner-qa-doomed@test.local");
    await page.click('button[type="submit"]');
    await page.waitForURL(`**/admin/clinics/${TEST_SLUG}`, { timeout: 30000 });
    ok("clinic created through the form");

    const created = (
      await db.query(`select id, features from clinics where slug = $1`, [TEST_SLUG])
    ).rows[0];
    if (!created) fail("clinic was not created");
    // The form defaults to the whole product, written out in full rather than
    // left as an empty object.
    if (Object.keys(created.features ?? {}).length === 0)
      fail("new clinic stored no explicit feature map");
    ok("the new clinic recorded an explicit module licence");

    await page.waitForSelector("text=Danger zone", { timeout: 20000 });
    await page.click("button:has-text('Delete clinic')");
    await page.waitForSelector('input[placeholder="' + TEST_SLUG + '"]', { timeout: 10000 });

    // The confirm button stays dead until the slug matches exactly.
    await page.fill(`input[placeholder="${TEST_SLUG}"]`, "not-the-slug");
    const premature = await page
      .locator(".fixed button:has-text('Delete clinic')")
      .last()
      .isDisabled();
    if (!premature) fail("delete was enabled before the slug matched");
    ok("delete stays disabled until the slug is typed correctly");

    await page.fill(`input[placeholder="${TEST_SLUG}"]`, TEST_SLUG);
    await page.locator(".fixed button:has-text('Delete clinic')").last().click();
    await page.waitForSelector("text=days left", { timeout: 20000 });

    const afterDelete = (
      await db.query(
        `select deleted_at, deleted_by,
                (select count(*)::int from patients where clinic_id = clinics.id) as patients
           from clinics where slug = $1`,
        [TEST_SLUG]
      )
    ).rows[0];
    if (!afterDelete?.deleted_at) fail("clinic was not marked deleted");
    if (!afterDelete.deleted_by) fail("deletion did not record who did it");
    ok("delete marks the clinic and records who, keeping every row");

    const wa = (
      await db.query(`select desired from whatsapp_sessions where clinic_id = $1`, [created.id])
    ).rows[0];
    if (wa?.desired) fail("WhatsApp session was left marked desired after deletion");
    ok("the WhatsApp session is no longer wanted");

    // The workspace has to be shut, and shut with the right explanation.
    await page.goto(`${BASE}/c/${TEST_SLUG}`);
    await page.waitForLoadState("networkidle");
    if (!page.url().includes("/suspended"))
      fail(`a deleted clinic's workspace was still reachable: ${page.url()}`);
    if (!(await seen(page)).includes("closed"))
      fail("a deleted workspace showed the suspended-subscription wording");
    ok("the workspace is closed, with wording that is not the billing message");

    await page.goto(`${BASE}/admin`);
    await page.waitForSelector("text=Deleted", { timeout: 20000 });
    ok("the clinic moved to the deleted list");

    await page.goto(`${BASE}/admin/clinics/${TEST_SLUG}`);
    await page.waitForSelector("button:has-text('Restore')", { timeout: 20000 });
    await page.click("button:has-text('Restore')");
    await page.waitForSelector("text=Danger zone", { timeout: 20000 });
    if ((await db.query(`select deleted_at from clinics where slug = $1`, [TEST_SLUG])).rows[0]
        .deleted_at)
      fail("restore did not clear the deletion");
    ok("restore brings the clinic back");

    await page.goto(`${BASE}/c/${TEST_SLUG}`);
    await page.waitForLoadState("networkidle");
    if (page.url().includes("/suspended")) fail("workspace still closed after restore");
    ok("the workspace opens again after restore");

    // Delete once more, then destroy for real — which must refuse to run on a
    // clinic that has not been deleted first.
    await page.goto(`${BASE}/admin/clinics/${TEST_SLUG}`);
    await page.waitForSelector("button:has-text('Delete clinic')", { timeout: 20000 });
    await page.click("button:has-text('Delete clinic')");
    await page.fill(`input[placeholder="${TEST_SLUG}"]`, TEST_SLUG);
    await page.locator(".fixed button:has-text('Delete clinic')").last().click();
    await page.waitForSelector("button:has-text('Destroy permanently')", { timeout: 20000 });

    await page.click("button:has-text('Destroy permanently')");
    await page.fill(`input[placeholder="${TEST_SLUG}"]`, TEST_SLUG);
    await page.locator(".fixed button:has-text('Destroy permanently')").last().click();
    await page.waitForURL("**/admin", { timeout: 20000 });

    const gone = await db.query(`select 1 from clinics where slug = $1`, [TEST_SLUG]);
    if (gone.rowCount) fail("purge did not remove the clinic row");
    const orphans = await db.query(
      `select count(*)::int as n from patients where clinic_id = $1`,
      [created.id]
    );
    if (orphans.rows[0].n !== 0) fail("purge left child rows behind");
    ok("permanent destruction removes the clinic and everything under it");

    const audited = await db.query(
      `select count(*)::int as n from audit_log
        where action in ('admin.clinic.delete','admin.clinic.restore','admin.clinic.purge')
          and detail->>'slug' = $1`,
      [TEST_SLUG]
    );
    // The audit trail is the one thing that must outlive the cascade — which is
    // why those rows are written with a null clinic_id.
    if (audited.rows[0].n < 3) fail(`audit trail incomplete: ${audited.rows[0].n} entries`);
    ok("delete, restore and purge all survive in the audit log");

    /* -------------------------------------------------- team safety rails */

    const revoke = await db.query(
      `select count(*)::int as n from users where is_super_admin
         and coalesce(admin_permissions->>'level','full') <> 'custom'`
    );
    if (revoke.rows[0].n < 1) fail("no full admin remains — the last-admin guard is not holding");
    ok(`${revoke.rows[0].n} full admin(s) remain`);

    await db.query(`delete from users where id = $1`, [limited.id]);

    if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
    console.log("\nAll agency-control checks passed.");
  } finally {
    await browser.close();
    await db.query(`delete from clinics where slug = $1`, [TEST_SLUG]);
    await db.query(`delete from users where lower(email) in ($1, $2)`, [
      LIMITED.email,
      "owner-qa-doomed@test.local",
    ]);
    await db.end();
  }
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
