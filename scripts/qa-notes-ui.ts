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
  A filed note is now read-only text, edited behind a button, so its body is
  ordinary innerText. It used to be the value of an always-live <textarea> —
  which is a property rather than a text node, so this had to reach into the DOM
  for it. The one textarea still on the tab is the composer, and excluding the
  card it sits in is what keeps a half-typed draft out of these assertions.
*/
const noteBodies = (p: Page) =>
  p.evaluate(() =>
    Array.from(document.querySelectorAll("main p.whitespace-pre-wrap")).map(
      (el) => el.textContent ?? ""
    )
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

  /*
    A third note that is a recording.

    A real, tiny WAV rather than a stub: the point of the assertions below is
    that a doctor's voice comes back out of the app, and a file the browser
    cannot decode would pass a "the player rendered" check while failing the
    only thing anybody cares about.
  */
  const { saveFile } = await import("../src/lib/storage");
  const wav = (() => {
    const samples = 8000; // one second at 8kHz, silent
    const buf = Buffer.alloc(44 + samples * 2);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + samples * 2, 4);
    buf.write("WAVEfmt ", 8);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(8000, 24);
    buf.writeUInt32LE(16000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(samples * 2, 40);
    return buf;
  })();
  const stored = await saveFile(clinic.id, "notes", `qa-${STAMP}.wav`, wav);
  const voiceNote = (
    await db.query(
      `insert into patient_notes (clinic_id, patient_id, category_id, body, audio_path, audio_mime, audio_seconds)
       values ($1,$2,$3,'',$4,'audio/wav',1) returning id`,
      [clinic.id, patient.id, clinical.id, stored.storagePath]
    )
  ).rows[0];

  const cleanup = async () => {
    await db.query(`delete from patient_notes where id = any($1::uuid[])`, [
      [note.id, note2.id, voiceNote.id],
    ]);
  };

  /*
    A fake microphone, so recording can be driven for real rather than mocked.
    Headless Chromium has no audio input at all, and without these flags
    getUserMedia rejects with NotSupportedError — which looks exactly like the
    Permissions-Policy bug this suite exists to catch.
  */
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
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

    /* ------------------------------------------- editing behind a button */
    /*
      A filed note is not an open box. It used to render as a live textarea with
      a row of category chips underneath every single one — a control repeated
      down the whole page for something changed once, if ever. The only textarea
      left on the tab is the composer.
    */
    const liveBoxes = await p.locator("main textarea").count();
    assert(liveBoxes === 1, `expected only the composer to be editable, found ${liveBoxes}`);
    ok("a filed note is text, not an open textarea");

    const arrows = await p.locator("main").getByText(/^→\s/).count();
    assert(arrows === 0, `the per-note category switcher is still there (${arrows} chips)`);
    ok("and carries no row of category chips");

    const editBtn = p.getByRole("button", { name: /^Edit$|^تعديل$/ }).first();
    await editBtn.click();
    const dialog = p.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 20000 });
    ok("Edit opens a dialog");

    // Both things are editable in the one place, which is the point of it.
    const catSelect = dialog.locator("select").first();
    const bodyBox = dialog.locator("textarea").first();
    assert(await catSelect.isVisible(), "the edit dialog has no category control");
    assert(await bodyBox.isVisible(), "the edit dialog has no text box");
    ok("with the category and the text together");

    /*
      Appended, not replaced. This dialog opens on whichever note is first, and
      overwriting its body would delete the text the filter assertions below
      look for — a test failure two sections later with no obvious cause.
    */
    await bodyBox.fill(`${await bodyBox.inputValue()} edited-${STAMP}`);
    await dialog.getByRole("button", { name: /Save changes|حفظ التعديلات/ }).click();
    await p.waitForTimeout(1500);
    await shows(p, new RegExp(`edited-${STAMP}`), "the edited text never appeared on the note");
    ok("saving writes the new text back to the note");

    /* ---------------------------------------------------- voice notes */
    /*
      A recording has to be listenable in the list beside the typed notes, the
      way a voice message is. The browser's own <audio controls> is not that —
      different on every platform, carrying a download button we do not want on
      a clinical record, and wide enough to bury the note it belongs to.
    */
    /*
      The bug this was all downstream of: `Permissions-Policy: microphone=()`
      denied our own origin, so the browser rejected getUserMedia without ever
      showing a prompt — a doctor pressed Record and was told the microphone was
      blocked by a dialog that had never appeared.

      Asked of the live document rather than of the header string, because this
      is the question the browser actually answers when Record is pressed.
    */
    const mayAsk = await p.evaluate(() => {
      const fp = (document as unknown as { featurePolicy?: { allowsFeature(f: string): boolean } })
        .featurePolicy;
      return fp ? fp.allowsFeature("microphone") : "unsupported";
    });
    assert(mayAsk !== false, "the page is not allowed to ask for the microphone");
    ok(`the page may ask for the microphone (${mayAsk})`);

    const native = await p.locator("main audio[controls]").count();
    assert(native === 0, `the browser's default player is still being used (${native})`);
    ok("a recording is not left to the browser's own player");

    const playBtn = p
      .getByRole("button", { name: /Play the voice note|تشغيل الملاحظة الصوتية/ })
      .first();
    await playBtn.waitFor({ state: "visible", timeout: 20000 });
    ok("it has a play button of its own");

    // Does sound actually come back? Drive the element, not the button, so the
    // assertion is about the audio rather than about React state.
    const played = await p.evaluate(async () => {
      const el = document.querySelector("main audio") as HTMLAudioElement | null;
      if (!el) return "no audio element";
      await el.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
      if (el.readyState < 2) return `never loaded (readyState ${el.readyState})`;
      if (!Number.isFinite(el.duration) || el.duration <= 0) return `bad duration ${el.duration}`;
      return "ok";
    });
    assert(played === "ok", `the recording did not play back: ${played}`);
    ok("and the audio decodes and plays");

    /* ------------------------------------------- stop means saved */
    /*
      One press, not two. The recorder used to park the clip in a preview and
      wait for the composer's Save button — which is two presses for something a
      doctor does between patients with a hand already on the door.
    */
    /*
      Counted by players, not by note bodies. A voice note is saved with an
      empty body, so it renders no paragraph at all — waiting on the paragraph
      count is a condition that is already true, which is a wait that does not
      wait and a count taken before the list has repainted.
    */
    const players = () =>
      p.getByRole("button", { name: /Play the voice note|تشغيل الملاحظة الصوتية/ }).count();
    const playersBefore = await players();

    await p.getByRole("button", { name: /^Record$|^تسجيل$/ }).click();
    await p.locator("main button.bg-danger-soft").first().waitFor({ timeout: 20000 });
    // Long enough to clear the under-a-second mis-tap guard.
    await p.waitForTimeout(1800);
    await p.locator("main button.bg-danger-soft").first().click();

    await p
      .waitForFunction(
        (n) =>
          document.querySelectorAll(
            'main button[aria-label="Play the voice note"], main button[aria-label="تشغيل الملاحظة الصوتية"]'
          ).length > n,
        playersBefore,
        { timeout: 30000 }
      )
      .catch(() => {});
    const playersNow = await players();
    assert(
      playersNow > playersBefore,
      `stopping did not file the recording (${playersBefore} → ${playersNow} players)`
    );
    ok("stopping the recorder files the note on its own");

    // And nothing is left waiting to be confirmed.
    const leftover = await p.locator("main button.bg-brand-50").count();
    assert(leftover === 0, "a recording is still sitting in a preview after stop");
    ok("with no preview left to confirm");

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
