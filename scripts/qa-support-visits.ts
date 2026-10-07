/**
 * QA for support visits: the agency inside a clinic, on the record.
 *
 * What is under test is the door and the record together. The door: an agency
 * admin reaches a clinic only through "Open workspace", with a reason, and only
 * the clinic that visit was opened for — not by typing the address, not by
 * editing it to the next clinic, not on a support session issued before visits
 * existed, and not at all without `clinics.impersonate`. The record: every
 * visit is a row with who, why and when, it ends however the session ends, and
 * the clinic's owner reads the same account the agency does, down to which
 * patient files were opened.
 *
 * Browser first, database where the browser cannot see — the visit's end
 * reason, the session's expiry.
 */
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { enterWorkspace } from "./lib-support-visit";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const ADMIN = { email: "admin@makan.agency", password: "admin1234" };
const TAG = Date.now().toString(36);
const A = `qa-sv-a-${TAG}`;
const B = `qa-sv-b-${TAG}`;
const PASSWORD = "password123";
const OWNER = `sv-owner-${TAG}@test.local`;
const STAFF = `sv-staff-${TAG}@test.local`;
const SALES = `sv-sales-${TAG}@test.local`;

let failed = 0;
const ok = (m: string) => console.log(`✓ ${m}`);
const fail = (m: string) => {
  failed++;
  console.log(`✗ ${m}`);
};
const check = (cond: unknown, m: string) => (cond ? ok(m) : fail(m));

/** Laid-out text only — the whole dictionary ships in every page. */
const seen = (page: Page): Promise<string> =>
  page.evaluate("(document.querySelector('main') || document.body).innerText") as Promise<string>;

const path = (page: Page) => new URL(page.url()).pathname;

async function signIn(browser: Browser, email: string, password = PASSWORD): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { timeout: 120000 });
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000 });
  return page;
}

