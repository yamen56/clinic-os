/**
 * Taking a patient's record out of the clinic.
 *
 * A medical record leaving the building is the most sensitive thing this
 * product does on purpose, so most of what follows is about who may do it and
 * what the URL that renders it is worth to somebody who finds it. The print
 * page is reachable without a session — the worker's Chromium has no cookie —
 * which makes the signature the only thing between a patient id and their file.
 *
 * The rest is about the record being a record: the clinical content has to be
 * in it, and the WhatsApp thread has to not be.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { ar } from "../src/lib/i18n/ar";

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

async function main() {
  const { printKeyFor } = await import("../src/lib/print-token");
  const db = new Client({ connectionString: PG });
  await db.connect();

  const stamp = Date.now().toString(36);
  const slug = `qaexp${stamp}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, invoice_prefix)
       values ('QA Export','تصدير',$1,'ar','Asia/Amman','JOD','QAX') returning id`,
      [slug]
    )
  ).rows[0];
  const clinicId = clinic.id as string;
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinicId]);

  const mkUser = async (tag: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'ar') returning id`,
        [`${tag}-${slug}@test.local`, bcrypt.hashSync("password123", 10), `QA ${tag}`]
      )
    ).rows[0].id as string;

  const ownerId = await mkUser("owner");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinicId, ownerId]
  );
  // Somebody who may not open patient files at all.
  const outsiderId = await mkUser("outsider");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, permissions)
     values ($1,$2,'receptionist',$3)`,
    [clinicId, outsiderId, JSON.stringify({ level: "custom", caps: { conversations: true, patients: false } })]
  );
  /* And somebody who may open any single file but does not own the clinic —
     the whole point of the bulk gate is the gap between these two. */
  const staffId = await mkUser("staff");
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, permissions)
     values ($1,$2,'receptionist',$3)`,
    [clinicId, staffId, JSON.stringify({ level: "custom", caps: { patients: true } })]
  );

  const NOTE = `clinical-${stamp}`;
  const SECRET_MSG = `whatsapp-${stamp}`;
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source, tags)
       values ($1,'مريض التصدير','+962790424242','staff',array['vip']) returning id`,
      [clinicId]
    )
  ).rows[0].id as string;
  await db.query(`select seed_note_categories($1)`, [clinicId]);
  const cat = (
    await db.query(`select id from note_categories where clinic_id = $1 and key = 'clinical'`, [clinicId])
  ).rows[0].id;
  await db.query(
    `insert into patient_notes (clinic_id, patient_id, category_id, body) values ($1,$2,$3,$4)`,
    [clinicId, patient, cat, NOTE]
  );
  // A voice note: it cannot be printed, so the record must say one exists.
  await db.query(
    `insert into patient_notes (clinic_id, patient_id, category_id, body, audio_path, audio_mime, audio_seconds)
     values ($1,$2,$3,'',$4,'audio/wav',7)`,
    [clinicId, patient, cat, `notes/qa-${stamp}.wav`]
  );
  await db.query(
    `insert into appointments (clinic_id, patient_id, starts_at, ends_at, status)
     values ($1,$2, now() - interval '2 days', now() - interval '2 days' + interval '30 min','completed')`,
    [clinicId, patient]
  );
  // The WhatsApp thread, which must NOT appear in the record.
  const conv = (
    await db.query(
      `insert into conversations (clinic_id, phone_e164, patient_id) values ($1,'+962790424242',$2) returning id`,
      [clinicId, patient]
    )
  ).rows[0].id;
  await db.query(
    `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body, status)
     values ($1,$2,'in','patient','text',$3,'delivered')`,
    [clinicId, conv, SECRET_MSG]
  );

  // A second file, so "all of them" means more than one.
  const SECOND = `مريض ثانٍ ${stamp}`;
  await db.query(
    `insert into patients (clinic_id, full_name, phone_e164, source)
     values ($1,$2,'+962790424343','staff')`,
    [clinicId, SECOND]
  );

  // A second clinic, to prove one cannot export the other's file.
  const other = (
    await db.query(
      `insert into clinics (name, slug, default_locale) values ('QA Other',$1,'ar') returning id`,
      [`${slug}-o`]
    )
  ).rows[0].id;
  const otherPatient = (
    await db.query(
      `insert into patients (clinic_id, full_name, source) values ($1,'Someone Else','staff') returning id`,
      [other]
    )
  ).rows[0].id;
  console.log(`\n✓ fixture clinic ${slug}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    /* ================================================== the URL on its own */
    console.log("\n[what the print URL is worth without a signature]");
    const anon = await page.request.get(`${BASE}/patient-print/${patient}`);
    check("no signature, no record", anon.status() === 404, String(anon.status()));

    const forged = await page.request.get(
      `${BASE}/patient-print/${patient}?kind=patient&exp=${Date.now() + 60000}&sig=not-a-signature`
    );
    check("a made-up signature is refused", forged.status() === 404, String(forged.status()));

    const { sig } = printKeyFor(patient, "patient");
    const expired = await page.request.get(
      `${BASE}/patient-print/${patient}?kind=patient&exp=${Date.now() - 1000}&sig=${sig}`
    );
    check("and an expired one is too", expired.status() === 404, String(expired.status()));

    /*
      A key is minted for one patient. Spending it on another must fail, or the
      signature is a formality — one export would open every file.
    */
    const stolen = printKeyFor(patient, "patient");
    const reused = await page.request.get(
      `${BASE}/patient-print/${otherPatient}?kind=patient&exp=${stolen.exp}&sig=${stolen.sig}`
    );
    check("a key for one patient does not open another", reused.status() === 404, String(reused.status()));

    const good = printKeyFor(patient, "patient");
    const ok = await page.request.get(
      `${BASE}/patient-print/${patient}?kind=patient&exp=${good.exp}&sig=${good.sig}`
    );
    check("the real key opens it", ok.status() === 200, String(ok.status()));

    /* ================================================== who may export */
    console.log("\n[who may take it]");
    const anonDownload = await page.request.get(`${BASE}/api/c/${slug}/patients/${patient}/export`);
    check(
      "a signed-out request gets nothing",
      anonDownload.status() === 401 || anonDownload.status() === 403,
      String(anonDownload.status())
    );

    /* Its own context: a signed-in page never sees /login again, so reusing one
       browser for two identities signs in as nobody. */
    const outCtx = await browser.newContext();
    const outPage = await outCtx.newPage();
    await signIn(outPage, `outsider-${slug}@test.local`);
    const denied = await outPage.request.get(`${BASE}/api/c/${slug}/patients/${patient}/export`);
    check(
      "nor does a member without the patients module",
      denied.status() === 403,
      String(denied.status())
    );
    await outCtx.close();

    await signIn(page, `owner-${slug}@test.local`);
    const cross = await page.request.get(`${BASE}/api/c/${slug}/patients/${otherPatient}/export`);
    check(
      "and another clinic's patient is not found, not rendered",
      cross.status() === 404,
      String(cross.status())
    );

    /* ================================================== the record itself */
    console.log("\n[the record]");
    const res = await page.request.get(`${BASE}/api/c/${slug}/patients/${patient}/export`);
    check("the owner gets a file", res.status() === 200, String(res.status()));
    const body = await res.body();
    check("which is a PDF", body.subarray(0, 5).toString("latin1") === "%PDF-", body.subarray(0, 8).toString("latin1"));
    check("of a plausible size", body.length > 5000, `${body.length} bytes`);
    check(
      "downloaded rather than opened in the tab",
      /attachment/.test(res.headers()["content-disposition"] ?? ""),
      res.headers()["content-disposition"] ?? ""
    );

    // Read the page the PDF is made of, which is where the content assertions
    // can actually be made — a PDF's text layer is not worth parsing.
    const k = printKeyFor(patient, "patient");
    await page.goto(`${BASE}/patient-print/${patient}?kind=patient&exp=${k.exp}&sig=${k.sig}`);
    await page.waitForLoadState("networkidle");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");

    check("it names the patient", text.includes("مريض التصدير"), "");
    check("and the clinic", text.includes("تصدير") || text.includes("QA Export"), "");
    check("the clinical note is in it", text.includes(NOTE), "");
    check("so is the visit history", text.includes(ar.patients.tabs.appointments), "");
    check(
      "a voice note is declared rather than silently dropped",
      text.includes(ar.patients.exportVoiceNote),
      ""
    );
    /*
      The one that matters most. A year of scheduling chatter would bury four
      clinical notes, so the thread is deliberately out — and a record that
      quietly carried it would be handing over more than the clinic intended.
    */
    check("the WhatsApp thread is not in it", !text.includes(SECRET_MSG), "");

    /* ================================================== the trail */
    const trail = await db.query(
      `select count(*)::int n from audit_log
        where clinic_id = $1 and action = 'patient.export' and entity_id = $2`,
      [clinicId, patient]
    );
    check("taking it is recorded", trail.rows[0].n >= 1, `${trail.rows[0].n}`);

    /* ================================================== the button */
    await page.goto(`${BASE}/c/${slug}/patients/${patient}`);
    await page.waitForLoadState("networkidle");
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await page.getByRole("button", { name: ar.common.actions }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    const link = page.getByRole("link", { name: ar.patients.exportFile });
    check("the file offers it", (await link.count()) > 0, "");

    /* ============================================ every record at once */
    console.log("\n[the whole clinic, and who may take it]");

    const bulkAnon = await page.request.get(`${BASE}/patients-print/${clinicId}`);
    check("the bulk page needs a signature", bulkAnon.status() === 404, String(bulkAnon.status()));

    /*
      The kinds are an allowlist per page. A key minted to print one patient
      must not be spendable on the page that prints the entire clinic, or the
      narrower permission silently becomes the wider one.
    */
    const wrongKind = printKeyFor(clinicId, "patient");
    const kindMix = await page.request.get(
      `${BASE}/patients-print/${clinicId}?kind=patient&exp=${wrongKind.exp}&sig=${wrongKind.sig}`
    );
    check("a single-patient key does not open the clinic", kindMix.status() === 404, String(kindMix.status()));

    // The one that matters most: another clinic's key over this clinic's id.
    const otherKey = printKeyFor(other, "patients");
    const crossClinic = await page.request.get(
      `${BASE}/patients-print/${clinicId}?kind=patients&exp=${otherKey.exp}&sig=${otherKey.sig}`
    );
    check(
      "one clinic's key does not open another's records",
      crossClinic.status() === 404,
      String(crossClinic.status())
    );

    const bulkKey = printKeyFor(clinicId, "patients");
    const bulkUrl = `${BASE}/patients-print/${clinicId}?kind=patients&exp=${bulkKey.exp}&sig=${bulkKey.sig}`;
    const bulkOk = await page.request.get(bulkUrl);
    check("the clinic's own key opens it", bulkOk.status() === 200, String(bulkOk.status()));

    const bulkAnonApi = await browser
      .newContext()
      .then(async (c2) => {
        const r = await c2.request.get(`${BASE}/api/c/${slug}/patients/export-all`);
        await c2.close();
        return r;
      });
    check(
      "a signed-out bulk export gets nothing",
      bulkAnonApi.status() === 401 || bulkAnonApi.status() === 403,
      String(bulkAnonApi.status())
    );

    /* Staff may export one file and may not export all of them. This is the
       assertion the whole owner gate exists for. */
    const staffCtx = await browser.newContext();
    const staffPage = await staffCtx.newPage();
    await signIn(staffPage, `staff-${slug}@test.local`);
    const staffOne = await staffPage.request.get(
      `${BASE}/api/c/${slug}/patients/${patient}/export`
    );
    check("staff may still export one file", staffOne.status() === 200, String(staffOne.status()));
    const staffAll = await staffPage.request.get(`${BASE}/api/c/${slug}/patients/export-all`);
    check("but not every file", staffAll.status() === 403, String(staffAll.status()));

    await staffPage.goto(`${BASE}/c/${slug}/patients`);
    await staffPage.waitForLoadState("networkidle");
    await staffPage.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    check(
      "and is not shown a button they cannot use",
      (await staffPage.getByRole("button", { name: ar.patients.exportAll }).count()) === 0,
      ""
    );
    await staffCtx.close();

    /* ============================================ the document */
    console.log("\n[the whole-clinic document]");
    const all = await page.request.get(`${BASE}/api/c/${slug}/patients/export-all`);
    check("the owner gets every record", all.status() === 200, String(all.status()));
    const allBody = await all.body();
    check("which is a PDF", allBody.subarray(0, 5).toString("latin1") === "%PDF-", "");
    check(
      "named for the clinic and the day",
      /attachment/.test(all.headers()["content-disposition"] ?? "") &&
        (all.headers()["content-disposition"] ?? "").includes(slug),
      all.headers()["content-disposition"] ?? ""
    );

    await page.goto(bulkUrl);
    await page.waitForLoadState("networkidle");
    const bulkText = (await page.locator("main").innerText()).replace(/\s+/g, " ");

    check("both patients are in it", bulkText.includes("مريض التصدير") && bulkText.includes(SECOND), "");
    check("each record starts its own sheet", (await page.locator(".patient-sheet").count()) === 2, "");
    check("it carries an index", (await page.locator(".toc tr").count()) === 2, "");
    check("the cover states the count", bulkText.includes(ar.patients.exportAllCount), "");
    check("no other clinic's patient is in it", !bulkText.includes("Someone Else"), "");
    check("nor the WhatsApp thread", !bulkText.includes(SECRET_MSG), "");

    /* The filters on screen are the filters in the document — and the cover
       says which, so a slice is never mistaken for the whole. */
    const filteredKey = printKeyFor(clinicId, "patients");
    await page.goto(
      `${BASE}/patients-print/${clinicId}?kind=patients&exp=${filteredKey.exp}&sig=${filteredKey.sig}&q=${encodeURIComponent(SECOND)}`
    );
    await page.waitForLoadState("networkidle");
    const filtered = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    check("a filtered export holds only the match", filtered.includes(SECOND) && !filtered.includes("مريض التصدير"), "");
    check("and says so on the cover", filtered.includes(ar.patients.exportAllScope), "");

    const nothing = await page.request.get(
      `${BASE}/api/c/${slug}/patients/export-all?q=${encodeURIComponent(`nobody-${stamp}`)}`
    );
    check("a filter matching nobody is refused", nothing.status() === 404, String(nothing.status()));

    check(
      "taking every record is recorded",
      (
        await db.query(
          `select count(*)::int n from audit_log
            where clinic_id = $1 and action = 'patient.export_all'`,
          [clinicId]
        )
      ).rows[0].n >= 1,
      ""
    );

    /* ============================================ the ceiling */
    console.log("\n[when there are too many]");
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source)
       select $1, 'bulk ' || g, '+9627' || lpad(g::text, 8, '0'), 'staff'
         from generate_series(1, 420) g`,
      [clinicId]
    );
    const tooMany = await page.request.get(`${BASE}/api/c/${slug}/patients/export-all`);
    check("too many records is refused, not truncated", tooMany.status() === 413, String(tooMany.status()));
    const detail = (await tooMany.json().catch(() => ({}))) as { count?: number; max?: number };
    check(
      "and the refusal says how many and how many fit",
      typeof detail.count === "number" && detail.count > 400 && detail.max === 400,
      `${detail.count} / ${detail.max}`
    );
    /* Even holding a valid key, the page itself will not render past the cap —
       the count check in the route is not the only thing standing there. */
    const cappedKey = printKeyFor(clinicId, "patients");
    await page.goto(
      `${BASE}/patients-print/${clinicId}?kind=patients&exp=${cappedKey.exp}&sig=${cappedKey.sig}`
    );
    await page.waitForLoadState("networkidle");
    check(
      "the page refuses to render past the cap on its own",
      (await page.locator(".patient-sheet").count()) === 400,
      String(await page.locator(".patient-sheet").count())
    );

    /* ============================================ the button */
    await page.goto(`${BASE}/c/${slug}/patients`);
    await page.waitForLoadState("networkidle");
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    check(
      "the owner is offered it on the list",
      (await page.getByRole("button", { name: ar.patients.exportAll }).count()) > 0,
      ""
    );
  } finally {
    await browser.close();
  }

  await db.query(`delete from clinics where id = any($1::uuid[])`, [[clinicId, other]]);
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
