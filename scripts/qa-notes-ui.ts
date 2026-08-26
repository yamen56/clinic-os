/**
 * QA: the notes tab and the merged booking step, driven in a browser.
 *
 * The API suite proves the record cannot be destroyed. This one proves the
 * screens actually offer what was built: no delete button anywhere near a note,
 * a category filter that narrows the list, a history a person can open, and a
 * booking page that asks for the patient's details and the clinic's questions
 * on one screen rather than two.
 */
import { chromium, type Page } from "playwright";
import { Client } from "pg";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const STAMP = Date.now().toString(36);

let passed = 0;
const ok = (m: string) => {
  passed++;
  console.log(`✓ ${m}`);
};
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const text = (p: Page) => p.evaluate(() => document.body.innerText || "");

/*
  Note bodies live in <textarea> values, and a textarea's value is not part of
  innerText — it is a property, not a text node. Reading the notes list off
  innerText finds nothing and looks exactly like a component that failed to
  render. Everything else on the tab (chips, buttons, the history modal) is real
  text and is asserted through .
*/
const noteBodies = (p: Page) =>
  p.evaluate(() =>
    Array.from(document.querySelectorAll("main textarea")).map((t) => (t as HTMLTextAreaElement).value)
  );
async function shows(p: Page, re: RegExp, what: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let body = "";
  do {
    body = await text(p);
    if (re.test(body)) return;
    await p.waitForTimeout(250);
  } while (Date.now() < deadline);
  console.log(`--- ${what} ---\n${body.slice(0, 2000)}\n---`);
  throw new Error(what);
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();
  const clinic = (await db.query(`select id, slug from clinics where slug = 'rima-dental'`)).rows[0];
  if (!clinic) throw new Error("demo clinic missing — run `npm run seed`");
  await db.query(`select seed_note_categories($1)`, [clinic.id]);

  const patient = (
    await db.query(
      `select id from patients where clinic_id = $1 and merged_into is null order by created_at limit 1`,
      [clinic.id]
    )
  ).rows[0];
  const cats = (
    await db.query(`select id, key from note_categories where clinic_id = $1 order by sort`, [clinic.id])
  ).rows;
  const clinical = cats.find((c) => c.key === "clinical")!;
  const admin = cats.find((c) => c.key === "admin")!;

  const A = `QA clinical ${STAMP}`;
  const B = `QA admin ${STAMP}`;
  const note = (
    await db.query(
      `insert into patient_notes (clinic_id, patient_id, category_id, body) values ($1, $2, $3, $4) returning id`,
      [clinic.id, patient.id, clinical.id, A]
    )
  ).rows[0];
  await db.query(
    `insert into patient_note_versions (clinic_id, note_id, body, category_id) values ($1, $2, $3, $4)`,
    [clinic.id, note.id, A, clinical.id]
  );
  // A second version, so the history has something to show.
  await db.query(
    `update patient_notes set body = $2, edited_at = now() where id = $1`,
    [note.id, `${A} (corrected)`]
  );
  await db.query(
    `insert into patient_note_versions (clinic_id, note_id, body, category_id) values ($1, $2, $3, $4)`,
    [clinic.id, note.id, `${A} (corrected)`, clinical.id]
  );
  const note2 = (
    await db.query(
      `insert into patient_notes (clinic_id, patient_id, category_id, body) values ($1, $2, $3, $4) returning id`,
      [clinic.id, patient.id, admin.id, B]
    )
  ).rows[0];
  await db.query(
    `insert into patient_note_versions (clinic_id, note_id, body, category_id) values ($1, $2, $3, $4)`,
    [clinic.id, note2.id, B, admin.id]
  );

  const cleanup = async () => {
    await db.query(`delete from patient_notes where id = any($1::uuid[])`, [[note.id, note2.id]]);
  };

  const browser = await chromium.launch();
  /*
    Service workers blocked. This app registers one for offline use, and it will
    happily answer a navigation from its cache — which in a suite means asserting
    against the build from before the change under test. The symptom is a page
    that renders halfway and a server log full of 200s.
  */
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    serviceWorkers: "block",
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));

  try {
    await p.goto(`${BASE}/login`);
    await p.waitForLoadState("networkidle");
    await p.fill('input[name="email"]', "admin@makan.agency");
    await p.fill('input[name="password"]', "admin1234");
    await p.click('button[type="submit"]');
    await p.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000 });
    await p.goto(`${BASE}/admin/clinics/${clinic.slug}`);
    await p.waitForLoadState("networkidle");
    await p.getByRole("button", { name: /open workspace|فتح مساحة العمل/i }).click();
    await p.waitForURL(`**/c/${clinic.slug}**`, { timeout: 60000 });

    await p.goto(`${BASE}/c/${clinic.slug}/patients/${patient.id}`);
    await p.waitForLoadState("networkidle");
    // Wait for the profile itself, not just the shell: the tab strip is part of
    // the client component and arrives after the server shell flushes.
    await p.getByRole("tablist").waitFor({ timeout: 60000 });
    /*
      Clicked until it takes. The tab strip is server-rendered, so it is on the
      page and clickable before React has attached its onClick — a single click
      here lands on markup and does nothing, which looks exactly like a broken
      tab. Retry until the tab reports itself selected.
    */
    const notesTab = p.getByRole("tab", { name: /Notes|ملاحظات/ });
    for (let i = 0; i < 20; i++) {
      await notesTab.click();
      if ((await notesTab.getAttribute("aria-selected")) === "true") break;
      await p.waitForTimeout(500);
    }
    assert(
      (await notesTab.getAttribute("aria-selected")) === "true",
      "the notes tab never became selected"
    );
    await p.waitForTimeout(600);
    const bodies = await noteBodies(p);
    assert(
      bodies.some((b) => b.includes(STAMP)),
      `the notes tab did not render the fixture notes (${bodies.length} textareas)`
    );
    ok("notes tab renders the patient's notes");

    /* ------------------------------------------------------ no delete */
    const trash = await p
      .locator("main")
      .locator('button[aria-label="Delete"], button[aria-label="حذف"]')
      .count();
    assert(trash === 0, `found ${trash} delete buttons on the notes tab`);
    ok("there is no delete button on a note");

    /* --------------------------------------------------- the filter */
    await shows(p, /Clinical|سريرية/, "no category chip on the filter bar");
    const before = await noteBodies(p);
    assert(
      before.some((b) => b.includes(A)) && before.some((b) => b.includes(B)),
      "both notes should be listed unfiltered"
    );
    await p.getByRole("button", { name: /^Administrative\s+\d+$|^إدارية\s+\d+$/ }).click();
    await p.waitForTimeout(400);
    const after = await noteBodies(p);
    assert(after.some((b) => b.includes(B)), "the filtered-for note disappeared");
    assert(
      !after.some((b) => b.includes(A)),
      "filtering by a category still shows another category's note"
    );
    ok("filtering by category narrows the list to that category");

    /* -------------------------------------------------- the history */
    await p.getByRole("button", { name: /^All\s+\d+$|^الكل\s+\d+$/ }).click();
    await p.waitForTimeout(300);
    await p.getByRole("button", { name: /^edited$|^مُعدّلة$/ }).first().click();
    await shows(p, /Original|النسخة الأصلية/, "the history modal did not open");
    const hist = await text(p);
    assert(hist.includes(A), "the original text is not in the history");
    ok("the original version is readable from the note");

    assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    ok("no client-side errors on the notes tab");

    /* -------------------------------- booking: one step, not two */
    const link = (
      await db.query(`select slug from booking_links where clinic_id = $1 and active limit 1`, [
        clinic.id,
      ])
    ).rows[0];
    const qLabel = `QA reason ${STAMP}`;
    const q = (
      await db.query(
        `insert into booking_questions (clinic_id, label, field_type, required, display_order)
         values ($1, $2, 'longtext', true, 10) returning id`,
        [clinic.id, qLabel]
      )
    ).rows[0];

    try {
      const pub = await ctx.newPage();
      const pubErrors: string[] = [];
      pub.on("pageerror", (e) => pubErrors.push(e.message));
      await pub.goto(`${BASE}/book/${link.slug}`);
      await pub.waitForLoadState("networkidle");

      await pub.locator("button").filter({ hasText: /دقيقة|min$/ }).first().click();
      const anyDoc = pub.getByText(/أول طبيب متاح|First available doctor/);
      if (await anyDoc.isVisible().catch(() => false)) await anyDoc.click();
      const slot = pub
        .locator("button")
        .filter({ hasText: /^\d{1,2}:\d{2}\s?(AM|PM|ص|م)$/ })
        .first();
      await slot.waitFor({ timeout: 30000 });
      await slot.click();
      await pub.getByRole("button", { name: /متابعة|Continue/ }).click();

      // The details step must now carry the name field AND the clinic's question.
      // The heading is real text; the name and phone fields are placeholders,
      // which innerText cannot see — so those are asserted as elements.
      await shows(pub, /بياناتك|Your details/, "the details step never appeared");
      assert(
        await pub.getByPlaceholder(/اسمك الكامل|Your full name/).count(),
        "the name field is not on the details step"
      );
      assert(await pub.getByPlaceholder("079 000 0000").count(), "the phone field is missing");
      const one = await text(pub);
      assert(
        one.includes(qLabel),
        "the clinic's question is not on the same step as the patient's details"
      );
      ok("name, phone and the clinic's questions are all on one step");

      // And there is no longer a "Continue" that leads to a second question step.
      const send = pub.getByRole("button", { name: /إرسال الرمز|Send code/ });
      assert(await send.count(), "the details step does not submit directly");

      // Name and phone filled, question still blank: the step must stay shut.
      await pub.getByPlaceholder(/اسمك الكامل|Your full name/).fill("QA Patient");
      await pub.getByPlaceholder("079 000 0000").fill("0790000188");
      await pub.waitForTimeout(200);
      assert(
        await send.isDisabled(),
        "complete details alone unlocked the step — the required question was not enforced"
      );
      await pub.locator("textarea").first().fill("Toothache");
      await pub.waitForTimeout(200);
      assert(!(await send.isDisabled()), "answering the question did not unblock submission");
      ok("one step gates on the details AND the questions, then submits directly");

      assert(pubErrors.length === 0, `booking page errors: ${pubErrors.join(" | ")}`);
      ok("no client-side errors on the booking page");
    } finally {
      await db.query(`delete from booking_questions where id = $1`, [q.id]);
    }

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
