/**
 * Proves the dashboard capability both ways: taken away it disappears and every
 * route into it forwards somewhere real; left alone it behaves as before.
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";

const BASE = "http://127.0.0.1:3100";
const SLUG = "rima-dental";
const DOCTOR = { email: "dr.omar@clinic.jo", password: "clinic1234" };

const PG = "postgres://postgres:postgres@127.0.0.1:5544/clinicos";

async function setPerms(perms: unknown) {
  const c = new Client({ connectionString: PG });
  await c.connect();
  await c.query("select set_config('app.is_admin','true',false)");
  await c.query(
    `update clinic_members cm set permissions = $2
     from users u where u.id = cm.user_id and u.email = $1`,
    [DOCTOR.email, JSON.stringify(perms)]
  );
  await c.end();
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', DOCTOR.email);
  await page.fill('input[name="password"]', DOCTOR.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
}

async function land(page: Page, path: string): Promise<string> {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.waitForURL((u) => new URL(u).pathname !== path, { timeout: 3000 }).catch(() => {});
  return new URL(page.url()).pathname;
}

const navKeys = (page: Page) =>
  page.$$eval("nav a[href]", (as) =>
    as.map((a) => new URL((a as HTMLAnchorElement).href).pathname).filter((p) => p.includes("/c/"))
  );

let pass = 0;
let fail = 0;
const ok = (c: boolean, l: string) => {
  c ? (pass++, console.log("  ✓ " + l)) : (fail++, console.log("  ✗ FAIL " + l));
};

(async () => {
  const b = await chromium.launch();

  // ---- with the dashboard, which is what every existing member resolves to
  await setPerms({ level: "custom", caps: { calendar: true, patients: true, documents: true } });
  {
    const page = await b.newPage();
    await login(page);
    console.log("\n[dashboard granted — the shape every current row has]");
    ok(new URL(page.url()).pathname === `/c/${SLUG}`, "login lands on the dashboard");
    ok((await land(page, `/c/${SLUG}`)) === `/c/${SLUG}`, "dashboard opens");
    ok((await navKeys(page)).includes(`/c/${SLUG}`), "dashboard is in the nav");
    await page.close();
  }

  // ---- taken away explicitly
  await setPerms({
    level: "custom",
    caps: { dashboard: false, calendar: true, patients: true, documents: true },
  });
  {
    const page = await b.newPage();
    await login(page);
    console.log("\n[dashboard removed]");
    const landed = new URL(page.url()).pathname;
    ok(landed !== `/c/${SLUG}`, `login does not land on the dashboard (went to ${landed})`);
    ok((await land(page, `/c/${SLUG}`)) !== `/c/${SLUG}`, "the dashboard URL forwards elsewhere");
    ok(!(await navKeys(page)).includes(`/c/${SLUG}`), "dashboard is gone from the nav");

    // The thing that would loop: a page they cannot open redirects to the
    // dashboard, which they also cannot open.
    const fromForbidden = await land(page, `/c/${SLUG}/settings`);
    ok(
      fromForbidden !== `/c/${SLUG}` && fromForbidden !== `/c/${SLUG}/settings`,
      `a forbidden page forwards past the dashboard (went to ${fromForbidden})`
    );
    ok((await land(page, `/c/${SLUG}/patients`)) === `/c/${SLUG}/patients`, "granted pages still open");
    await page.close();
  }

  // ---- the degenerate case: nothing at all
  await setPerms({ level: "custom", caps: { dashboard: false } });
  {
    const page = await b.newPage();
    await login(page);
    console.log("\n[no sections at all — must terminate, not loop]");
    ok(
      new URL(page.url()).pathname === `/c/${SLUG}/profile`,
      `lands on profile (went to ${new URL(page.url()).pathname})`
    );
    ok((await land(page, `/c/${SLUG}`)) === `/c/${SLUG}/profile`, "dashboard URL forwards to profile");
    await page.close();
  }

  // ---- leave the demo as it was
  await setPerms({ level: "custom", caps: { calendar: true, patients: true, documents: true } });

  await b.close();
  console.log(`\ndashboard capability: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("ERR:", (e as Error).message);
  process.exit(1);
});
