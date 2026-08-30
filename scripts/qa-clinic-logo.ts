/**
 * The clinic's own logo, once they have uploaded one.
 *
 * Two places have to show it, and until now neither did: the square in the
 * settings form where it is chosen, and the circle beside the clinic name in
 * the sidebar, which drew initials whether or not a logo existed.
 *
 * The interesting part is not that an <img> renders. It is that the picture on
 * screen is the file just uploaded — the route that serves it caches for five
 * minutes, so a clinic replacing their logo is exactly the person most likely
 * to be shown the previous one.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
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
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });
}

/** Did the browser actually decode this image, or is it a broken square? */
const loaded = (page: Page, selector: string) =>
  page.$eval(selector, (el) => {
    const img = el as HTMLImageElement;
    return img.complete && img.naturalWidth > 0;
  });

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const stamp = Date.now().toString(36);
  const slug = `qalogo${stamp}`;
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, invoice_prefix)
       values ('QA Logo','شعار',$1,'ar','Asia/Amman','JOD','QL') returning id`,
      [slug]
    )
  ).rows[0].id as string;
  const uid = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,'QA Owner','ar') returning id`,
      [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0].id as string;
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinicId, uid]
  );

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const settings = `${BASE}/c/${slug}/settings`;
  const logoImg = 'img[alt="الشعار"]';
  const sidebarLogo = 'aside img[src*="clinic-logo"]';

  try {
    await signIn(page, `owner-${slug}@test.local`);

    /* ================================================== before any upload */
    console.log("\n[before a logo exists]");
    await page.goto(settings);
    await page.waitForLoadState("networkidle");
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    check("the settings square is empty, not broken", (await page.locator(logoImg).count()) === 0, "");
    check(
      "and the sidebar shows initials rather than a missing image",
      (await page.locator(sidebarLogo).count()) === 0,
      ""
    );

    /* ================================================== uploading one */
    console.log("\n[uploading a logo]");
    await page.setInputFiles('input[type="file"]', "public/assets/mark-light.png");
    await page.waitForSelector(logoImg, { timeout: 30_000 });
    check("it appears where it was uploaded", await loaded(page, logoImg), "");

    const dbPath = (
      await db.query(`select logo_path from clinics where id = $1`, [clinicId])
    ).rows[0].logo_path as string | null;
    check("and it is actually stored", !!dbPath, dbPath ? "logo_path set" : "still null");

    /* ================================================== the sidebar */
    console.log("\n[beside the clinic name]");
    await page.goto(`${BASE}/c/${slug}/patients`);
    await page.waitForLoadState("networkidle");
    await page.waitForSelector(sidebarLogo, { timeout: 30_000 });
    check("the sidebar shows the logo", await loaded(page, sidebarLogo), "");
    check(
      "layered over the initials, so a failed load is not a hole",
      (await page.locator("aside").first().innerText()).includes("QA Logo") ||
        (await page.locator("aside").first().innerText()).includes("شعار"),
      ""
    );

    /*
      The route caches for five minutes. If the URL did not change with the
      file, replacing a logo would show the old one for the whole of it — which
      is the one moment a clinic is looking straight at the square.
    */
    const src = await page.getAttribute(sidebarLogo, "src");
    check("the URL is keyed to the stored file", /\?v=/.test(src ?? ""), src ?? "");

    /* ================================================== replacing it */
    console.log("\n[replacing it with a different one]");
    const firstSrc = src;
    await page.goto(settings);
    await page.waitForLoadState("networkidle");
    await page.setInputFiles('input[type="file"]', "public/assets/logo-mark-wide.png");
    await page.waitForTimeout(2500);
    check("the square shows the new file", await loaded(page, logoImg), "");

    await page.goto(`${BASE}/c/${slug}/patients`);
    await page.waitForLoadState("networkidle");
    await page.waitForSelector(sidebarLogo, { timeout: 30_000 });
    const secondSrc = await page.getAttribute(sidebarLogo, "src");
    check(
      "and the sidebar asks for a URL nothing has cached",
      !!secondSrc && secondSrc !== firstSrc,
      `${firstSrc?.split("?")[1]} → ${secondSrc?.split("?")[1]}`
    );
    check("which loads", await loaded(page, sidebarLogo), "");

    /* ================================================== who may change it */
    console.log("\n[who may change it]");
    const staffId = (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1,$2,'QA Staff','ar') returning id`,
        [`staff-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
      )
    ).rows[0].id as string;
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, permissions)
       values ($1,$2,'receptionist',$3)`,
      [clinicId, staffId, JSON.stringify({ level: "custom", caps: { settings: true } })]
    );
    const staffCtx = await browser.newContext();
    const staffPage = await staffCtx.newPage();
    await signIn(staffPage, `staff-${slug}@test.local`);
    await staffPage.goto(settings);
    await staffPage.waitForLoadState("networkidle");
    check(
      "somebody without settings.clinic still sees the logo",
      (await staffPage.locator(logoImg).count()) === 1,
      ""
    );
    check(
      "but is not offered the upload",
      (await staffPage.locator('input[type="file"]').count()) === 0,
      ""
    );
    await staffCtx.close();
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
