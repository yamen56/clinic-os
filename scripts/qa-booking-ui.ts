/**
 * QA: the booking screens, driven the way a person drives them.
 *
 * The API suite (`qa-booking-intake.ts`) proves the rules hold when the browser
 * is hostile. This one proves the ordinary path works at all: a clinic adds a
 * question in settings, and a patient meets it on the public page and answers
 * it. Two screens that talk to each other only through the database, which is
 * exactly the seam that breaks silently.
 *
 * Every assertion accepts either language. The workspace follows the signed-in
 * user's cookie and the public page follows the clinic's default locale, so a
 * suite written against one of them passes or fails on whose machine it ran.
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const STAMP = Date.now().toString(36);
const QUESTION = `QA reason ${STAMP}`;
const HEADLINE = `QA headline ${STAMP}`;

let passed = 0;
const ok = (m: string) => {
  passed++;
  console.log(`✓ ${m}`);
};
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/*
  innerText, never textContent. Every page ships the whole dictionary in its
  hydration payload, so a textContent check passes on any page in the app and
  proves nothing about what is on screen.
*/
const text = (page: Page) => page.evaluate(() => document.body.innerText || "");

/**
 * Polls rather than samples once.
 *
 * Half of these assertions follow a `router.refresh()`, and `networkidle` can
 * land in the gap between the server action returning and the refreshed tree
 * painting — where the page's whole text is the toast that just appeared. A
 * single read there fails on timing rather than on behaviour.
 */
