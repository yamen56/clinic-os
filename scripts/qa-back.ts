/**
 * Back buttons: where they appear, where they lead, and that a phone gets one
 * it can reach.
 *
 * Back goes to the page this tab was on before (lib/nav-trail), and up one
 * level when there is none. Sections the nav leads to have no Back at all.
 *
 * Needs the stack running: npm run dev:all — and warm (qa-warm) first.
 */
try {
  process.loadEnvFile?.();
} catch {
  /* rely on the real environment */
}

import { chromium, devices, type Page } from "playwright";

const BASE = process.env.APP_URL || "http://localhost:3000";
const SLUG = "rima-dental";
const C = `/c/${SLUG}`;
const OWNER = { email: "rima@clinic.jo", password: "clinic1234" };
const ADMIN = { email: "admin@makan.agency", password: "admin1234" };

let passed = 0;
const failures: string[] = [];
function check(cond: unknown, label: string, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`✓ ${label}`);
  } else {
    failures.push(`${label}${detail !== undefined ? ` — ${String(detail)}` : ""}`);
    console.log(`✗ ${label}${detail !== undefined ? ` — ${String(detail)}` : ""}`);
  }
}

async function login(page: Page, who: { email: string; password: string }) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', who.email);
  await page.fill('input[name="password"]', who.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30000, waitUntil: "commit" });
  // Sign-in applies the account's language; the labels below are asserted in English.
  await page.context().addCookies([{ name: "cos_locale", value: "en", url: BASE }]);
}

/**
 * Hydrated and recorded: the trail holds this page. networkidle never comes —
 * the shell keeps a live connection open — and the Back href is only final
 * once the recorder has run.
 */
async function settle(page: Page) {
  await page.waitForFunction(
    // The newest entry, exactly: an older visit to the same address must not count.
    `(JSON.parse(sessionStorage.getItem("clinicti.trail") || "[]").slice(-1)[0] || "") === location.pathname + location.search`,
    undefined,
    { timeout: 180000 }
  );
  await page.waitForTimeout(100);
}

async function go(page: Page, path: string) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await settle(page);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
}

/** The visible Back control, by where it lives: `main` on a desktop, the top bar on a phone. */
async function back(page: Page, where: "main" | "header") {
  const el = page.locator(`${where} a[data-back]`).first();
  const visible = await el.isVisible().catch(() => false);
  if (!visible) return null;
  const href = (await el.getAttribute("href")) ?? "";
  const text = ((await el.innerText().catch(() => "")) || "").trim();
  return { el, href, path: href.split("?")[0], text, aria: (await el.getAttribute("aria-label")) ?? "" };
}

async function firstHref(page: Page, selector: string) {
  return page.locator(selector).first().getAttribute("href");
}

