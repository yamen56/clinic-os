/**
 * "Every request a task makes should be doing something."
 *
 * Three ways the app used to do the same work twice, or crash doing none:
 *
 *  - A button that ran a server action and then called `router.refresh()`.
 *    An action that revalidates already brings the page back in its own
 *    response, so the refresh rendered every screen a second time — about
 *    seventy buttons, each click two full server renders.
 *  - The realtime stream answered every row event with a refetch. The triggers
 *    emit one per row, so a campaign or a busy afternoon had an open inbox
 *    fetching its list and thread once per message status, one after another.
 *  - A malformed id in a link — a truncated URL from a WhatsApp message — went
 *    straight into a uuid query, and Postgres refused it with an error: a crash
 *    screen and a 500 in the error feed instead of "not found".
 *
 * And two things on screen that were not what the classes said: buttons at the
 * page's 16px whatever their size, and a balance losing its currency to an
 * ellipsis on the dashboard.
 *
 * Needs the dev server (qa-warm first) and the local database.
 */
import { chromium, devices, type Page, type Request } from "playwright";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const BAD = "not-a-uuid";

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

/** Requests a page makes while `fn` runs and for `settleMs` after it. */
async function during(page: Page, fn: () => Promise<unknown>, settleMs = 3000) {
  const seen: Request[] = [];
  const on = (r: Request) => seen.push(r);
  page.on("request", on);
  await fn();
  await page.waitForTimeout(settleMs);
  page.off("request", on);
  return seen;
}