async function shows(page: Page, re: RegExp, what: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let body = "";
  do {
    body = await text(page);
    if (re.test(body)) return;
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  console.log(`--- ${what}: page text ---\n${body.slice(0, 2500)}\n---`);
  throw new Error(what);
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const clinic = (await db.query(`select id, slug from clinics where slug = 'rima-dental'`)).rows[0];
  if (!clinic) throw new Error("demo clinic missing — run `npm run seed`");
  const link = (
    await db.query(`select id, slug from booking_links where clinic_id = $1 limit 1`, [clinic.id])
  ).rows[0];

  const cleanup = async () => {
    await db.query(`delete from booking_questions where clinic_id = $1 and label like 'QA %'`, [
      clinic.id,
    ]);
    await db.query(`update booking_links set headline = null, headline_ar = null where id = $1`, [
      link.id,
    ]);
  };
  await cleanup();

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  try {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', "admin@makan.agency");
    await page.fill('input[name="password"]', "admin1234");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000 });
    await page.goto(`${BASE}/admin/clinics/${clinic.slug}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /open workspace|فتح مساحة العمل/i }).click();
    await page.waitForURL(`**/c/${clinic.slug}**`, { timeout: 60000 });
    ok("signed in and inside the demo workspace");

    /* ------------------------------------------- add a question in settings */
    await page.goto(`${BASE}/c/${clinic.slug}/settings/booking`);
    await page.waitForLoadState("networkidle");
    await shows(
      page,
      /Booking questions|أسئلة الحجز/,
      "the questions card is missing from the booking settings page"
    );
    ok("booking settings shows the questions card");

    await page.getByRole("button", { name: /New question|سؤال جديد/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    // The first text input in the dialog is the question label.
    await dialog.locator("input").first().fill(QUESTION);
    // The first select is the answer type; the second is which link it is asked on.
    await dialog.locator("select").first().selectOption("longtext");
    // "Required" is the first switch in the dialog.
    await dialog.getByRole("switch").first().click();
    await dialog.getByRole("button", { name: /^Save$|^حفظ$/ }).click();
    await dialog.waitFor({ state: "hidden", timeout: 30000 });
    await page.waitForLoadState("networkidle");
    await shows(page, new RegExp(QUESTION), "the saved question is not listed");
    ok("a question saved from the settings dialog appears in the list");

    const stored = (
      await db.query(
        `select field_type, required, active from booking_questions where clinic_id = $1 and label = $2`,
        [clinic.id, QUESTION]
      )
    ).rows[0];
    assert(stored, "the question was not written to the database");
    assert(stored.field_type === "longtext", `wrong type stored: ${stored.field_type}`);
    assert(stored.required === true, "the required toggle did not take");
    ok("it stored the type and the required flag the dialog showed");

    /* --------------------------------------------- and the link's own copy */
    await page.getByRole("button", { name: /^Edit$|^تعديل$/ }).first().click();
    const linkDialog = page.getByRole("dialog");
    await linkDialog.waitFor({ state: "visible" });
    // By the field's own label, so a reordered dialog does not silently type
    // the headline into whatever input happens to sit at that index.
    await linkDialog
      .locator("label")
      .filter({ hasText: /^Headline \(Arabic\)|^العنوان الرئيسي \(بالعربية\)/ })
      .locator("input")
      .fill(HEADLINE);
    await linkDialog.getByRole("button", { name: /^Save$|^حفظ$/ }).click();
    await linkDialog.waitFor({ state: "hidden", timeout: 30000 });
    const savedHeadline = (
      await db.query(`select headline_ar from booking_links where id = $1`, [link.id])
    ).rows[0].headline_ar;
    assert(savedHeadline === HEADLINE, `headline not saved: ${savedHeadline}`);
    ok("the clinic's own headline saves onto the link");

    /* ------------------------------------------------- meet it as a patient */
    const pub = await ctx.newPage();
    const pubErrors: string[] = [];
    pub.on("pageerror", (e) => pubErrors.push(e.message));
    await pub.goto(`${BASE}/book/${link.slug}`);
    await pub.waitForLoadState("networkidle");
    await shows(pub, new RegExp(HEADLINE), "the headline is not on the public page");
    ok("the public page opens with the clinic's own headline");

    // Step 1: the first service card carries a duration.
    await pub.locator("button").filter({ hasText: /دقيقة|min$/ }).first().click();
    // Step 2 is the doctor picker when the clinic has more than one.
    const anyDoctor = pub.getByText(/أول طبيب متاح|First available doctor/);
    if (await anyDoctor.isVisible().catch(() => false)) await anyDoctor.click();
    await shows(pub, /اختر الوقت|Pick a time/, "the time step never appeared");
    ok("service and doctor steps advance to the time step");

    /*
      The strip must have decided which days are worth tapping. The demo clinic
      is shut at least one day a week, so a disabled button proves the
      availability call landed rather than leaving thirty identical ones.
    */
    await pub.waitForFunction(() => document.querySelectorAll("button[disabled]").length > 0, undefined, {
      timeout: 30000,
    });
    ok("closed days come back disabled in the date strip");

    const slotBtn = pub
      .locator("button")
      .filter({ hasText: /^\d{1,2}:\d{2}\s?(AM|PM|ص|م)$/ })
      .first();
    await slotBtn.waitFor({ timeout: 30000 });
    await slotBtn.click();
    await pub.getByRole("button", { name: /متابعة|Continue/ }).click();

    await pub.getByPlaceholder(/اسمك الكامل|Your full name/).fill("QA Intake Patient");
    await pub.getByPlaceholder("079 000 0000").fill("0790000199");
    await pub.getByRole("button", { name: /متابعة|Continue/ }).click();

    await shows(pub, new RegExp(QUESTION), "the clinic's question never reached the patient");
    ok("the patient is asked the clinic's question after their details");

    // Required, so the submit button must still be refusing.
    const submit = pub.getByRole("button", { name: /إرسال الرمز|Send code/ });
    assert(await submit.isDisabled(), "a required question did not block the submit button");
    ok("an unanswered required question blocks the booking on the page too");

    await pub.locator("textarea").first().fill("Toothache on the lower left");
    assert(!(await submit.isDisabled()), "answering the question did not unblock the button");
    ok("answering it unblocks the button");

    assert(
      errors.length === 0 && pubErrors.length === 0,
      `page errors: ${[...errors, ...pubErrors].join(" | ")}`
    );
    ok("no client-side errors on either screen");

    console.log(`\n  ${passed} checks passed\n`);
  } finally {
    await browser.close();
    await cleanup();
    await db.end();
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
