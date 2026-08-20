/**
 * QA for the boundaries: who may call what, and what a stored file is allowed
 * to become when it is handed back to a browser.
 *
 * These are the two failures that do not look like failures. A missing
 * capability check on a route handler renders exactly like a working app —
 * the nav hides the section, so nobody clicks it, and the endpoint behind it
 * stays open to anyone who knows the URL. A file served under the content type
 * its uploader chose renders exactly like a working app too, right up until
 * the file is `text/html` and runs on our origin with the staff member's
 * session. Neither shows up in a screenshot, so both need assertions.
 *
 * Everything goes through the browser with a real session, because that is the
 * only thing that proves the whole chain — cookie, guard, capability map, RLS.
 * A unit test over `resolveCapabilities` proves the map is right and nothing
 * about whether anyone consults it.
 *
 * Needs the demo seed (`npm run seed`) and a server on APP_URL.
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.APP_URL || "http://localhost:3000";
const SLUG = process.env.DEMO_SLUG || "rima-dental";

/*
  The three seeded people, chosen because their access differs in the way the
  gates care about: the owner has everything, the receptionist has most of it
  explicitly, and the doctor is the one with real gaps — no conversations, no
  invoices, no settings. The doctor is the whole test; the other two are there
  to catch a gate that is too tight, which is the failure mode that takes a
  clinic's working day away.
*/
const OWNER = { email: "rima@clinic.jo", password: "clinic1234" };
const DOCTOR = { email: "dr.omar@clinic.jo", password: "clinic1234" };
const RECEPTION = { email: "reception@clinic.jo", password: "clinic1234" };

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL ${label}`);
  }
}

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  // The login action hands back a destination and the form does a full document
  // load, so waiting on the URL is what "signed in" means here.
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
}

/** Status of an API call carrying this session's cookies. */
function api(page: Page, path: string): Promise<number> {
  return page.evaluate(async (p) => (await fetch(p)).status, path);
}

/** Where a page navigation actually landed — guards redirect rather than 403. */
async function land(page: Page, path: string): Promise<string> {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  return new URL(page.url()).pathname;
}

async function main() {
  const browser = await chromium.launch();

  // ------------------------------------------------ capability gates: denied
  {
    const page = await browser.newPage();
    await login(page, DOCTOR.email, DOCTOR.password);

    console.log("\n[doctor] keeps what their access grants");
    ok((await land(page, `/c/${SLUG}/patients`)) === `/c/${SLUG}/patients`, "patients page opens");
    ok((await land(page, `/c/${SLUG}/calendar`)) === `/c/${SLUG}/calendar`, "calendar page opens");
    ok((await api(page, `/api/c/${SLUG}/patients/search?q=%D8%A7%D9%84`)) === 200, "patient search 200");
    ok(
      (await api(page, `/api/c/${SLUG}/appointments?from=2026-01-01&to=2026-12-31`)) === 200,
      "appointments 200"
    );

    console.log("[doctor] is refused what it does not");
    ok((await api(page, `/api/c/${SLUG}/conversations`)) === 403, "conversations API 403");
    ok((await api(page, `/api/c/${SLUG}/payments/export`)) === 403, "payments export 403");
    ok((await api(page, `/api/c/${SLUG}/whatsapp/status`)) === 403, "whatsapp status 403");
    ok((await land(page, `/c/${SLUG}/settings`)) !== `/c/${SLUG}/settings`, "settings page redirects away");
    await page.close();
  }

  // ----------------------------------------------- capability gates: allowed
  {
    const page = await browser.newPage();
    await login(page, RECEPTION.email, RECEPTION.password);
    console.log("\n[receptionist] is not caught by the new gates");
    ok((await api(page, `/api/c/${SLUG}/conversations`)) === 200, "conversations API 200");
    ok((await api(page, `/api/c/${SLUG}/payments/export`)) === 200, "payments export 200");
    ok((await api(page, `/api/c/${SLUG}/whatsapp/status`)) === 200, "whatsapp status 200");
    ok((await land(page, `/c/${SLUG}/settings`)) === `/c/${SLUG}/settings`, "settings page opens");
    ok((await land(page, `/c/${SLUG}/patients`)) === `/c/${SLUG}/patients`, "patients page opens");
    await page.close();
  }

  // -------------------------------------------- stored files cannot be pages
  {
    const page = await browser.newPage();
    await login(page, OWNER.email, OWNER.password);

    console.log("\n[owner] is unaffected");
    ok((await api(page, `/api/c/${SLUG}/conversations`)) === 200, "conversations API 200");
    ok(
      (await land(page, `/c/${SLUG}/settings/whatsapp`)) === `/c/${SLUG}/settings/whatsapp`,
      "whatsapp settings opens"
    );

    const patientId = await page.evaluate(async (slug) => {
      const r = await fetch(`/api/c/${slug}/patients/search?q=%D8%A7%D9%84`);
      return ((await r.json()).results ?? [])[0]?.id as string | undefined;
    }, SLUG);
    if (!patientId) throw new Error("no patient in the demo clinic to attach a file to");

    console.log("\n[uploads] a file cannot choose how it is rendered");
    // The mime type is the uploader's, and here the uploader is hostile.
    const htmlFileId = await page.evaluate(
      async ({ slug, pid }) => {
        const payload = '<script>document.title="XSS-EXECUTED"</' + 'script><h1>pwned</h1>';
        const fd = new FormData();
        fd.append("file", new File([payload], "report.html", { type: "text/html" }), "report.html");
        fd.append("kind", "other");
        const r = await fetch(`/api/c/${slug}/patients/${pid}/files`, { method: "POST", body: fd });
        return (await r.json()).file?.id as string | undefined;
      },
      { slug: SLUG, pid: patientId }
    );
    if (!htmlFileId) throw new Error("upload failed");

    const served = await page.evaluate(
      async ({ slug, id }) => {
        const r = await fetch(`/api/c/${slug}/files/${id}`);
        return {
          type: r.headers.get("content-type"),
          disposition: r.headers.get("content-disposition"),
          nosniff: r.headers.get("x-content-type-options"),
        };
      },
      { slug: SLUG, id: htmlFileId }
    );
    ok(!/text\/html/i.test(served.type ?? ""), "html upload is not served as text/html");
    ok(/octet-stream/i.test(served.type ?? ""), "html upload is served as octet-stream");
    ok(/^attachment/i.test(served.disposition ?? ""), "html upload is forced to attachment");
    ok(served.nosniff === "nosniff", "nosniff is set");

    // The headers are the mechanism; this is the actual claim.
    const probe = await browser.newPage();
    await probe.context().addCookies(await page.context().cookies());
    await probe
      .goto(`${BASE}/api/c/${SLUG}/files/${htmlFileId}`, { waitUntil: "domcontentloaded" })
      .catch(() => {
        /* a download rather than a navigation is exactly the point */
      });
    await probe.waitForTimeout(1500);
    ok((await probe.title()) !== "XSS-EXECUTED", "the script does not run on our origin");
    await probe.close();

    // And the other direction: a real scan must still open in the browser, or
    // the fix has quietly broken the reason these routes serve inline at all.
    const pngId = await page.evaluate(
      async ({ slug, pid }) => {
        const b64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const fd = new FormData();
        fd.append("file", new File([bytes], "scan.png", { type: "image/png" }), "scan.png");
        fd.append("kind", "xray");
        const r = await fetch(`/api/c/${slug}/patients/${pid}/files`, { method: "POST", body: fd });
        return (await r.json()).file?.id as string | undefined;
      },
      { slug: SLUG, pid: patientId }
    );
    const pngServed = await page.evaluate(
      async ({ slug, id }) => {
        const r = await fetch(`/api/c/${slug}/files/${id}`);
        return {
          type: r.headers.get("content-type"),
          disposition: r.headers.get("content-disposition"),
        };
      },
      { slug: SLUG, id: pngId }
    );
    ok(pngServed.type === "image/png", "a real PNG is still image/png");
    ok(/^inline/.test(pngServed.disposition ?? ""), "a real PNG is still inline");

    await page.close();
  }

  // ------------------------------------------------------- response headers
  {
    console.log("\n[headers] the app-wide policy is actually served");
    const page = await browser.newPage();
    const res = await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    const h = res?.headers() ?? {};
    ok(/frame-ancestors 'none'/.test(h["content-security-policy"] ?? ""), "CSP forbids framing");
    ok((h["x-content-type-options"] ?? "") === "nosniff", "nosniff on pages");
    ok((h["x-frame-options"] ?? "") === "DENY", "X-Frame-Options DENY");
    ok(/max-age=/.test(h["strict-transport-security"] ?? ""), "HSTS present");

    // The token pages are the ones where the URL is the credential.
    const signRes = await page.goto(`${BASE}/sign/definitely-not-a-real-token`, {
      waitUntil: "domcontentloaded",
    });
    ok(
      (signRes?.headers()["referrer-policy"] ?? "") === "no-referrer",
      "signing links never leak in a Referer"
    );
    await page.close();
  }

  await browser.close();
  console.log(`\nsecurity qa: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error("security qa failed:", (e as Error).message);
  process.exit(1);
});
