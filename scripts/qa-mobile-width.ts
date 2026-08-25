/**
 * Nothing on a phone may scroll sideways.
 *
 * The symptom reported was that "the view becomes wider" on certain pages —
 * which is what horizontal overflow looks like to someone using the app: the
 * layout zooms out or drifts, and the whole page feels a different size from the
 * one before it. One element wider than the viewport does it, and because the
 * page still renders it is easy to ship and hard to notice.
 *
 * So this measures rather than eyeballs: every listed page is loaded at phone
 * width and asked whether the document scrolls horizontally. When it does, the
 * offending elements are named, because "invoices is broken" is not something
 * you can fix and "the table inside .card is 520px" is.
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
/*
  Two widths, because 390 alone let real breakage through. 320 is an iPhone SE
  and the narrowest screen still in use; a layout that holds there holds
  everywhere, and several rows that fit inside 390 by a few pixels do not.
*/
const WIDTHS = [320, 390];
const PHONE = { width: 390, height: 844 };

let passed = 0;
const failures: string[] = [];

type Offender = { tag: string; cls: string; width: number; right: number; text: string };

async function overflow(page: Page): Promise<{ scrollW: number; clientW: number; who: Offender[] }> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const clientW = doc.clientWidth;
    const who: Offender[] = [];
    if (doc.scrollWidth > clientW + 1) {
      for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Something is only to blame if it sticks out AND is not inside a
        // container that was deliberately made scrollable.
        if (r.right <= clientW + 1 && r.left >= -1) continue;
        let scrollable = false;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const ov = getComputedStyle(p).overflowX;
          if (ov === "auto" || ov === "scroll") {
            scrollable = true;
            break;
          }
        }
        if (scrollable) continue;
        who.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.getAttribute("class") ?? "").slice(0, 90),
          width: Math.round(r.width),
          right: Math.round(r.right),
          text: (el.textContent ?? "").trim().slice(0, 40),
        });
      }
    }
    // Innermost first: the deepest element that sticks out is the real cause,
    // its ancestors are just carrying it.
    who.sort((a, b) => b.right - a.right);
    return { scrollW: doc.scrollWidth, clientW, who: who.slice(0, 4) };
  });
}

