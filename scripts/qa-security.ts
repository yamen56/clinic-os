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
import { Client } from "pg";
import { sanitizeHtml } from "../src/lib/esign/render";

const BASE = process.env.APP_URL || "http://localhost:3000";
const SLUG = process.env.DEMO_SLUG || "rima-dental";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

/**
 * A superuser connection, for the one block that has to change a member's
 * access to test it. Superuser rather than the app role because the point is to
 * set up a fixture, not to exercise RLS — everything that exercises RLS in this
 * file goes through the browser.
 */
async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: PG });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

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

/** Signs in, and reports where the session actually came to rest. */
async function login(page: Page, email: string, password: string): Promise<string> {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  // The login action hands back a destination and the form does a full document
  // load, so waiting on the URL is what "signed in" means here.
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  /*
    Then settle. The action resolves the destination itself, so there should be
    nothing left to do — but a guard below a `loading.tsx` redirects on the
    client after the shell has painted, and reading the URL before that would
    report the hop rather than the destination.
  */
  const first = new URL(page.url()).pathname;
  await page.waitForURL((u) => new URL(u).pathname !== first, { timeout: 2500 }).catch(() => {});
  return new URL(page.url()).pathname;
}

/** Status of an API call carrying this session's cookies. */
function api(page: Page, path: string): Promise<number> {
  return page.evaluate(async (p) => (await fetch(p)).status, path);
}

/** Where a page navigation actually landed — guards redirect rather than 403. */
/**
 * Where you actually end up asking for a page.
 *
 * A guard that runs below a `loading.tsx` runs inside a Suspense boundary, so
 * by the time it calls `redirect()` the shell has already been flushed and there
 * are no headers left to put a 307 in. Next falls back to performing the
 * redirect on the client once React hydrates — the page still never renders
 * (the server component threw before producing any of it), it just arrives a
 * beat later. Reading the URL at `networkidle` therefore measures the flush
 * rather than the guard, and passes or fails on how warm the dev server is.
 *
 * So: give a client-side redirect a bounded moment to happen. Nothing is
 * loosened — a page that is genuinely allowed simply stays put and costs the
 * three seconds nothing.
 */