/** Lands wherever the guards send it — they redirect after the shell flushes. */
async function land(page: Page, url: string, expect: (p: string) => boolean, timeout = 60000) {
  await page.goto(`${BASE}${url}`, { timeout: 120000 });
  await page.waitForURL((u) => expect(u.pathname), { timeout }).catch(() => {});
  return path(page);
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const hash = bcrypt.hashSync(PASSWORD, 10);

  const mk = async (slug: string, name: string) => {
    const id = (
      await db.query(`insert into clinics (name, slug) values ($1, $2) returning id`, [name, slug])
    ).rows[0].id as string;
    await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [id]);
    return id;
  };
  const clinicA = await mk(A, "QA Visits A");
  const clinicB = await mk(B, "QA Visits B");
  const user = async (email: string, name: string, extra = "") =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale${extra ? ", is_super_admin, admin_permissions" : ""})
         values ($1, $2, $3, 'en'${extra ? ", true, $4" : ""}) returning id`,
        extra ? [email, hash, name, extra] : [email, hash, name]
      )
    ).rows[0].id as string;
  const owner = await user(OWNER, "QA Owner");
  const staff = await user(STAFF, "QA Reception");
  const sales = await user(
    SALES,
    "QA Sales",
    JSON.stringify({ level: "custom", caps: { analytics: true, "clinics.edit": true } })
  );
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'doctor', true, '{"level":"full"}'),
            ($1, $3, 'receptionist', false, '{"level":"custom","caps":{"settings":true,"patients":true}}')`,
    [clinicA, owner, staff]
  );
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, source) values ($1, 'Rami Visit-Test', 'staff') returning id`,
      [clinicA]
    )
  ).rows[0].id as string;
  const adminId = (await db.query(`select id from users where email = $1`, [ADMIN.email])).rows[0]
    .id as string;

  const visits = async (clinicId: string) =>
    (
      await db.query(
        `select id, reason, ended_at, end_reason, ip, expires_at, admin_user_id
           from support_visits where clinic_id = $1 order by started_at`,
        [clinicId]
      )
    ).rows;

  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    /* ------------------------------------------------------- the door is shut */

    const admin = await signIn(browser, ADMIN.email, ADMIN.password);
    admin.on("pageerror", (e) => errors.push(`[admin] ${e.message}`));

    check(
      (await land(admin, `/c/${A}`, (p) => p.startsWith("/admin"))) === `/admin/clinics/${A}`,
      "typing a clinic's address sends an agency admin to its admin page, not inside"
    );
    check((await visits(clinicA)).length === 0, "…and records nothing, because nothing was entered");

    const api = await admin.request.get(`${BASE}/api/c/${A}/appointments`);
    check(api.status() === 403, `the clinic's API refuses an admin outside a visit (${api.status()})`);

    /* ------------------------------------------------- in, with a reason */

    await admin.waitForLoadState("networkidle");
    await admin.getByRole("button", { name: /open workspace/i }).click();
    await admin.fill('input[name="reason"]', "ab");
    await admin.getByRole("button", { name: /enter workspace/i }).click();
    await admin.waitForSelector("text=Give a reason of at least 3 characters", { timeout: 15000 });
    check(path(admin) === `/admin/clinics/${A}`, "a two-letter reason is refused, and the door stays shut");
    check((await visits(clinicA)).length === 0, "…without opening a visit");

    const REASON = "QA: checking the invoice template";
    await admin.fill('input[name="reason"]', REASON);
    await admin.getByRole("button", { name: /enter workspace/i }).click();
    await admin.waitForURL(`**/c/${A}`, { timeout: 60000 });
    await admin.waitForSelector("text=Support mode", { timeout: 30000 });
    ok("a reason opens the workspace, in support mode");

    let [visit] = await visits(clinicA);
    check(visit?.reason === REASON, "the visit is recorded with its reason");
    check(visit?.admin_user_id === adminId && visit?.ip, "…with who went in and from where");
    check(!visit?.ended_at, "…and is open");
    const sess = (
      await db.query(`select expires_at from sessions where support_visit_id = $1`, [visit.id])
    ).rows[0];
    const hours = sess ? (new Date(sess.expires_at).getTime() - Date.now()) / 3600000 : 0;
    check(hours > 3.5 && hours <= 4.01, `the support session ends with the visit (~${hours.toFixed(2)} h), not in 30 days`);

    await admin.goto(`${BASE}/c/${A}/patients/${patient}`, { timeout: 120000 });
    await admin.waitForLoadState("networkidle");
    const viewed = await db.query(
      `select 1 from audit_log where action = 'patient.view' and entity_id = $1 and user_id = $2`,
      [patient, adminId]
    );
    check(
      path(admin) === `/c/${A}/patients/${patient}` && viewed.rowCount === 1,
      "inside, the admin opens a patient's file, and the read is logged"
    );

    check(
      (await land(admin, `/c/${B}`, (p) => p.startsWith("/admin"))) === `/admin/clinics/${B}`,
      "a visit to one clinic is not a way into the next by editing the URL"
    );
    check((await visits(clinicB)).length === 0, "…and the attempt opened nothing there");

    /* --------------------------------------------- the clinic sees it too */

    const ownerPage = await signIn(browser, OWNER);
    ownerPage.on("pageerror", (e) => errors.push(`[owner] ${e.message}`));
    await ownerPage.goto(`${BASE}/c/${A}/settings`);
    await ownerPage.waitForSelector("nav >> text=Support visits", { timeout: 60000 });
    ok("the owner has a Support visits tab");
    await ownerPage.goto(`${BASE}/c/${A}/settings/support-visits`);
    await ownerPage.waitForSelector(`text=${REASON}`, { timeout: 60000 });
    let ownerText = await seen(ownerPage);
    check(ownerText.includes("In progress"), "the owner sees the visit, in progress, with its reason");
    check(ownerText.includes("Rami Visit-Test"), "…and which patient's file was opened");
    check(!ownerText.includes("admin@makan.agency"), "…without the admin's address, which is the agency's business");

    const staffPage = await signIn(browser, STAFF);
    await staffPage.goto(`${BASE}/c/${A}/settings`);
    await staffPage.waitForSelector("nav", { timeout: 60000 });
    check(!(await seen(staffPage)).includes("Support visits"), "a member without full control has no tab");
    check(
      (await land(staffPage, `/c/${A}/settings/support-visits`, (p) => p === `/c/${A}/settings`)) ===
        `/c/${A}/settings`,
      "…and typing the address sends them back to Settings"
    );
    await staffPage.context().close();

    /* -------------------------------------------------------------- out */

    await admin.goto(`${BASE}/c/${A}`);
    await admin.waitForSelector("text=Exit support mode", { timeout: 60000 });
    await admin.click("text=Exit support mode");
    await admin.waitForURL(`**/admin/clinics/${A}`, { timeout: 60000 });
    [visit] = await visits(clinicA);
    check(visit.ended_at && visit.end_reason === "exit", `exiting closes the visit as "exit" (${visit.end_reason})`);
    await admin.waitForSelector(`text=${REASON}`, { timeout: 30000 });
    const adminText = await seen(admin);
    check(
      adminText.includes("Workspace visits") && adminText.includes("Opened 1 patient file"),
      "the clinic's admin page lists the visit and what it did"
    );
    check(!adminText.includes("Rami Visit-Test"), "…but not the patient's name, which only the clinic sees");

    await ownerPage.reload();
    await ownerPage.waitForSelector(`text=${REASON}`, { timeout: 60000 });
    ownerText = await seen(ownerPage);
    check(ownerText.includes("Left") && ownerText.includes("Opened 1 patient file"), "the owner sees it ended");

    /* ------------------------------------- switching, signing out, expiry */

    await enterWorkspace(admin, { reason: "QA: first of two" });
    await enterWorkspace(admin, { base: BASE, slug: B, reason: "QA: second of two" });
    const firstOfTwo = (await visits(clinicA)).find((v) => v.reason === "QA: first of two");
    check(firstOfTwo?.end_reason === "switched", `going on to another clinic ends the first visit (${firstOfTwo?.end_reason})`);
    check(path(admin) === `/c/${B}`, "…and opens the second");

    await admin.click(`button[aria-label="Sign out"]`);
    await admin.waitForURL("**/login**", { timeout: 60000 });
    const [second] = await visits(clinicB);
    check(second?.end_reason === "signed_out", `signing out ends the visit (${second?.end_reason})`);
    await admin.context().close();

    const admin2 = await signIn(browser, ADMIN.email, ADMIN.password);
    await enterWorkspace(admin2, { base: BASE, slug: A, reason: "QA: left open" });
    const leftOpen = (await visits(clinicA)).find((v) => v.reason === "QA: left open")!;
    await db.query(`update support_visits set expires_at = now() - interval '1 minute' where id = $1`, [leftOpen.id]);
    await db.query(`update sessions set expires_at = now() - interval '1 minute' where support_visit_id = $1`, [leftOpen.id]);
    check(
      (await land(admin2, `/c/${A}`, (p) => p.startsWith("/login"))).startsWith("/login"),
      "a visit past its time no longer opens anything"
    );
    await ownerPage.reload();
    await ownerPage.waitForSelector("text=QA: left open", { timeout: 60000 });
    check((await seen(ownerPage)).includes("Timed out"), "the owner sees a visit nobody ended as timed out");
    await db.query(`delete from sessions where support_visit_id = $1`, [leftOpen.id]);
    const swept = (await visits(clinicA)).find((v) => v.id === leftOpen.id);
    check(swept?.end_reason === "expired" && swept?.ended_at, "when the worker sweeps the session, the visit is closed as expired");
    await admin2.context().close();

    /* ----------------------------------------- who may not come in at all */

    const salesPage = await signIn(browser, SALES);
    check(
      (await land(salesPage, `/c/${A}`, (p) => p.startsWith("/admin"))) === `/admin/clinics/${A}`,
      "an admin without clinics.impersonate cannot enter by address"
    );
    await salesPage.waitForLoadState("networkidle");
    check(
      (await salesPage.getByRole("button", { name: /open workspace/i }).count()) === 0,
      "…and is not offered the button"
    );
    await salesPage.context().close();

    // A support session issued before visits existed — what every open support
    // session in production is at the moment this ships.
    const token = randomBytes(32).toString("hex");
    await db.query(
      `insert into sessions (token_hash, user_id, impersonated_by, expires_at)
       values ($1, $2, $2, now() + interval '1 day')`,
      [createHash("sha256").update(token).digest("hex"), adminId]
    );
    const legacyCtx = await browser.newContext();
    await legacyCtx.addCookies([
      { name: "cos_session", value: token, url: BASE },
      { name: "cos_locale", value: "en", url: BASE },
    ]);
    const legacy = await legacyCtx.newPage();
    check(
      (await land(legacy, `/c/${A}`, (p) => p.startsWith("/admin"))) === `/admin/clinics/${A}`,
      "a support session from before visits existed does not get in"
    );
    await legacyCtx.close();

    /* ----------------------------------------------- the team-wide record */

    const admin3 = await signIn(browser, ADMIN.email, ADMIN.password);
    await admin3.goto(`${BASE}/admin/team`);
    await admin3.waitForSelector("text=QA: second of two", { timeout: 60000 });
    const team = await seen(admin3);
    check(team.includes("QA Visits B") && team.includes(REASON), "the team page lists visits across clinics");
    await admin3.context().close();
    await ownerPage.context().close();

    if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await db.query(`delete from sessions where user_id = $1 and impersonated_by is not null`, [adminId]);
    await db.query(`delete from clinics where id in ($1, $2)`, [clinicA, clinicB]);
    await db.query(`delete from users where email in ($1, $2, $3)`, [OWNER, STAFF, SALES]);
    await db.end();
  }
  console.log(failed ? `\n${failed} support-visit check(s) failed.` : "\nAll support-visit checks passed.");
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