async function checkPage(page: Page, label: string, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(250);
  const { scrollW, clientW, who } = await overflow(page);
  const ok = scrollW <= clientW + 1;
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    const detail = who
      .map((w) => `${w.tag}.${w.cls.split(/\s+/).slice(0, 3).join(".")} w=${w.width} right=${w.right}`)
      .join(" | ");
    failures.push(`${label} — ${scrollW}px in a ${clientW}px viewport :: ${detail}`);
    console.log(`  ✗ ${label} — ${scrollW}px wide in ${clientW}px`);
    for (const w of who) {
      console.log(`      ${w.tag}  w=${w.width} right=${w.right}  class="${w.cls}"  “${w.text}”`);
    }
  }
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const clinic = (
    await db.query(`select id, slug from clinics where slug = 'rima-dental'`)
  ).rows[0];
  if (!clinic) throw new Error("demo clinic missing — run `npm run seed`");
  const patient = (
    await db.query(
      `select id from patients where clinic_id = $1 and phone_e164 is not null order by created_at limit 1`,
      [clinic.id]
    )
  ).rows[0];
  const invoice = (
    await db.query(`select id from invoices where clinic_id = $1 limit 1`, [clinic.id])
  ).rows[0];
  /*
    A document of our own, rather than whatever the demo happens to hold — which
    for a long time was nothing at all, so this page was quietly skipped and the
    overflow a clinic reported went unnoticed by a suite reporting all green.

    The content is the case that actually breaks: an image at the pixel size a
    scan or a letterhead arrives at, and a table with more columns than a phone
    has room for. Both are ordinary in a real consent form.
  */
  const wideBody =
    `<p>عرض</p>` +
    `<img src="data:image/svg+xml;base64,${Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="300"></svg>'
    ).toString("base64")}" />` +
    `<table><tr>${Array.from({ length: 14 }, () => "<td>0123456789</td>").join("")}</tr></table>` +
    `<p>${"averyveryverylongunbrokenstringthatcannotwrap".repeat(3)}</p>`;
  const doc = (
    await db.query(
      `insert into documents (clinic_id, title, status, content_snapshot, source, language)
       values ($1, 'QA width fixture', 'sent', $2, 'template', 'ar') returning id`,
      [clinic.id, wideBody]
    )
  ).rows[0];
  const automation = (
    await db.query(`select id from automations where clinic_id = $1 limit 1`, [clinic.id])
  ).rows[0];

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', "admin@makan.agency");
  await page.fill('input[name="password"]', "admin1234");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000 });

  // Into the clinic workspace as the agency, which is how these pages are reached.
  await page.goto(`${BASE}/admin/clinics/${clinic.slug}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /open workspace|فتح مساحة العمل/i }).click();
  await page.waitForURL(`**/c/${clinic.slug}**`, { timeout: 60000 });

  const s = `${BASE}/c/${clinic.slug}`;
  const pages: [string, string][] = [
    ["dashboard", s],
    ["patients list", `${s}/patients`],
    ["calendar", `${s}/calendar`],
    ["conversations", `${s}/conversations`],
    ["invoices", `${s}/invoices`],
    ["documents", `${s}/documents`],
    ["automations", `${s}/automations`],
    ["campaigns", `${s}/campaigns`],
    ["reports", `${s}/reports`],
    ["settings · clinic", `${s}/settings`],
    ["settings · staff", `${s}/settings/staff`],
    ["settings · services", `${s}/settings/services`],
    ["settings · hours", `${s}/settings/hours`],
    ["settings · whatsapp", `${s}/settings/whatsapp`],
    ["settings · tags", `${s}/settings/tags`],
    ["settings · booking", `${s}/settings/booking`],
    ["settings · fields", `${s}/settings/fields`],
    ["settings · templates", `${s}/settings/templates`],
    ["settings · insurers", `${s}/settings/insurers`],
    ["waitlist", `${s}/waitlist`],
    ["patient import", `${s}/patients/import`],
    ["profile", `${s}/profile`],
  ];
  if (patient) pages.push(["patient profile", `${s}/patients/${patient.id}`]);
  if (invoice) pages.push(["invoice detail", `${s}/invoices/${invoice.id}`]);
  // Named for what it is testing, so a failure says which content broke it.
  if (doc) pages.push(["document detail (oversized image + wide table)", `${s}/documents/${doc.id}`]);
  if (automation) pages.push(["automation builder", `${s}/automations/${automation.id}`]);
  /*
    The one page here that is not part of the workspace, and the one most
    certain to be opened on a phone: patients reach it from a WhatsApp message.
    It is public, so it needs no session — only step one renders on load, which
    is the header, the clinic's own intro and the service cards.
  */
  const bookingLink = (
    await db.query(`select slug from booking_links where clinic_id = $1 and active limit 1`, [
      clinic.id,
    ])
  ).rows[0];
  if (bookingLink) pages.push(["public booking page", `${BASE}/book/${bookingLink.slug}`]);

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: PHONE.height });
    console.log(`\n  phone viewport ${width}×${PHONE.height}\n`);
    for (const [label, url] of pages) {
      try {
        await checkPage(page, `${label} @${width}`, url);
      } catch (e) {
        failures.push(`${label} @${width} — ${(e as Error).message.slice(0, 80)}`);
        console.log(`  ✗ ${label} @${width} — ${(e as Error).message.slice(0, 80)}`);
      }
    }
  }

  /*
    The document body has to actually be on the page for that row to have meant
    anything. Assert it, so a future change that stops rendering the snapshot
    turns this suite red instead of leaving it passing on an empty card.
  */
  if (doc) {
    await page.goto(`${s}/documents/${doc.id}`);
    await page.waitForLoadState("networkidle");
    /*
      A table, not the image. `img` is not in the sanitiser's allowlist
      (src/lib/esign/render.ts), so a document body can never contain one — the
      max-width rule in globals.css is defensive only. Tables and long unbroken
      strings do survive sanitisation, and those are what have to be checked to
      be present, or the two rows above are measuring an empty card.
    */
    const rendered = await page.locator(".doc-body-wrap table").count();
    if (rendered > 0) {
      passed++;
      console.log("  ✓ the wide table really was rendered on that page");
    } else {
      failures.push("document body rendered nothing wide — the rows above proved nothing");
      console.log("  ✗ document body rendered nothing wide");
    }
  }

  await browser.close();
  await db.query(`delete from documents where id = $1`, [doc.id]);
  await db.end();
  console.log(`\n  mobile width: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
