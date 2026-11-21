/**
 * The workspace is a touch smaller on a tablet or a desktop, and nowhere else.
 *
 * Yamen, 2026-11-21: "make the sizes a little smaller so you can see more data
 * on the screen". Since then the root is 93.75% (15px) when `data-density` is
 * on <html>, which the theme boot script and ThemeScope set on /c and /admin.
 *
 * What must not move with it:
 *  - a phone: doctors run their day on one, so buttons stay a thumb's height
 *    and inputs stay 16px (below that iOS zooms in on focus);
 *  - a patient's page — booking, an invoice, signing, a print — which is a
 *    document designed at one size;
 *  - sign-in, which is not the workspace yet.
 * And nothing should end up below 10px.
 */
import { chromium, devices, type Page } from "playwright";
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

const root = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);

async function go(page: Page, path: string) {
  await page.goto(`${BASE}${path}`, { timeout: 120_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(600);
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000, waitUntil: "commit" });
}

/** The smallest rendered text on the page, ignoring empty and hidden boxes. */
const smallestText = (page: Page) =>
  page.evaluate(`(() => {
    let min = Infinity, what = "";
    for (const el of document.querySelectorAll("main *, aside *")) {
      if (!el.childNodes.length) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const fs = parseFloat(cs.fontSize);
      if (fs < min) { min = fs; what = el.tagName + " " + (el.className || "").toString().slice(0, 60) + " «" + el.textContent.trim().slice(0, 20) + "»"; }
    }
    return { min, what };
  })()`) as Promise<{ min: number; what: string }>;

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qadens${Date.now().toString(36)}`;
  const clinic = (
    await db.query(`insert into clinics (name, name_ar, slug) values ('QA Density','كثافة',$1) returning id`, [slug])
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  await db.query(`insert into booking_links (clinic_id, slug, min_notice_min) values ($1, $2, 60)`, [clinic.id, slug]);
  const email = `owner-${slug}@test.local`;
  const user = (
    await db.query(`insert into users (email, password_hash, full_name) values ($1,$2,'QA Density') returning id`, [
      email,
      bcrypt.hashSync("password123", 10),
    ])
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, user.id]
  );

  const browser = await chromium.launch();
  try {
    console.log("\n— desktop, 1440");
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const d = await desk.newPage();
    await go(d, "/login");
    check("sign-in keeps the full size", (await root(d)) === "16px", await root(d));
    await signIn(d, email, "password123");
    for (const p of ["", "/patients", "/settings"]) {
      await go(d, `/c/${slug}${p}`);
      const r = await root(d);
      check(`the workspace is compact on /c/…${p || "/"}`, r === "15px", r);
    }
    const small = await smallestText(d);
    check("no text below 10px", small.min >= 10, `${small.min}px ${small.what}`);
    const width = await d.evaluate(() => document.querySelector("main")?.getBoundingClientRect().width ?? 0);
    check("the page column is not narrower than before", width >= 1100, `${Math.round(width)}px`);

    // Out to a patient's page from the workspace: the attribute must come off with the theme.
    await go(d, `/book/${slug}`);
    check("a booking page keeps the full size", (await root(d)) === "16px", await root(d));
    await go(d, "/inv/warmup");
    check("an invoice page keeps the full size", (await root(d)) === "16px", await root(d));
    await go(d, "/sign/warmup");
    check("a signing page keeps the full size", (await root(d)) === "16px", await root(d));
    await desk.close();

    console.log("\n— agency panel, 1440");
    const adm = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const a = await adm.newPage();
    await signIn(a, "admin@makan.agency", "admin1234");
    await go(a, "/admin");
    check("the agency panel is compact", (await root(a)) === "15px", await root(a));
    await adm.close();

    console.log("\n— iPhone 13");
    const phone = await browser.newContext({ ...devices["iPhone 13"] });
    const ph = await phone.newPage();
    await signIn(ph, email, "password123");
    await go(ph, `/c/${slug}/patients`);
    check("a phone keeps the full size", (await root(ph)) === "16px", await root(ph));
    const input = await ph.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>("main input");
      return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    });
    check("phone inputs stay at 16px, so iOS does not zoom", input >= 16, `${input}px`);
    const btn = await ph.evaluate(() => {
      const b = document.querySelector<HTMLElement>("main button");
      return b ? b.getBoundingClientRect().height : 0;
    });
    check("phone buttons stay a thumb's height", btn >= 40, `${btn}px`);
    await phone.close();

    console.log("\n— iPad landscape, 1024");
    const tab = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const t = await tab.newPage();
    await signIn(t, email, "password123");
    await go(t, `/c/${slug}`);
    check("a tablet is compact too", (await root(t)) === "15px", await root(t));
    await tab.close();
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = $1`, [user.id]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
