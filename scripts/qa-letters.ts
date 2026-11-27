/**
 * Medical letters (0123): sick leave, a medical report, a referral.
 *
 *   - The wording: days counted the Arabic way, a leave's last day inclusive,
 *     the patient's age, and what each kind may not be without.
 *   - A doctor writes a sick leave from the file's header and sends it: one
 *     WhatsApp document on the patient's thread, a caption that names the
 *     letter and not the diagnosis.
 *   - A referral refuses to go without an addressee, then prints.
 *   - The print page opens only with a letter key, and says what was written.
 *   - The desk reads and reprints, and cannot write one.
 *   - At phone width the composer does not spill.
 *
 * Needs the dev stack: web on APP_URL and the worker (the PDF renderer).
 *
 *   npx tsx scripts/qa-letters.ts
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { ar } from "../src/lib/i18n/ar";
import { describeSpills, spills } from "./lib-layout";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = process.env.QA_SHOTS_DIR || "";

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

const T = ar.letters;

async function main() {
  const { printKeyFor } = await import("../src/lib/print-token");
  const { saveFile } = await import("../src/lib/storage");
  const lib = await import("../src/lib/medical-letters");
  const { memberHistorySql } = await import("../src/lib/member-history");
  const { appointmentAttachedSql } = await import("../src/lib/appointment-history");

  /* ================================================================ pure */
  console.log("\n[the wording]");
  check(
    "Arabic counts its days",
    lib.daysPhrase(1, "ar") === "يوم واحد" && lib.daysPhrase(2, "ar") === "يومين" && lib.daysPhrase(3, "ar") === "3 أيام" && lib.daysPhrase(14, "ar") === "14 يوماً"
  );
  check("English too", lib.daysPhrase(1, "en") === "1 day" && lib.daysPhrase(5, "en") === "5 days");
  check("a leave's last day is inclusive", lib.leaveUntil("2026-11-28", 3) === "2026-11-30" && lib.leaveUntil("2026-11-28", 1) === "2026-11-28");
  check("and crosses a month", lib.leaveUntil("2026-11-30", 2) === "2026-12-01");
  check("age is whole years on the day", lib.ageOn("1990-11-29", "2026-11-28") === 35 && lib.ageOn("1990-11-28", "2026-11-28") === 36 && lib.ageOn(null, "2026-11-28") === null);
  const base = { kind: "sick_leave" as const, addressee: "", body: "", diagnosis: "", leaveFrom: "2026-11-28", leaveDays: 2 };
  check("a sick leave needs its days", lib.letterProblem({ ...base, leaveDays: null }) === "leave" && lib.letterProblem(base) === null);
  check("a referral needs whom it is to", lib.letterProblem({ ...base, kind: "referral", body: "x" }) === "addressee");
  check("a report needs something to say", lib.letterProblem({ ...base, kind: "report" }) === "body" && lib.letterProblem({ ...base, kind: "report", diagnosis: "x" }) === null);
  check("numbers read ML-0007", lib.letterNumber(7) === "ML-0007");
  check("a doctor who wrote letters cannot be deleted", memberHistorySql("$1").includes("medical_letters"));
  check("nor can a visit a letter was written at", appointmentAttachedSql("$1").includes("medical_letters"));

  /* ================================================================ fixture */
  const db = new Client({ connectionString: PG });
  await db.connect();
  const stamp = Date.now().toString(36);
  const slug = `qaml${stamp}`;
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency)
       values ('QA Letters Clinic','عيادة التقارير',$1,'ar','Asia/Amman','JOD') returning id`,
      [slug]
    )
  ).rows[0].id as string;
  await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1,'connected')`, [clinicId]);

  const mkUser = async (tag: string, name: string) =>
    (
      await db.query(
        `insert into users (email, password_hash, full_name, locale) values ($1,$2,$3,'ar') returning id`,
        [`${tag}-${slug}@test.local`, bcrypt.hashSync("password123", 10), name]
      )
    ).rows[0].id as string;
  const mkMember = async (userId: string, role: string, perms: unknown, owner = false) =>
    (
      await db.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
         values ($1,$2,$3,$4,$5) returning id`,
        [clinicId, userId, role, owner, JSON.stringify(perms)]
      )
    ).rows[0].id as string;

  const ownerId = await mkUser("owner", "مالك العيادة");
  await mkMember(ownerId, "other", { level: "full" }, true);
  const doctorId = await mkUser("doctor", "د. ليلى حداد");
  const doctorMember = await mkMember(doctorId, "doctor", { level: "full" });
  await db.query(`update clinic_members set license_no = 'L-55120', syndicate_no = '30417' where id = $1`, [doctorMember]);
  const deskId = await mkUser("desk", "موظف الاستقبال");
  await mkMember(deskId, "receptionist", { level: "custom", caps: { dashboard: true, patients: true } });

  const PHONE = "+962790771133";
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, gender, birth_date, custom_fields, source)
       values ($1,'رنا عيسى',$2,'female','1991-03-14','{"national_id": "9912345678"}','staff') returning id`,
      [clinicId, PHONE]
    )
  ).rows[0].id as string;
  const today = (await db.query(`select (now() at time zone 'Asia/Amman')::date::text as d`)).rows[0].d as string;

  const browser = await chromium.launch();
  {
    const p = await browser.newPage();
    await p.setContent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120"><path d="M10 90 C 40 10, 70 10, 90 80 S 150 110, 170 40" fill="none" stroke="#1b2a55" stroke-width="4"/></svg>`
    );
    const png = await p.locator("svg").screenshot({ omitBackground: true });
    await p.close();
    const saved = await saveFile(clinicId, "signatures", `qa-${stamp}.png`, png);
    await db.query(`update users set signature_png_path = $2 where id = $1`, [doctorId, saved.storagePath]);
  }
  console.log(`\n✓ fixture clinic ${slug}`);

  const ctx = async (email: string, viewport = { width: 1360, height: 900 }, touch = false) => {
    const c = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch && viewport.width < 600 });
    const pg = await c.newPage();
    // A cold dev server compiles the patient file on first open.
    pg.setDefaultNavigationTimeout(180_000);
    pg.setDefaultTimeout(90_000);
    await signIn(pg, email);
    await c.addCookies([{ name: "cos_locale", value: "ar", url: BASE }]);
    return { c, pg };
  };
  const openFile = async (pg: Page, tab?: string) => {
    await pg.goto(`${BASE}/c/${slug}/patients/${patient}${tab ? `?tab=${tab}` : ""}`);
    await pg.waitForLoadState("networkidle");
    await pg.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  };
  const dialog = (pg: Page) => pg.getByRole("dialog");

  try {
    /* ============================================================ a sick leave */
    console.log("\n[a doctor writes a sick leave and sends it]");
    const doc = await ctx(`doctor-${slug}@test.local`);
    await openFile(doc.pg);
    const quick = doc.pg.locator("[data-letter-new]");
    check("the file offers it in the header", (await quick.count()) === 1);
    await quick.click();
    await doc.pg.locator("[data-letter-composer]").waitFor();
    check("it opens on a sick leave", (await doc.pg.locator('[data-letter-kind="sick_leave"]').getAttribute("aria-checked")) === "true");
    // The doctors arrive with the prescription composer's data.
    await doc.pg.waitForFunction(() => {
      const s = document.querySelector("[data-letter-composer] select") as HTMLSelectElement | null;
      return !!s && !s.disabled && !!s.value;
    });
    await doc.pg.locator('[data-letter-days="3"]').click();
    const until = await doc.pg.locator("[data-letter-until]").innerText();
    check("it says when the leave ends", until.includes("3 أيام") && until.includes("شاملاً"), until);
    await doc.pg.getByRole("textbox", { name: T.diagnosis }).fill("التهاب لوزتين");
    await doc.pg.locator("[data-letter-send]").click();
    await doc.pg.locator("[data-letter-composer]").waitFor({ state: "detached", timeout: 90_000 });

    const l1 = (
      await db.query(
        `select l.*, l.leave_from::text as from_text, m.msg_type, m.media_mime, m.media_name, m.body as caption,
                cv.patient_id as thread_patient
           from medical_letters l
           left join messages m on m.id = l.message_id
           left join conversations cv on cv.id = m.conversation_id
          where l.clinic_id = $1 order by l.number`,
        [clinicId]
      )
    ).rows[0];
    check("it is saved, first in the series", l1?.number === 1 && l1?.kind === "sick_leave", String(l1?.number));
    check("three days from today", l1?.leave_days === 3 && l1?.from_text === today, `${l1?.leave_days} from ${l1?.from_text}`);
    check("in the doctor's name, licence copied, signed", l1?.doctor_member_id === doctorMember && l1?.doctor_license_no === "L-55120" && l1?.signed === true);
    check("its PDF exists", !!l1?.pdf_path);
    check("sent as one PDF document", l1?.msg_type === "document" && l1?.media_mime === "application/pdf", `${l1?.msg_type} ${l1?.media_mime}`);
    check("on the patient's own thread", l1?.thread_patient === patient);
    check("the caption names the letter", String(l1?.caption ?? "").includes("الإجازة المرضية"), String(l1?.caption ?? "").replace(/\n/g, " / "));
    check("and not the diagnosis", !String(l1?.caption ?? "").includes("التهاب لوزتين"));

    await doc.pg.waitForTimeout(800);
    const tabText = await doc.pg.locator("[data-letters-list]").innerText().catch(() => "");
    check("the Letters tab opens with it", tabText.includes(T.kinds.sick_leave) && tabText.includes("ML-0001"), tabText.slice(0, 120));

    /* ============================================================ the print page */
    console.log("\n[the print page]");
    const anon = await browser.newContext();
    const ap = await anon.newPage();
    const noKey = await ap.goto(`${BASE}/letter-print/${l1.id}`);
    check("without a key it is not there", noKey?.status() === 404, String(noKey?.status()));
    const rxKey = printKeyFor(l1.id, "prescription");
    const wrongKind = await ap.goto(`${BASE}/letter-print/${l1.id}?kind=prescription&exp=${rxKey.exp}&sig=${rxKey.sig}`);
    check("a prescription's key does not open a letter", wrongKind?.status() === 404, String(wrongKind?.status()));
    const k = printKeyFor(l1.id, "letter");
    const ok = await ap.goto(`${BASE}/letter-print/${l1.id}?kind=letter&exp=${k.exp}&sig=${k.sig}`);
    check("with its key it opens", ok?.status() === 200, String(ok?.status()));
    if (SHOTS) await ap.screenshot({ path: `${SHOTS}/letter-sick-leave.png`, fullPage: true });
    const sheet = (await ap.locator("main").innerText()).replace(/\s+/g, " ");
    check("it speaks of her as her", sheet.includes("المريضة") && sheet.includes("راجعت") && sheet.includes("طلبها"));
    check("with the days and the diagnosis", sheet.includes("3 أيام") && sheet.includes("التهاب لوزتين"));
    check("and who she is", sheet.includes("9912345678") && sheet.includes("رنا عيسى"));
    check("signed with the licence number", sheet.includes("L-55120") && sheet.includes("د. ليلى حداد"));
    const anonPdf = await anon.request.get(`${BASE}/api/c/${slug}/letters/${l1.id}/pdf`);
    check("signed out, the PDF is refused", [401, 403, 404].includes(anonPdf.status()) || anonPdf.url().includes("/login"), String(anonPdf.status()));
    await anon.close();

    /* ============================================================ a referral */
    console.log("\n[a referral refuses to go without an addressee, then prints]");
    await doc.pg.locator("[data-letter-new]").click();
    await doc.pg.locator("[data-letter-composer]").waitFor();
    await doc.pg.locator('[data-letter-kind="referral"]').click();
    await doc.pg.locator("[data-letter-body]").fill("ألم في العين اليمنى منذ أسبوع، مع احمرار.\nنرجو التقييم.");
    await doc.pg.locator("[data-letter-print]").click();
    await doc.pg.waitForTimeout(600);
    const composerText = await doc.pg.locator("[data-letter-composer]").innerText();
    check("without an addressee it says so and stays open", composerText.includes(T.needAddressee));
    const none = (await db.query(`select count(*)::int n from medical_letters where clinic_id = $1`, [clinicId])).rows[0].n;
    check("and saves nothing", none === 1, String(none));
    await doc.pg.locator("[data-letter-addressee]").fill("أخصائي العيون");
    await doc.pg.getByRole("checkbox", { name: T.urgent }).check();
    let pdfAsked = "";
    doc.c.on("request", (r) => {
      if (/\/letters\/[0-9a-f-]+\/pdf/.test(r.url())) pdfAsked = r.url();
    });
    const popupP = doc.pg.waitForEvent("popup", { timeout: 90_000 });
    await doc.pg.locator("[data-letter-print]").click();
    const popup = await popupP;
    await doc.pg.locator("[data-letter-composer]").waitFor({ state: "detached", timeout: 90_000 });
    await doc.pg.waitForTimeout(1500);
    check("print opens a tab pointed at the PDF", !!pdfAsked, pdfAsked || popup.url());
    await popup.close().catch(() => {});
    const l2 = (await db.query(`select * from medical_letters where clinic_id = $1 and number = 2`, [clinicId])).rows[0];
    check("printing saves it, not sent", !!l2 && l2.kind === "referral" && !l2.sent_at && !!l2.pdf_path);
    check("urgent, to whom it was written", l2?.urgent === true && l2?.addressee === "أخصائي العيون");
    check("a referral keeps no leave dates", l2?.leave_from === null && l2?.leave_days === null);
    if (SHOTS && l2) {
      const k2 = printKeyFor(l2.id, "letter");
      const rp = await browser.newPage();
      await rp.goto(`${BASE}/letter-print/${l2.id}?kind=letter&exp=${k2.exp}&sig=${k2.sig}`);
      await rp.screenshot({ path: `${SHOTS}/letter-referral.png`, fullPage: true });
      await rp.close();
    }

    await openFile(doc.pg, "notes");
    const feed = await doc.pg.locator('[data-feed-source="letter"]').count();
    check("its text joins the Notes feed", feed >= 1, String(feed));

    /* ============================================================ the desk */
    console.log("\n[the desk reads and reprints, and cannot write]");
    const desk = await ctx(`desk-${slug}@test.local`);
    await openFile(desk.pg, "letters");
    check("no header button for the desk", (await desk.pg.locator("[data-letter-new]").count()) === 0);
    const deskList = await desk.pg.locator("[data-letters-list]").innerText().catch(() => "");
    check("but the letters are in the file", deskList.includes("ML-0001") && deskList.includes("ML-0002"));
    check("without Write again or Resend", !deskList.includes(T.again) && !deskList.includes(T.resend));
    const deskPdf = await desk.pg.request.get(`${BASE}/api/c/${slug}/letters/${l1.id}/pdf`);
    const pdfBody = await deskPdf.body();
    check("the desk can reprint the PDF", deskPdf.status() === 200 && pdfBody.subarray(0, 5).toString("latin1") === "%PDF-", String(deskPdf.status()));
    await desk.c.close();

    /* ============================================================ phone */
    console.log("\n[on a phone]");
    const phone = await ctx(`doctor-${slug}@test.local`, { width: 390, height: 844 }, true);
    await openFile(phone.pg);
    await phone.pg.locator("[data-letter-new]").click();
    await phone.pg.locator("[data-letter-composer]").waitFor();
    for (const k of ["sick_leave", "referral"] as const) {
      await phone.pg.locator(`[data-letter-kind="${k}"]`).click();
      await phone.pg.waitForTimeout(300);
      if (SHOTS) await phone.pg.screenshot({ path: `${SHOTS}/letter-phone-${k}.png` });
      const s = await spills(phone.pg, "[role=dialog]");
      check(`the ${k} form fits the phone`, s.length === 0, describeSpills(s));
    }
    const kindBox = await phone.pg.locator('[data-letter-kind="referral"]').boundingBox();
    check("the kind buttons are thumb-sized", (kindBox?.height ?? 0) >= 40, `${Math.round(kindBox?.height ?? 0)}px`);
    await phone.c.close();
    await doc.c.close();
  } finally {
    await browser.close();
    await db.query(`delete from clinics where id = $1`, [clinicId]);
    await db.query(`delete from users where email like $1`, [`%-${slug}@test.local`]);
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