async function login(page: Page, email: string) {
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
  const slug = `qareq${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, timezone) values ('QA Requests','طلبات',$1,'Asia/Amman') returning id`,
      [slug]
    )
  ).rows[0];
  const email = `req-${slug}@test.local`;
  const user = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,'Req QA','en') returning id`,
      [email, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, user.id]
  );
  const service = (
    await db.query(
      `insert into services (clinic_id, name, duration_min, price) values ($1,'QA Cleaning',30,20) returning id`,
      [clinic.id]
    )
  ).rows[0];
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source)
       values ($1,'Request Patient','+962790000456','staff') returning id`,
      [clinic.id]
    )
  ).rows[0];
  // A five-figure balance: the size that used to lose its currency to the ellipsis.
  await db.query(
    `insert into invoices (clinic_id, patient_id, seq, number, status, subtotal, total, amount_paid)
     values ($1,$2,1,'INV-0001','sent',17472,17472,0)`,
    [clinic.id, patient.id]
  );
  const conversation = (
    await db.query(
      `insert into conversations (clinic_id, patient_id, phone_e164, last_message_at, last_message_preview)
       values ($1,$2,'+962790000456',now(),'hello') returning id`,
      [clinic.id, patient.id]
    )
  ).rows[0];
  console.log(`✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await login(page, email);

    /* ------------------------------------------- one click, one round trip */
    await page.goto(`${BASE}/c/${slug}/settings/services`, { waitUntil: "networkidle", timeout: 120_000 });
    // The service's own switch, not whichever setting happens to come first.
    const toggle = page.locator("main li", { hasText: "QA Cleaning" }).locator('[role="switch"]').first();
    await toggle.waitFor({ timeout: 60_000 });
    const reqs = await during(page, () => toggle.click());
    const actions = reqs.filter((r) => r.headers()["next-action"]);
    const refreshes = reqs.filter((r) => !r.headers()["next-action"] && r.headers()["rsc"] === "1");
    check("a toggle is one server action", actions.length === 1, `${actions.length}`);
    check("and no second render after it", refreshes.length === 0, refreshes.map((r) => r.url()).join(", "));
    const active = (await db.query(`select active from services where id = $1`, [service.id])).rows[0].active;
    check("the change reached the database", active === false);
    const dimmed = await page.locator("main li.opacity-50").count();
    check("and the page shows it without the extra render", dimmed === 1, `${dimmed} dimmed rows`);

    /* --------------------------------------------------- dashboard, desktop */
    await page.goto(`${BASE}/c/${slug}`, { waitUntil: "networkidle", timeout: 120_000 });
    const owed = page.getByText(/17,472\.00/).first();
    await owed.waitFor({ timeout: 60_000 });
    const fit = await owed.evaluate((el) => ({
      text: el.textContent ?? "",
      overflow: el.scrollWidth - el.clientWidth,
    }));
    check("a five-figure balance keeps its currency", /JOD/.test(fit.text), fit.text);
    check("and fits its tile without an ellipsis", fit.overflow <= 1, `${fit.overflow}px over`);

    const nested = await page.evaluate(
      () => document.querySelectorAll("a button, button a, a a, button button").length
    );
    check("no button sits inside a link", nested === 0, `${nested} nested controls`);

    const quick = await page.evaluate(() => {
      const a = document.querySelector<HTMLElement>('main a[href$="/calendar?new=1"]');
      return a ? getComputedStyle(a).fontSize : null;
    });
    check("a small action renders at its own 13px", quick === "13px", String(quick));
    const realButton = await page.evaluate(() => {
      const b = [...document.querySelectorAll<HTMLButtonElement>("button")].find((x) =>
        x.className.includes("text-[13px]")
      );
      return b ? getComputedStyle(b).fontSize : null;
    });
    check("and so does a real <button> with that class", realButton === "13px", String(realButton));

    /* --------------------------------------------------- realtime, batched */
    // Not networkidle: the inbox holds its event stream open, so the network never goes quiet.
    await page.goto(`${BASE}/c/${slug}/conversations`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.getByText("Request Patient").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500); // the stream is open before the burst starts
    const listCalls = (rs: Request[]) =>
      rs.filter((r) => r.method() === "GET" && new URL(r.url()).pathname === `/api/c/${slug}/conversations`);
    const burst = await during(
      page,
      async () => {
        for (let i = 0; i < 30; i++) {
          await db.query(`update conversations set last_message_preview = $2 where id = $1`, [
            conversation.id,
            `burst ${i}`,
          ]);
        }
      },
      3500
    );
    const n = listCalls(burst).length;
    check("thirty row events refetch the list at most a few times", n >= 1 && n <= 3, `${n} fetches`);
    check("and the list ends on the last change", (await page.locator("body").innerText()).includes("burst 29"));

    const typed = await during(
      page,
      () => page.locator('input[type="search"], input[placeholder]').first().pressSequentially("Request", { delay: 40 }),
      1200
    );
    const searches = listCalls(typed).filter((r) => new URL(r.url()).searchParams.has("q"));
    check("a name typed at speed is one search", searches.length <= 2, `${searches.length} searches`);

    // A stream that asked for patients, while a conversation and a patient change.
    const filtered = page.evaluate(async (s) => {
      const got: string[] = [];
      const es = new EventSource(`/api/c/${s}/events?t=patients`);
      es.onmessage = (ev) => got.push(JSON.parse(ev.data).t);
      await new Promise((r) => setTimeout(r, 4000));
      es.close();
      return got;
    }, slug);
    await page.waitForTimeout(1500);
    await db.query(`update conversations set last_message_preview = 'filtered' where id = $1`, [conversation.id]);
    await db.query(`update patients set full_name = 'Request Patient' where id = $1`, [patient.id]);
    const tables = await filtered;
    check("a tab only receives the tables it asked for", !tables.includes("conversations"), tables.join(","));
    check("and does receive those", tables.includes("patients"), tables.join(","));

    /* ------------------------------------------ a bad link is "not found" */
    /*
      The status is not the test. Each screen streams its own skeleton first,
      so the 200 has been sent before the page can say the record is missing;
      what matters is which screen the person lands on — "we can't find this
      page" with the sidebar still there, not the crash screen.
    */
    for (const path of [`/c/${slug}/patients/${BAD}`, `/c/${slug}/invoices/${BAD}`, `/c/${slug}/documents/${BAD}`]) {
      await page.goto(BASE + path, { timeout: 120_000 });
      await page.getByText("We can't find this page").first().waitFor({ timeout: 30_000 }).catch(() => {});
      const body = await page.locator("body").innerText();
      const crashed = (await page.locator("svg.lucide-cloud-off").count()) > 0;
      check(
        `${path.replace(slug, "…")} says not found, not a crash`,
        body.includes("We can't find this page") && !crashed,
        crashed ? "crash screen" : body.slice(0, 80).replace(/\s+/g, " ")
      );
      check(`and keeps the workspace around it`, (await page.locator(`a[href="/c/${slug}"]`).count()) > 0);
    }
    for (const path of [`/c/${slug}/calendar?patient=${BAD}`, `/c/${slug}/invoices/new?patient=${BAD}`]) {
      await page.goto(BASE + path, { timeout: 120_000 });
      await page.waitForTimeout(800);
      const crashed = (await page.locator("svg.lucide-cloud-off").count()) > 0;
      check(`${path.replace(slug, "…")} opens, ignoring the bad id`, !crashed);
    }
    for (const [path, want] of [
      [`/api/c/${slug}/files/${BAD}`, 404],
      [`/api/c/${slug}/conversations/${BAD}`, 404],
      [`/api/c/${slug}/invoices/${BAD}/pdf`, 404],
      [`/api/c/${slug}/staff/${BAD}/photo`, 404],
      [`/api/c/${slug}/appointments?from=${BAD}&to=${BAD}`, 400],
    ] as const) {
      const r = await page.request.get(BASE + path);
      check(`${path.replace(slug, "…")} answers ${want}`, r.status() === want, String(r.status()));
    }
  } finally {
    await page.close();
  }

  /* ----------------------------------------------------------- on a phone */
  const phone = await browser.newContext({ ...devices["iPhone 13"] });
  const pp = await phone.newPage();
  try {
    await login(pp, email);
    await pp.goto(`${BASE}/c/${slug}`, { waitUntil: "networkidle", timeout: 120_000 });
    const tabs = await pp.evaluate(() => {
      const nav = document.querySelector("nav.fixed");
      const link = nav?.querySelector("a");
      const more = nav?.querySelector("button[aria-expanded]");
      return {
        link: link ? getComputedStyle(link).fontSize : null,
        more: more ? getComputedStyle(more).fontSize : null,
      };
    });
    check("the More tab is the size of the tabs beside it", !!tabs.more && tabs.more === tabs.link, `${tabs.more} vs ${tabs.link}`);

    await pp.goto(`${BASE}/c/${slug}/calendar`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await pp.getByRole("button", { name: "Day", exact: true }).waitFor({ timeout: 60_000 });
    const dayActive = await pp.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Day");
      return b?.className.includes("shadow-card") ?? false;
    });
    check("a phone opens the calendar on the day", dayActive);
  } finally {
    await phone.close();
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = $1`, [user.id]);
    await db.end();
  }

  console.log(`\n  requests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
