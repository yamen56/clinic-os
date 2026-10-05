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
import fs from "node:fs";
import path from "node:path";

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

/**
 * Actions that establish membership and then check no capability, deliberately.
 *
 * Every one is gated on *who is asking* rather than on what they may open:
 * signing and declining verify that the signer row names the caller, the
 * signature/PIN pair write only that user's own credentials, releasing a lock
 * touches only a lock they hold, and the notification preferences are their
 * own. A capability check on these would be the wrong question.
 *
 * The last two are the same argument about the account itself. Erasing it and
 * renaming it both write one row — the caller's own — and `users_access` says so
 * independently of the code: `with check (id = app_user_id())`. There is no
 * capability that would make either of them somebody else's to do, and inventing
 * one would mean a clinic could stop a person changing their own name.
 */
const IDENTITY_AUTHORISED = [
  "signAsStaffAction",
  "declineAsStaffAction",
  "releaseInPersonAction",
  "saveMySignatureAction",
  "setKioskPinAction",
  "verifyKioskUnlockAction",
  "saveNotificationPrefsAction",
  "deleteMyAccountAction",
  "updateMyNameAction",
];

/** Reads every `"use server"` file under src and reports the unguarded actions. */
function auditServerActions(): {
  unexplained: { file: string; line: number; fn: string }[];
  exceptionsSeen: number;
} {
  const unexplained: { file: string; line: number; fn: string }[] = [];
  let exceptionsSeen = 0;

  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) read(p);
    }
  };

  const read = (p: string) => {
    const s = fs.readFileSync(p, "utf8");
    if (!s.startsWith('"use server"')) return;
    const starts = [...s.matchAll(/export async function (\w+)\(/g)];
    starts.forEach((m, i) => {
      const body = s.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : s.length);
      // Clinic-scoped only. Admin and public actions answer to other rules.
      if (!/requireClinic\(/.test(body)) return;
      /*
        `can(access, "…")` is the direct form; the rest are this codebase's
        named wrappers around it — automations and the AI screen share
        `canEdit`, campaigns uses `assertCanSend`.
      */
      if (/\bcan\(access,|canEdit\(|assertCan\w*\(|access\.isOwner/.test(body)) return;
      if (IDENTITY_AUTHORISED.includes(m[1])) {
        exceptionsSeen++;
        return;
      }
      unexplained.push({ file: p, line: s.slice(0, m.index!).split("\n").length, fn: m[1] });
    });
  };

  walk("src");
  return { unexplained, exceptionsSeen };
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
          /*
            The case this capability exists for: somebody who raises and settles
            invoices, but is not shown what the clinic took this week.
          */
          "invoices.analytics": false,
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
  /*
    The switches carved out on 2026-10-06, each one explicitly off for somebody
    who holds the section it was carved from. A clerk who raises invoices, opens
    files and edits services — and was told no to insurance, WhatsApp, voiding
    and merging. Every refusal below is made against a capability this member
    lacks while holding the one that used to imply it, which is the only way
    such a test proves anything.
  */
  const clerkId = await mkUser("clerk", "QA Clerk");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, permissions)
     values ($1, $2, 'receptionist', $3)`,
    [
      clinic.id,
      clerkId,
      JSON.stringify({
        level: "custom",
        caps: {
          dashboard: true,
          patients: true,
          "patients.merge": false,
          invoices: true,
          "invoices.void": false,
          insurance: false,
          "insurance.claims": false,
          "insurance.companies": false,
          settings: true,
          "settings.services": true,
          "settings.whatsapp": false,
        },
      }),
    ]
  );
  // And the other way round: insurance and nothing else of the money section.
  const insClerkId = await mkUser("insclerk", "QA Insurance Clerk");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, permissions)
     values ($1, $2, 'other', $3)`,
    [
      clinic.id,
      insClerkId,
      JSON.stringify({
        level: "custom",
        caps: { dashboard: true, insurance: true, "insurance.claims": true, invoices: false, patients: false },
      }),
    ]
  );
  const insurerId = (
    await db.query(`insert into insurers (clinic_id, name) values ($1, 'QA Assurance') returning id`, [clinic.id])
  ).rows[0].id as string;
  const insuredId = (
    await db.query(
      `insert into patients (clinic_id, full_name, insurer_id, insurance_no)
       values ($1, 'QA Insured', $2, 'POL-1') returning id`,
      [clinic.id, insurerId]
    )
  ).rows[0].id as string;
  const claimInvoiceId = (
    await db.query(
      `insert into invoices (clinic_id, patient_id, seq, number, status, total, insurer_id, insurer_amount, claim_status, issue_date)
       values ($1, $2, 1, 'QA-0001', 'sent', 100, $3, 60, 'to_submit', current_date) returning id`,
      [clinic.id, insuredId, insurerId]
    )
  ).rows[0].id as string;
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
    ["Conversations", "Calendar", "Patients", "Documents", "Finance", "Settings"].every((l) =>
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
    "a doctor granted invoices sees the money section",
    docNav.some((n) => n.includes("Finance")),
    docNav.join(", ")
  );
  // One entry, not three. Invoices, Earnings and Expenses are tabs inside it.
  check(
    "and it is one nav entry, not three",
    docNav.filter((n) => /Finance|Invoices|Earnings|Expenses/.test(n)).length === 1,
    docNav.join(", ")
  );
  check("settings stays hidden", !docNav.some((n) => n.includes("Settings")), docNav.join(", "));
  const docSettings = await landsOn(page, `/c/${slug}/settings`, `/c/${slug}`);
  check("settings is refused, not just hidden", docSettings === `/c/${slug}`, docSettings);
  check(
    "the inbox actually opens",
    (await landsOn(page, `/c/${slug}/conversations`)).includes("/conversations")
  );

  /*
    Invoices without the takings.

    Two screens, because there are two doors to the same number: the totals
    across the top of the invoice list, and the revenue tile and charts on the
    front page — which is the one screen every member can open, and therefore
    the one where hiding a section elsewhere leaks if the dashboard is forgotten.
  */
  await page.goto(`${BASE}/c/${slug}/invoices`);
  await page.waitForLoadState("networkidle");
  const seen = async () => (await page.locator("main").first().innerText()).replace(/[\s]+/g, " ");
  const docInvoices = await seen();
  check("the invoice list still opens for them", docInvoices.includes("Invoices"), docInvoices.slice(0, 80));
  check(
    "but the totals across the top are not there",
    !docInvoices.includes("This week") && !docInvoices.includes("Outstanding"),
    docInvoices.slice(0, 160)
  );
  check(
    "while the filter chips, which need no money, are",
    docInvoices.includes("Partly paid"),
    docInvoices.slice(0, 160)
  );

  await page.goto(`${BASE}/c/${slug}`);
  await page.waitForLoadState("networkidle");
  const docHome = await seen();
  check(
    "and the front page does not hand the same figure back",
    !docHome.includes("Revenue"),
    docHome.slice(0, 200)
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
    (await page.locator("text=You can't change your own access").count()) > 0
  );
  check(
    "and their own job select is disabled",
    await page.locator("select[disabled]").first().isVisible()
  );

  /* -------------------------------------- the switches carved out of others */
  await signIn(page, `clerk-${slug}@test.local`);
  const apiStatusOf = (url: string, init?: RequestInit) =>
    page.evaluate(
      async ([u, i]) => (await fetch(u as string, (i as RequestInit) ?? undefined)).status,
      [url, init ?? null] as const
    );

  const clerkClaims = await landsOn(page, `/c/${slug}/claims`, `/c/${slug}`);
  check("invoices without insurance: the claims screen is refused", clerkClaims === `/c/${slug}`, clerkClaims);
  check(
    "and so is the claims statement",
    (await apiStatusOf(`/api/c/${slug}/claims/export`)) === 403
  );
  const clerkInsurers = await landsOn(page, `/c/${slug}/settings/insurers`, `/c/${slug}`);
  check("settings without insurance: the insurance companies are refused", clerkInsurers === `/c/${slug}`, clerkInsurers);
  const clerkWa = await landsOn(page, `/c/${slug}/settings/whatsapp`, `/c/${slug}`);
  check("settings without WhatsApp: the WhatsApp tab is refused", clerkWa === `/c/${slug}`, clerkWa);
  check(
    "and so is its status endpoint",
    (await apiStatusOf(`/api/c/${slug}/whatsapp/status`)) === 403
  );
  check(
    "while the tab they were given opens",
    (await landsOn(page, `/c/${slug}/settings/services`)).endsWith("/settings/services")
  );
  const settingsTabs = (await page.locator("main nav").first().innerText()).replace(/\s+/g, " ");
  check(
    "and the settings strip offers only what opens",
    settingsTabs.includes("Services") && !settingsTabs.includes("WhatsApp") && !settingsTabs.includes("Insurance companies"),
    settingsTabs
  );

  /*
    The patient file: the insurer is withheld rather than undrawn, and the API
    refuses to set it while still saving the rest of the same autosave batch.
  */
  await page.goto(`${BASE}/c/${slug}/patients/${insuredId}`);
  await page.waitForLoadState("networkidle");
  const fileText = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
  check("a file does not name the insurer to them", !fileText.includes("QA Assurance"), fileText.slice(0, 160));
  // The merge lives in the file's ⋮ menu, so open it before saying it is absent.
  await page.getByRole("button", { name: "Actions", exact: true }).first().click();
  await page.waitForTimeout(300);
  check(
    "nor offer to merge it",
    (await page.getByRole("button", { name: "Merge records" }).count()) === 0
  );
  await page.keyboard.press("Escape");
  const patchResult = await page.evaluate(
    async ([s, id, ins]) => {
      const r = await fetch(`/api/c/${s}/patients/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: { insurer_id: null, insurance_no: "", full_name: "QA Insured Renamed" } }),
      });
      return { status: r.status, body: await r.json(), ins };
    },
    [slug, insuredId, insurerId] as const
  );
  check(
    "the API refuses to change who covers them",
    patchResult.body?.rejected?.insurer_id?.error === "forbidden" &&
      patchResult.body?.rejected?.insurance_no?.error === "forbidden",
    JSON.stringify(patchResult.body?.rejected)
  );
  const afterPatch = (
    await db.query(`select full_name, insurer_id, insurance_no from patients where id = $1`, [insuredId])
  ).rows[0];
  check(
    "the cover is untouched and the rest of the batch still saved",
    afterPatch.insurer_id === insurerId && afterPatch.insurance_no === "POL-1" && afterPatch.full_name === "QA Insured Renamed",
    JSON.stringify(afterPatch)
  );
  const cardUpload = await page.evaluate(
    async ([s, id]) => {
      const fd = new FormData();
      fd.append("file", new Blob(["x"], { type: "image/png" }), "card.png");
      fd.append("kind", "insurance_card");
      return (await fetch(`/api/c/${s}/patients/${id}/files`, { method: "POST", body: fd })).status;
    },
    [slug, insuredId] as const
  );
  check("a photo of the insurance card cannot be filed", cardUpload === 403, `status ${cardUpload}`);

  await page.goto(`${BASE}/c/${slug}/invoices/${claimInvoiceId}`);
  await page.waitForLoadState("networkidle");
  check(
    "an invoice opens without the void button",
    (await page.getByRole("button", { name: "Void invoice" }).count()) === 0
  );
  check(
    "and without the claim panel",
    (await page.getByRole("heading", { name: "Claim", exact: true }).count()) === 0
  );

  // Insurance and nothing else of the money section.
  await signIn(page, `insclerk-${slug}@test.local`);
  await page.goto(`${BASE}/c/${slug}`);
  await page.waitForLoadState("networkidle");
  const insNav = await navLabels();
  check("insurance alone still gets a Finance entry", insNav.some((n) => n.includes("Finance")), insNav.join(", "));
  check(
    "which opens on the claims",
    (await landsOn(page, `/c/${slug}/claims`)).endsWith("/claims")
  );
  check(
    "lists them",
    (await page.locator("main").first().innerText()).includes("QA-0001")
  );
  check(
    "offers the statement to somebody who works them",
    (await page.locator('main a[href*="/claims/export"]').count()) > 0
  );
  check(
    "but does not link into invoices they cannot open",
    (await page.locator(`main a[href="/c/${slug}/invoices/${claimInvoiceId}"]`).count()) === 0
  );
  const insInvoices = await landsOn(page, `/c/${slug}/invoices`, `/c/${slug}`);
  check("and the invoice list stays shut", insInvoices === `/c/${slug}`, insInvoices);

  /* --------------------------------------- the access editor on the way in */
  /*
    The invite form, driven the way a person drives it. Everything below this
    point was reported from production: choosing full access and then changing
    your mind left the screen stuck on full, so a new member could only ever be
    given everything.
  */
  await signIn(page, `owner-${slug}@test.local`);
  await page.goto(`${BASE}/c/${slug}/settings/staff`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add staff member" }).first().click();
  await page.waitForSelector("text=Access", { timeout: 10000 });

  // The capability list renders only on limited access, so its presence is the
  // level — read the way the person on the screen reads it.
  const onLimited = () => page.getByRole("switch", { name: "WhatsApp inbox" }).isVisible();
  const level = page.locator("button", { hasText: /^(Full access|Limited access)$/ });

  check("the invite form starts on limited access", await onLimited());

  await level.filter({ hasText: "Full access" }).first().click();
  await page.waitForTimeout(150);
  check("choosing full access hides the list", !(await onLimited()));

  await level.filter({ hasText: "Limited access" }).first().click();
  await page.waitForTimeout(150);
  check("and you can go back to limited access", await onLimited());

  /*
    Going full and back must not quietly widen the ticks. It used to replace
    them with *every* capability, so an owner who glanced at full access and
    changed their mind handed a new receptionist the staff screen.
  */
  /*
    The switch is on screen — a receptionist's defaults include Settings, so its
    actions are listed underneath. What matters is that it is still *off*: the
    editor used to answer the round trip by ticking every capability there is.
  */
  check(
    "the round trip does not tick what the job never had",
    (await page
      .getByRole("switch", { name: "Manage staff and their access" })
      .first()
      .getAttribute("aria-checked")) === "false"
  );

  /*
    And the other end of the same question: an owner who unticks everything gets
    a member with nothing. The server used to read an empty list as "no opinion"
    and substitute the job's defaults.
  */
  for (const section of ["Dashboard", "WhatsApp inbox", "Calendar", "Patients", "Documents", "Invoices", "Insurance", "Settings"]) {
    const sw = page.getByRole("switch", { name: section }).first();
    if ((await sw.count()) && (await sw.getAttribute("aria-checked")) === "true") await sw.click();
  }
  await page.getByLabel("Full name").first().fill("QA Nobody");
  await page.getByLabel("Email").first().fill(`nobody-${slug}@test.local`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForTimeout(1500);

  const nobody = await db.query(
    `select m.permissions from clinic_members m join users u on u.id = m.user_id
      where m.clinic_id = $1 and u.email = $2`,
    [clinic.id, `nobody-${slug}@test.local`]
  );
  check("a member invited with nothing ticked is stored", nobody.rowCount === 1);
  if (nobody.rowCount) {
    const stored = nobody.rows[0].permissions as { level: string; caps: Record<string, boolean> };
    check("stored as limited, not full", stored.level === "custom");
    check(
      "and with no capability granted",
      Object.values(stored.caps ?? {}).every((v) => v === false),
      JSON.stringify(stored.caps)
    );
  }

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

  /*
    Invoices no longer carries the clinic's takings with it, and this is the
    assertion that was reversed to make that true.

    It used to require the opposite: a stored map saying only `invoices: true`
    predated the split, so it had to keep the revenue tiles or every existing
    member would lose them on deploy. That reasoning was sound and the result
    was still wrong — a receptionist granted Invoices so they could take money
    at the desk silently also received the week's revenue, and nobody unticks a
    box they never knew was ticked. Granting it is now something somebody has to
    do on purpose.
  */
  const beforeSplit = resolveCapabilities(
    { level: "custom", caps: { invoices: true } },
    { isOwner: false, role: "receptionist" }
  );
  check("invoices alone does not hand over the clinic's takings", !beforeSplit["invoices.analytics"]);
  check("and still grants the invoices screen itself", beforeSplit.invoices);
  const explicitlyGranted = resolveCapabilities(
    { level: "custom", caps: { invoices: true, "invoices.analytics": true } },
    { isOwner: false, role: "receptionist" }
  );
  check("an owner can still grant it deliberately", explicitlyGranted["invoices.analytics"]);
  /*
    Full access is untouched on purpose: it means everything, the owner chose it
    for that person, and taking the takings out of it would be a different
    promise from the one the screen makes.
  */
  const fullAccess = resolveCapabilities({ level: "full" }, { isOwner: false, role: "doctor" });
  check("full access still includes them", fullAccess["invoices.analytics"]);
  // And the desk no longer starts with them.
  const deskDefaults = resolveCapabilities(null, { isOwner: false, role: "receptionist" });
  check("a receptionist does not start with the takings", !deskDefaults["invoices.analytics"]);
  check("but does start with invoices", deskDefaults.invoices);
  const explicitlyDenied = resolveCapabilities(
    { level: "custom", caps: { invoices: true, "invoices.analytics": false } },
    { isOwner: false, role: "receptionist" }
  );
  check("an explicit denial is still a denial", !explicitlyDenied["invoices.analytics"]);
  const noInvoices = resolveCapabilities(
    { level: "custom", caps: { invoices: false, "invoices.analytics": true } },
    { isOwner: false, role: "receptionist" }
  );
  check("and the totals cannot outlive the section", !noInvoices["invoices.analytics"]);

  // A row written before this model existed still behaves like it used to.
  const legacy = resolveCapabilities({ automations: true }, { isOwner: false, role: "receptionist" });
  check(
    "a pre-0014 row falls back to its job's set",
    legacy.conversations && legacy.invoices && legacy.automations && !legacy["settings.staff"]
  );

  /*
    The 2026-10-06 split. A row written before it says nothing about the new
    switches, and every one of them was possible for whoever held the wider
    switch — so silence inherits, and nobody loses anything on deploy.
  */
  const { withSection, capabilitiesFor, toAccessSetting, CAPABILITIES } = await import("../src/lib/permissions");
  const preSplit = resolveCapabilities(
    { level: "custom", caps: { patients: true, invoices: true, settings: true } },
    { isOwner: false, role: "receptionist" }
  );
  check(
    "a row from before the split keeps what it could already do",
    preSplit.insurance &&
      preSplit["insurance.claims"] &&
      preSplit["insurance.companies"] &&
      preSplit["invoices.void"] &&
      preSplit["patients.merge"] &&
      preSplit["settings.whatsapp"] &&
      preSplit["settings.services"],
    JSON.stringify(preSplit)
  );
  const toldNo = resolveCapabilities(
    { level: "custom", caps: { invoices: true, insurance: false } },
    { isOwner: false, role: "receptionist" }
  );
  check("an explicit no to insurance takes the claims with it", !toldNo.insurance && !toldNo["insurance.claims"]);
  const companiesWithoutSettings = resolveCapabilities(
    { level: "custom", caps: { insurance: true, "insurance.companies": true, settings: false } },
    { isOwner: false, role: "other" }
  );
  check("the insurance companies need Settings as well as Insurance", !companiesWithoutSettings["insurance.companies"]);
  const filesOnlyDoctor = resolveCapabilities(
    { level: "custom", caps: { patients: true } },
    { isOwner: false, role: "doctor" }
  );
  check("opening files does not bring insurance with it", !filesOnlyDoctor.insurance);

  const patientsOn = withSection(capabilitiesFor([]), "patients", true);
  check(
    "switching a section on switches on everything in it",
    patientsOn["patients.export"] && patientsOn["patients.merge"] && patientsOn["patients.import"]
  );
  const patientsOff = withSection(patientsOn, "patients", false);
  check("and off takes it all away", !patientsOff["patients.export"] && !patientsOff["patients.merge"]);
  const insuranceOnly = withSection(capabilitiesFor([]), "insurance", true);
  check(
    "an action that needs another section stays off until it has it",
    insuranceOnly["insurance.claims"] && !insuranceOnly["insurance.companies"]
  );
  const settingsOff = withSection(capabilitiesFor(["settings", "insurance", "insurance.companies"]), "settings", false);
  check("and loses it when that other section goes", !settingsOff["insurance.companies"] && settingsOff.insurance);
  const saved = toAccessSetting("custom", capabilitiesFor(["insurance"]));
  check(
    "a save writes every switch, so silence stops inheriting",
    CAPABILITIES.every((c) => typeof saved.caps[c] === "boolean")
  );

  // …and the settings screen must agree with that, or opening the row and
  // pressing save would quietly promote them to everything.
  const { accessLevelOf } = await import("../src/lib/permissions");
  check("and the screen calls that limited, not full", accessLevelOf({ automations: true }) === "custom");
  check("while an explicit full stays full", accessLevelOf({ level: "full" }) === "full");

  /* ------------------------------- every action names what authorises it */
  /*
    A server action is a public endpoint. The nav hides what a member may not
    reach and the page guards redirect them, but neither is standing between a
    request and the database — only the check inside the action is, and an
    action that calls `requireClinic` and stops there is protected by nothing
    but clinic membership.

    Read statically rather than by calling them: invoking one means recovering
    a build-specific action id out of the client bundle, which would tie this
    to Next's internals and rot. The question here is not whether one action
    behaves, it is whether *any* action was added without an answer — so the
    file is the right thing to read.
  */
  const actionAudit = auditServerActions();
  check(
    "every clinic server action checks a capability or is listed below",
    actionAudit.unexplained.length === 0,
    actionAudit.unexplained.map((a) => `${a.fn} (${a.file}:${a.line})`).join(", ")
  );
  /*
    The exceptions, and each one is authorised by *identity* instead — a
    stronger test than a capability, not a weaker one. Signing is bound to the
    signer row naming you; the rest write your own signature, your own PIN,
    your own notification settings, or release a lock you yourself hold.

    Listed by name so the list cannot quietly grow: a new action that belongs
    here is a decision somebody makes on purpose.
  */
  check(
    "and the identity-authorised exceptions are the ones we expect",
    actionAudit.exceptionsSeen === IDENTITY_AUTHORISED.length,
    `${actionAudit.exceptionsSeen} of ${IDENTITY_AUTHORISED.length} still present`
  );

  check("no page errors", errors.length === 0, errors.join(" | "));

  await browser.close();
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  // The invited one has no id here — the form made it — so it goes by address.
  await db.query(`delete from users where id = any($1::uuid[]) or email = $2`, [
    [ownerId, docId, recId, clerkId, insClerkId],
    `nobody-${slug}@test.local`,
  ]);
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