async function land(page: Page, path: string): Promise<string> {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page
    .waitForURL((u) => new URL(u).pathname !== path, { timeout: 3000 })
    .catch(() => {});
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

    /*
      Permissions-Policy, both halves.

      This shipped as `microphone=()`, which is not a stricter way of asking the
      person — it is a refusal on their behalf, and it meant voice notes could
      never record: the browser rejected getUserMedia without ever showing a
      prompt. So the microphone must be allowed to `self`, and everything the
      app genuinely never asks for must still be shut. Both are asserted,
      because the tempting "fix" in either direction breaks the other.
    */
    const pp = h["permissions-policy"] ?? "";
    ok(/microphone=\(self\)/.test(pp), `microphone is askable by this origin (${pp})`);
    ok(/camera=\(\)/.test(pp) && /geolocation=\(\)/.test(pp), "camera and location stay shut");

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

  // ------------------------------------ the dashboard, and the loop it can make
  /*
    The only block here that writes to the database, and it puts the row back
    afterwards. It has to: every other capability can be proved with the seeded
    people, but the dashboard's interesting case is the one nobody is seeded
    into — a member who does not have it.

    What is actually under test is not the hiding. It is that the app still has
    somewhere to send that person. The dashboard was the destination every guard
    in the workspace redirected to, so making it optional created the chance of
    a redirect that points at a page which redirects back. `landingPathIn` is
    what resolves it, and this is the assertion that keeps it honest.
  */
  {
    const doctorPerms = { level: "custom", caps: { calendar: true, patients: true, documents: true } };
    const setPerms = (perms: unknown) =>
      withDb((c) =>
        c.query(
          `update clinic_members cm set permissions = $2
           from users u where u.id = cm.user_id and u.email = $1`,
          [DOCTOR.email, JSON.stringify(perms)]
        )
      );

    try {
      await setPerms({ level: "custom", caps: { ...doctorPerms.caps, dashboard: false } });
      const page = await browser.newPage();
      const landed = await login(page, DOCTOR.email, DOCTOR.password);

      console.log("\n[dashboard] can be taken away without stranding anyone");
      ok(landed !== `/c/${SLUG}`, `login skips the dashboard (went to ${landed})`);
      ok((await land(page, `/c/${SLUG}`)) !== `/c/${SLUG}`, "the dashboard URL forwards on");
      ok(
        !(await page.$$eval("nav a[href]", (as) =>
          as.map((a) => new URL((a as HTMLAnchorElement).href).pathname)
        )).includes(`/c/${SLUG}`),
        "dashboard is gone from the nav"
      );
      // The one that would spin: a forbidden page redirects to the dashboard,
      // which this member also cannot open.
      const bounced = await land(page, `/c/${SLUG}/settings`);
      ok(
        bounced !== `/c/${SLUG}` && bounced !== `/c/${SLUG}/settings`,
        `a forbidden page forwards past the dashboard (went to ${bounced})`
      );
      await page.close();

      // Nothing at all: must terminate somewhere, and profile is the only
      // screen in a workspace with no capability in front of it.
      await setPerms({ level: "custom", caps: { dashboard: false } });
      const bare = await browser.newPage();
      ok(
        (await login(bare, DOCTOR.email, DOCTOR.password)) === `/c/${SLUG}/profile`,
        "a member with no sections lands on their profile rather than looping"
      );
      await bare.close();
    } finally {
      await setPerms(doctorPerms);
    }
  }

  // ------------------------------------------- the document HTML sanitiser
  /*
    Consent documents are rich text, stored as HTML, and rendered with
    `dangerouslySetInnerHTML` — to staff, and to patients on the signing page.
    It is the one place in the app where markup somebody else wrote becomes
    markup the browser executes, so `sanitizeHtml` is the guard that matters
    most and the one hardest to review by reading.

    Chromium is the oracle rather than a regex over the output: these are
    parser-mismatch bugs, where the sanitiser and the browser disagree about
    what a string means, and only one of them gets to be right. Each payload is
    sanitised, injected, and the DOM is asked whether an element, a live
    handler, or a dangerous URL survived — asked of the DOM, because
    `onclick=` also appears inside attribute values and inside escaped text,
    and a test that calls those handlers is a test nobody trusts twice.
  */
  {
    const payloads: [string, string][] = [
      ["plain script", `<script>window.__x=1</script>`],
      ["img onerror", `<img src=x onerror="window.__x=1">`],
      ["svg onload", `<svg onload="window.__x=1"></svg>`],
      ["nested script split", `<scr<script>ipt>window.__x=1</script>`],
      ["mXSS noscript", `<noscript><p title="</noscript><img src=x onerror=window.__x=1>"></noscript>`],
      ["javascript href", `<a href="javascript:window.__x=1">x</a>`],
      ["js href entity tab", `<a href="jav&#x09;ascript:window.__x=1">x</a>`],
      ["data href", `<a href="data:text/html,<script>parent.__x=1</script>">x</a>`],
      ["style url()", `<div style="background:url(javascript:window.__x=1)">x</div>`],
      ["template content", `<template><img src=x onerror=window.__x=1></template>`],
      ["details ontoggle", `<details open ontoggle="window.__x=1"></details>`],
      ["meta refresh", `<meta http-equiv="refresh" content="0;url=javascript:window.__x=1">`],
      /*
        The regression this block was written for. An unbalanced quote matches
        neither the tag shape nor anything else, and the sanitiser used to
        return such input verbatim — straight past the allowlist. It parsed
        inert, because the same broken quote swallows the handler into the href,
        but that is the browser being charitable rather than a guarantee.
      */
      ["unbalanced quote", `<a href="x onclick="window.__x=1">x</a>`],
      ["unbalanced quote img", `<img src="x onerror="window.__x=1">`],
    ];

    const page = await browser.newPage();
    await page.goto("about:blank");
    console.log("\n[sanitizer] document HTML cannot become document behaviour");

    for (const [label, raw] of payloads) {
      const verdict = await page.evaluate(async (html) => {
        (window as any).__x = 0;
        const host = document.createElement("div");
        document.body.innerHTML = "";
        document.body.appendChild(host);
        host.innerHTML = html;
        await new Promise((r) => setTimeout(r, 50));
        const nodes = [...host.querySelectorAll("*")];
        return {
          executed: (window as any).__x === 1,
          handler: nodes.some((n) =>
            ["onclick", "onmouseover", "onerror", "onload", "onfocus", "ontoggle"].some(
              (h) => typeof (n as any)[h] === "function"
            )
          ),
          element: nodes.some((n) =>
            ["SCRIPT", "IFRAME", "OBJECT", "EMBED", "SVG", "IMG", "FORM", "META", "BASE"].includes(
              n.tagName.toUpperCase()
            )
          ),
          badUrl: nodes.some((n) =>
            ["href", "src", "action", "data"].some((a) =>
              /^\s*(javascript|vbscript|data:text\/html)/i.test(n.getAttribute(a) ?? "")
            )
          ),
        };
      }, sanitizeHtml(raw));

      ok(
        !verdict.executed && !verdict.handler && !verdict.element && !verdict.badUrl,
        `neutralised: ${label}`
      );
    }
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