async function main() {
  const browser = await chromium.launch();

  // ------------------------------------------------------------ desktop
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, OWNER);

    for (const root of ["", "/patients", "/calendar", "/invoices", "/documents", "/settings", "/settings/hours", "/conversations"]) {
      await go(page, `${C}${root}`);
      check((await back(page, "main")) === null, `no Back on a section page · ${root || "/ (dashboard)"}`);
    }

    // List → patient: Back names the list and returns to it.
    await go(page, `${C}/patients`);
    const patientHref = await firstHref(page, `main a[href^="${C}/patients/"]:not([href$="/import"])`);
    check(!!patientHref, "the patient list links to a patient file", patientHref);
    await page.click(`main a[href="${patientHref}"]`);
    await page.waitForURL(`**${patientHref}`, { timeout: 180000 });
    await settle(page);
    let b = await back(page, "main");
    check(b?.path === `${C}/patients`, "patient file from the list: Back goes to the list", b?.href);
    check(b?.text === "Patients", "…and says where", b?.text);
    await b!.el.click();
    await page.waitForURL((u) => u.pathname === `${C}/patients`, { timeout: 60000 });
    check(true, "clicking Back lands on the patient list");

    // Calendar → patient: Back returns to the calendar, not the list.
    await go(page, `${C}/calendar`);
    await go(page, patientHref!);
    b = await back(page, "main");
    check(b?.path === `${C}/calendar`, "patient file from the calendar: Back goes to the calendar", b?.href);
    check(b?.text === "Appointments", "…and is labelled Appointments", b?.text);

    // Patient → new invoice: Back returns to that patient, not the invoice list.
    const patientId = patientHref!.split("/").pop();
    await go(page, `${C}/invoices/new?patient=${patientId}`);
    b = await back(page, "main");
    check(b?.path === patientHref, "new invoice from a patient: Back goes to the patient", b?.href);
    check(b?.text === "Back", "…labelled Back (a patient is not a section)", b?.text);

    // A filter in the query survives the round trip.
    await go(page, `${C}/patients?q=a`);
    await go(page, patientHref!);
    b = await back(page, "main");
    check(b?.href === `${C}/patients?q=a`, "Back to a filtered list keeps the filter", b?.href);

    // To the list from the nav, then the same patient again: that is a step
    // forward, not a Back, so the patient's Back is the list.
    await page.click(`aside a[href="${C}/patients"]`);
    await page.waitForURL((u) => u.pathname === `${C}/patients`, { timeout: 60000 });
    await settle(page);
    const readTrail = async () => String(await page.evaluate(`sessionStorage.getItem("clinicti.trail")`));
    const atList = await readTrail();
    await page.click(`main a[href="${patientHref}"]`);
    await page.waitForURL(`**${patientHref}`, { timeout: 60000 });
    await settle(page);
    b = await back(page, "main");
    check(b?.path === `${C}/patients`, "patient → list from the nav → same patient: Back is the list", b?.href);

    // The browser's own Back drops the page it leaves, like ours.
    await page.goBack();
    await page.waitForURL((u) => u.pathname === `${C}/patients`, { timeout: 60000 });
    await settle(page);
    const afterBack = await readTrail();
    check(
      afterBack === atList,
      "browser Back pops the trail back to what it was at the list",
      `${atList.slice(-160)}  vs  ${afterBack.slice(-160)}`
    );

    // Settings template: a tab of Settings has no Back, the editor under it does.
    await go(page, `${C}/settings/documents`);
    const tplHref = await firstHref(page, `main a[href^="${C}/settings/documents/"]`);
    if (tplHref) {
      await go(page, tplHref);
      b = await back(page, "main");
      check(b?.path === `${C}/settings/documents`, "template editor: Back goes to the templates tab", b?.href);
      check(b?.text === "Settings", "…labelled Settings", b?.text);
    } else {
      console.log("· no document template to open — skipped");
    }

    // Pages off the avatar and the bell.
    for (const p of ["/profile", "/notifications", "/signature"]) {
      await go(page, `${C}/calendar`);
      await go(page, `${C}${p}`);
      b = await back(page, "main");
      check(b?.path === `${C}/calendar`, `${p}: Back goes to where it was opened from`, b?.href);
    }
    check(errors.length === 0, "no page errors on desktop", errors.join(" | "));
    await ctx.close();
  }

  // ------------------------------------------------------- fresh tab, deep link
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await login(page, OWNER);
    await go(page, `${C}/invoices`);
    const invHref = await firstHref(page, `main a[href^="${C}/invoices/"]:not([href*="/new"])`);
    // A brand-new tab: nothing before it, so Back goes up a level.
    const fresh = await ctx.newPage();
    if (invHref) {
      await go(fresh, invHref);
      const b = await back(fresh, "main");
      check(b?.path === `${C}/invoices`, "invoice opened in a new tab: Back goes up to Invoices", b?.href);
      check(b?.text === "Invoices", "…labelled Invoices", b?.text);
    } else {
      console.log("· no invoice to open — skipped");
    }
    // Another clinic's page is never a Back target: the trail is scoped to this workspace.
    await fresh.evaluate(`sessionStorage.setItem("clinicti.trail", JSON.stringify(["/c/some-other-clinic/calendar"]))`);
    await go(fresh, `${C}/profile`);
    const b = await back(fresh, "main");
    check(!!b && !b.path.startsWith("/c/some-other-clinic"), "Back never leads into another clinic", b?.href);
    await ctx.close();
  }

  // ------------------------------------------------------------------ phone
  {
    const ctx = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, OWNER);

    await go(page, `${C}/patients`);
    check((await back(page, "header")) === null, "phone: no Back in the top bar on a section");
    const patientHref = await firstHref(page, `main a[href^="${C}/patients/"]:not([href$="/import"])`);
    await page.click(`main a[href="${patientHref}"]`);
    await page.waitForURL(`**${patientHref}`, { timeout: 180000 });
    await settle(page);
    const b = await back(page, "header");
    check(b?.path === `${C}/patients`, "phone: patient file has Back in the top bar", b?.href);
    check(/Patients/.test(b?.aria ?? ""), "…announced as Back: Patients", b?.aria);
    const box = await b?.el.boundingBox();
    check(!!box && box.width >= 40 && box.height >= 40, "…at a 40px tap target", box && `${box.width}×${box.height}`);
    check(!(await page.locator("main a[data-back]").first().isVisible()), "phone: no second Back above the page");

    // Pinned: still there after scrolling the page.
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    await page.waitForTimeout(200);
    const pinned = await page.locator("header a[data-back]").first().boundingBox();
    check(!!pinned && pinned.y >= 0 && pinned.y < 80, "phone: Back stays in reach after scrolling", pinned && `y=${pinned.y}`);

    const over = Number(await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"));
    check(over <= 1, "phone: patient file does not scroll sideways", `${over}px`);

    await page.locator("header a[data-back]").first().tap();
    await page.waitForURL((u) => u.pathname === `${C}/patients`, { timeout: 60000 });
    check(true, "phone: tapping Back lands on the list");

    // The inbox thread: an arrow back to the list.
    await go(page, `${C}/conversations`);
    // A row of the list: a full-width button with a rule under it.
    const firstThread = page.locator("main button.border-b").first();
    const hasThread = await firstThread.waitFor({ timeout: 30000 }).then(() => true, () => false);
    const threadBack = page.locator("button[data-back]").first();
    if (hasThread) {
      await firstThread.click();
      await threadBack.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
      const tb = await threadBack.boundingBox();
      check(!!tb && tb.width >= 40, "phone: an open thread has a 40px back arrow", tb && `${tb.width}×${tb.height}`);
      await threadBack.tap();
      await page.waitForTimeout(300);
      check(!(await threadBack.isVisible().catch(() => false)), "phone: the arrow returns to the list");
    } else {
      console.log("· no conversation to open — skipped");
    }

    // Arabic: the arrow points the way the page reads.
    await ctx.addCookies([{ name: "cos_locale", value: "ar", url: BASE }]);
    await go(page, patientHref!);
    const dir = await page.evaluate("document.documentElement.dir");
    const ar = await back(page, "header");
    check(!!ar, "phone, Arabic: Back is there", dir);
    if (ar) {
      const box2 = await ar.el.boundingBox();
      const vw = page.viewportSize()!.width;
      if (dir === "rtl") check(!!box2 && box2.x > vw / 2, "phone, Arabic: Back sits on the right, where the page starts", box2 && `x=${box2.x}`);
    }

    check(errors.length === 0, "no page errors on the phone", errors.join(" | "));
    await ctx.close();
  }

  // ------------------------------------------------------------------ admin
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await login(page, ADMIN);
    await go(page, "/admin");
    check((await back(page, "main")) === null, "admin: no Back on the clinic list");
    const clinicHref = await firstHref(page, 'main a[href^="/admin/clinics/"]:not([href$="/new"])');
    if (clinicHref) {
      await page.click(`main a[href="${clinicHref}"]`);
      await page.waitForURL(`**${clinicHref}`, { timeout: 180000 });
      await settle(page);
      const b = await back(page, "main");
      check(b?.path === "/admin", "admin: a clinic's page has Back to the list", b?.href);
      check(b?.text === "Clinics", "…labelled Clinics", b?.text);
    }
    await go(page, "/admin/analytics");
    check((await back(page, "main")) === null, "admin: no Back on a tab");
    await ctx.close();
  }

  await browser.close();
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
