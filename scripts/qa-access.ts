/**
 * Browser QA for staff access.
 *
 * Access control is the one feature where "it looks right" is worth nothing —
 * a hidden nav entry is a courtesy, not a boundary. So every assertion here
 * comes in two halves: the screen does not offer it, *and* the server refuses it
 * when asked directly. The second half is the one that matters; the first is
 * only there so staff are not walked into a wall.
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function signIn(page: Page, email: string) {
  // Signing in as the next person means being nobody first — /login redirects a
  // live session straight back to their workspace, so without this the second
  // sign-in silently reuses the first.
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000 });
}

/**
 * Where a navigation actually settles.
 *
 * The guards redirect rather than 403, and the redirect is decided in a nested
 * layout — by which point the app shell has already streamed, so the response is
 * a 200 and the address bar holds the requested path for a moment before the
 * client follows. The protected content never renders either way; what a person
 * experiences is where they end up, so that is what this reports.
 */
async function landsOn(page: Page, path: string, expected?: string): Promise<string> {
  await page.goto(`${BASE}${path}`);
  if (expected && expected !== path) {
    await page.waitForURL((u) => u.pathname === expected, { timeout: 15000 }).catch(() => {});
  }
  await page.waitForLoadState("networkidle");
  return new URL(page.url()).pathname;
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qaacc-test${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug) values ('QA Access', 'صلاحيات', $1) returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);

  const mkUser = async (tag: string, name: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1, $2, $3, 'en') returning id`,
        [`${tag}-${slug}@test.local`, bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;

  const ownerId = await mkUser("owner", "QA Owner");
  const docId = await mkUser("doctor", "QA Doctor");
  const recId = await mkUser("reception", "QA Reception");

  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'receptionist', true, '{"level":"full"}')`,
    [clinic.id, ownerId]
  );

  /*
    A doctor who has been *granted* the inbox and invoices — the case the old
    model could not express at all, because both were spelled `role <> 'doctor'`.
    Documents are visible but not manageable, which is the default for the job.
  */
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, permissions)
     values ($1, $2, 'doctor', $3)`,
    [
      clinic.id,
      docId,
      JSON.stringify({
        level: "custom",
        caps: {
          conversations: true,
          calendar: true,
          patients: true,
          documents: true,
          "documents.manage": false,
          "documents.void": false,
          invoices: true,
          campaigns: false,
          automations: false,
          settings: false,
          "settings.clinic": false,
          "settings.staff": false,
        },
      }),
    ]
  );

  /*
    And a receptionist with invoices taken away — the mirror case. They keep
    documents including sending, and get the staff screen delegated to them,
    which is what makes the "can a delegate seize the clinic" test below real.
  */
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, permissions)
     values ($1, $2, 'receptionist', $3)`,
    [
      clinic.id,
      recId,
      JSON.stringify({
        level: "custom",
        caps: {
          conversations: true,
          calendar: true,
          patients: true,
          documents: true,
          "documents.manage": true,
          "documents.void": false,
          invoices: false,
          campaigns: false,
          automations: false,
          settings: true,
          "settings.clinic": false,
          "settings.staff": true,
        },
      }),
    ]
  );
  console.log(`✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const navLabels = async () =>
    (await page.locator("aside nav a").allTextContents()).map((s) => s.replace(/\d+$/, "").trim());

  /* ------------------------------------------------------------- the owner */
  await signIn(page, `owner-${slug}@test.local`);
  await page.goto(`${BASE}/c/${slug}`);
  await page.waitForLoadState("networkidle");
  const ownerNav = await navLabels();
  check(
    "owner sees every section",
    ["Conversations", "Calendar", "Patients", "Documents", "Invoices", "Settings"].every((l) =>
      ownerNav.some((n) => n.includes(l))
    ),
    ownerNav.join(", ")
  );
  check("owner reaches staff settings", (await landsOn(page, `/c/${slug}/settings/staff`)).endsWith("/settings/staff"));

  /* ------------------------------------------------------------ the doctor */
  await signIn(page, `doctor-${slug}@test.local`);
  await page.goto(`${BASE}/c/${slug}`);
  await page.waitForLoadState("networkidle");
  const docNav = await navLabels();
  check(
    "a doctor granted the inbox sees the inbox",
    docNav.some((n) => n.includes("Conversations")),
    docNav.join(", ")
  );
  check(
    "a doctor granted invoices sees invoices",
    docNav.some((n) => n.includes("Invoices")),
    docNav.join(", ")
  );
  check("settings stays hidden", !docNav.some((n) => n.includes("Settings")), docNav.join(", "));
  const docSettings = await landsOn(page, `/c/${slug}/settings`, `/c/${slug}`);
  check("settings is refused, not just hidden", docSettings === `/c/${slug}`, docSettings);
  check(
    "the inbox actually opens",
    (await landsOn(page, `/c/${slug}/conversations`)).includes("/conversations")
  );

  // Documents: visible, but the create button is not offered.
  await page.goto(`${BASE}/c/${slug}/documents`);
  await page.waitForLoadState("networkidle");
  check(
    "documents open without the create button",
    (await page.locator("button:has-text('New document')").count()) === 0
  );
  /*
    And the API says no when asked directly, which is the assertion that counts.
    The route has to be guarded by the capability this member actually lacks —
    they hold `documents` and not `documents.manage`, so a route behind plain
    `documents` would let them through and prove nothing. Raising a document
    against an appointment is the manage-gated one.
  */
  const apiStatus = await page.evaluate(async (s) => {
    const r = await fetch(`/api/c/${s}/appointments/00000000-0000-0000-0000-000000000000/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "00000000-0000-0000-0000-000000000000" }),
    });
    return r.status;
  }, slug);
  check("the documents API refuses them", apiStatus === 403, `status ${apiStatus}`);

  /* ------------------------------------------------------- the receptionist */
  await signIn(page, `reception-${slug}@test.local`);
  await page.goto(`${BASE}/c/${slug}`);
  await page.waitForLoadState("networkidle");
  const recNav = await navLabels();
  check(
    "a receptionist with invoices removed does not see invoices",
    !recNav.some((n) => n.includes("Invoices")),
    recNav.join(", ")
  );
  const recInvoices = await landsOn(page, `/c/${slug}/invoices`, `/c/${slug}`);
  check("invoices are refused, not just hidden", recInvoices === `/c/${slug}`, recInvoices);

  /*
    The dashboard is the one screen nobody loses, which makes it the one place a
    removed section can still leak. Money in particular: reading the week's
    revenue off the front page would undo taking Invoices away.
  */
  await page.goto(`${BASE}/c/${slug}`);
  await page.waitForLoadState("networkidle");
  /*
    Counted in the DOM, not searched for in the page source. The i18n provider
    ships the whole dictionary to the client, so every label in the app appears
    in the HTML whether or not it was rendered — a substring check here passes
    and fails for reasons that have nothing to do with what is on screen.
  */
  check(
    "the dashboard does not show them revenue",
    (await page.getByText("Revenue this week").count()) === 0
  );
  check(
    "nor the unpaid invoice count",
    (await page.getByText("unpaid invoices").count()) === 0
  );
  check(
    "but does show what they kept",
    (await page.getByText("Unread conversations").count()) > 0
  );
  check(
    "they still reach the staff screen that was delegated to them",
    (await landsOn(page, `/c/${slug}/settings/staff`)).endsWith("/settings/staff")
  );
  const recFields = await landsOn(page, `/c/${slug}/settings/fields`, `/c/${slug}`);
  check("but not the clinic-wide settings they were not given", recFields === `/c/${slug}`, recFields);

  // The escalation that matters: a delegated staff manager must not be able to
  // edit the owner, and must not be able to widen their own access.
  await page.goto(`${BASE}/c/${slug}/settings/staff`);
  await page.waitForLoadState("networkidle");
  const ownerRow = page.locator("li", { hasText: "QA Owner" }).first();
  check(
    "the owner's row cannot be opened by a delegate",
    await ownerRow.locator("button[disabled]").first().isVisible()
  );

  // Their own row opens, but the access editor is replaced by the note saying
  // why — the server refuses a self-patch, so offering the controls would only
  // produce a save that silently does nothing.
  await page.locator("li", { hasText: "QA Reception" }).first().locator("button").last().click();
  await page.waitForSelector("[role='dialog'], .fixed", { timeout: 10000 });
  check(
    "they cannot edit their own access",
    (await page.locator("text=You can't change your own job or access").count()) > 0
  );
  check(
    "and their own job select is disabled",
    await page.locator("select[disabled]").first().isVisible()
  );

  /* ----------------------------------------- the model resolves as intended */
  const { resolveCapabilities } = await import("../src/lib/permissions");
  const rows = await db.query(
    `select role, is_owner, permissions from clinic_members where clinic_id = $1`,
    [clinic.id]
  );
  const owner = rows.rows.find((r) => r.is_owner);
  check(
    "an owner resolves to full access whatever is stored",
    Object.values(
      resolveCapabilities(owner.permissions, { isOwner: true, role: owner.role })
    ).every(Boolean)
  );

  const doctorRow = rows.rows.find((r) => !r.is_owner && r.role === "doctor");
  const doctorCaps = resolveCapabilities(doctorRow.permissions, {
    isOwner: false,
    role: "doctor",
  });
  check("granted capabilities survive the round trip", doctorCaps.conversations && doctorCaps.invoices);
  check("ungranted ones stay off", !doctorCaps.settings && !doctorCaps["documents.manage"]);

  // A hand-edited row that ticks an action but not its section must not grant it.
  const inconsistent = resolveCapabilities(
    { level: "custom", caps: { documents: false, "documents.void": true } },
    { isOwner: false, role: "other" }
  );
  check("an action cannot outlive its section", !inconsistent["documents.void"]);

  // A row written before this model existed still behaves like it used to.
  const legacy = resolveCapabilities({ automations: true }, { isOwner: false, role: "receptionist" });
  check(
    "a pre-0014 row falls back to its job's set",
    legacy.conversations && legacy.invoices && legacy.automations && !legacy["settings.staff"]
  );

  // …and the settings screen must agree with that, or opening the row and
  // pressing save would quietly promote them to everything.
  const { accessLevelOf } = await import("../src/lib/permissions");
  check("and the screen calls that limited, not full", accessLevelOf({ automations: true }) === "custom");
  check("while an explicit full stays full", accessLevelOf({ level: "full" }) === "full");

  check("no page errors", errors.length === 0, errors.join(" | "));

  await browser.close();
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = any($1::uuid[])`, [[ownerId, docId, recId]]);
  await db.end();

  console.log(`\n  access: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
