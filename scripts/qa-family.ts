/**
 * Families (0127): a mother and the children she brings, from one phone.
 *
 *   - Reception adds a daughter with no phone from the mother's file, and
 *     links a son already on file. The mother becomes the parent and the
 *     contact; each child is said with their role and age, reached on her number.
 *   - Her number finds all three.
 *   - The booking panel books the children straight after her.
 *   - A child's file messages through the mother's thread; the inbox shows
 *     her family beside the chat.
 *   - One payment for the family goes on everyone's open invoices.
 *   - Removing a member, and a family of one is no family.
 *   - The card fits a phone.
 *
 *   npx tsx scripts/qa-family.ts
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { describeSpills, spills } from "./lib-layout";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SHOTS = process.env.QA_SHOTS_DIR || "";
const TZ = "Asia/Amman";
const ALL_DAYS = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["09:00", "17:00"]]]));
const MUM_PHONE = "+962790773301";

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
  const f = await import("../src/lib/families");
  const { ar } = await import("../src/lib/i18n/ar");
  console.log("\n[roles and ages]");
  check("a role is said in the member's gender", f.familyRoleLabel("parent", "female", ar.family) === "الأم" && f.familyRoleLabel("child", "male", ar.family) === "ابن");
  check("and in the neutral word without one", f.familyRoleLabel("child", null, ar.family) === ar.family.child);
  check("an age is whole years, the birthday counted", f.ageOn("2018-12-01", "2026-11-30") === 7 && f.ageOn("2018-11-30", "2026-11-30") === 8 && f.ageOn(null, "2026-11-30") === null);

  /* ================================================================ fixture */
  const db = new Client({ connectionString: PG });
  await db.connect();
  const stamp = Date.now().toString(36);
  const slug = `qafam${stamp}`;
  const clinicId = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, working_hours)
       values ('QA Family','عيادة العائلة',$1,'ar',$2,'JOD',$3) returning id`,
      [slug, TZ, JSON.stringify(ALL_DAYS)]
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
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1,$2,$3,$4,$5) returning id`,
        [clinicId, userId, role, owner, JSON.stringify(perms)]
      )
    ).rows[0].id as string;
  await mkMember(await mkUser("owner", "مالك العيادة"), "other", { level: "full" }, true);
  const doc = await mkMember(await mkUser("doc", "د. نادر الحسن"), "doctor", { level: "full" });
  await mkMember(await mkUser("desk", "موظفة الاستقبال"), "receptionist", {
    level: "custom",
    caps: { dashboard: true, calendar: true, patients: true, invoices: true, conversations: true },
  });
  const service = (
    await db.query(`insert into services (clinic_id, name, name_ar, duration_min, price, active) values ($1,'Checkup','فحص أسنان',30,20,true) returning id`, [clinicId])
  ).rows[0].id as string;
  const mum = (
    await db.query(`insert into patients (clinic_id, full_name, phone_e164, gender, source) values ($1,'هبة النجار',$2,'female','staff') returning id`, [clinicId, MUM_PHONE])
  ).rows[0].id as string;
  const son = (
    await db.query(`insert into patients (clinic_id, full_name, gender, birth_date, source) values ($1,'يزن النجار','male','2016-03-10','staff') returning id`, [clinicId])
  ).rows[0].id as string;
  // What each owes: the mother 20, the son 30.
  let seq = 0;
  const bill = async (patientId: string, total: number) =>
    db.query(
      `insert into invoices (clinic_id, patient_id, seq, number, status, total, issue_date) values ($1,$2,$3,$4,'sent',$5,current_date)`,
      [clinicId, patientId, ++seq, `QA-${String(seq).padStart(4, "0")}`, total]
    );
  await bill(mum, 20);
  await bill(son, 30);

  const browser = await chromium.launch();
  const ctx = async (email: string, viewport = { width: 1360, height: 900 }, touch = false) => {
    const c = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch && viewport.width < 600 });
    const pg = await c.newPage();
    pg.setDefaultNavigationTimeout(180_000);
    pg.setDefaultTimeout(90_000);
    await signIn(pg, email);
    await c.addCookies([{ name: "cos_locale", value: "ar", url: BASE }]);
    return { c, pg };
  };
  const go = async (pg: Page, path: string) => {
    await pg.goto(`${BASE}/c/${slug}${path}`);
    await pg.waitForLoadState("networkidle");
    await pg.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  };
  const daughterBirth = DateTime.now().setZone(TZ).minus({ years: 8, days: 3 }).toISODate()!;

  try {
    /* ============================================================ the card */
    console.log("\n[reception links the family from the mother's file]");
    const d = await ctx(`desk-${slug}@test.local`);
    await go(d.pg, `/patients/${mum}`);
    await d.pg.locator('[data-family="0"]').waitFor();
    check("a file with no family says how to start one", (await d.pg.locator('[data-family="0"]').innerText()).includes(ar.family.none.slice(0, 20)));
    await d.pg.locator("[data-family-add]").click();
    await d.pg.locator("[data-family-form]").waitFor();
    await d.pg.locator("[data-family-name]").fill("ليان النجار");
    await d.pg.locator("select[data-family-gender]").selectOption("female");
    await d.pg.locator("[data-family-birth]").fill(daughterBirth);
    await d.pg.locator("[data-family-save]").click();
    await d.pg.locator('[data-family="2"]').waitFor();
    const daughter = (await db.query(`select id, family_id, family_role, phone_e164 from patients where clinic_id = $1 and full_name = 'ليان النجار'`, [clinicId])).rows[0];
    check("the daughter is a new file with no phone, in the family as a child", !!daughter && !daughter.phone_e164 && daughter.family_role === "child" && !!daughter.family_id);
    const fam = (await db.query(`select f.contact_patient_id, p.family_role from patient_families f join patients p on p.family_id = f.id where p.id = $1`, [mum])).rows[0];
    check("the mother becomes the parent, and the contact", fam?.family_role === "parent" && fam?.contact_patient_id === mum, JSON.stringify(fam));

    // The son, already on file: found by name.
    await d.pg.locator("[data-family-add]").click();
    await d.pg.locator('[data-family-mode="file"]').click();
    await d.pg.locator("[data-family-form] input").first().fill("يزن");
    await d.pg.getByRole("button", { name: /يزن النجار/ }).click();
    await d.pg.locator("[data-family-save]").click();
    await d.pg.locator('[data-family="3"]').waitFor();
    check("the son on file joins the family", (await db.query(`select 1 from patients where id = $1 and family_id = $2`, [son, daughter.family_id])).rowCount === 1);

    const row = async (id: string) => (await d.pg.locator(`[data-family-member="${id}"]`).innerText()).replace(/\s+/g, " ");
    const mumRow = await row(mum);
    const sonRow = await row(son);
    const girlRow = await row(daughter.id);
    check("the mother is said as the mother and the contact", mumRow.includes("الأم") && mumRow.includes(ar.family.contact), mumRow);
    check("each child with their role and age", girlRow.includes("ابنة") && girlRow.includes("العمر 8") && sonRow.includes("ابن"), `${girlRow} | ${sonRow}`);
    check("and reached on the mother's number", girlRow.includes(ar.family.viaContact.replace("{name}", "هبة النجار")), girlRow);
    const reach = (await db.query(`select patient_reach_phone($1) as p`, [daughter.id])).rows[0].p;
    check("the database agrees on the number", reach === MUM_PHONE, String(reach));
    if (SHOTS) await d.pg.locator("[data-family]").screenshot({ path: `${SHOTS}/family-card.png` });

    /* ============================================================ search */
    console.log("\n[her number finds them all]");
    const found = await d.pg.request.get(`${BASE}/api/c/${slug}/patients/search?q=0790773301`);
    const names = ((await found.json()).results as { full_name: string }[]).map((r) => r.full_name);
    check("searching her number lists her children too", ["هبة النجار", "ليان النجار", "يزن النجار"].every((n) => names.includes(n)), names.join(", "));

    /* ============================================================ paying */
    console.log("\n[one payment for the family]");
    const owed = await d.pg.locator("[data-family-owed]").getAttribute("data-family-owed");
    check("the card says what the family owes together", Number(owed) === 50, String(owed));
    await d.pg.locator('[data-take-payment="family"] button').click();
    await d.pg.locator("[data-take-payment-amount]").waitFor();
    check("the payment starts at the whole family's balance", (await d.pg.locator("[data-take-payment-amount]").inputValue()) === "50");
    await d.pg.locator("[data-take-payment-save]").click();
    await d.pg.locator("[data-take-payment-receipts]").waitFor();
    const paid = (await db.query(`select p.patient_id, sum(p.amount)::float as n from payments p where p.clinic_id = $1 group by p.patient_id`, [clinicId])).rows;
    check(
      "it lands on each member's own invoice",
      paid.length === 2 && paid.some((r) => r.patient_id === mum && r.n === 20) && paid.some((r) => r.patient_id === son && r.n === 30),
      JSON.stringify(paid)
    );
    const receipts = (await d.pg.locator("[data-take-payment-receipts]").innerText()).replace(/\s+/g, " ");
    check("the receipts on offer say whose each is", receipts.includes("يزن النجار") && receipts.includes("هبة النجار"), receipts);
    await d.pg.keyboard.press("Escape");

    /* ============================================================ booking */
    console.log("\n[the children are booked straight after her]");
    await go(d.pg, `/calendar?patient=${mum}`);
    const panel = d.pg.locator('[data-appointment-panel="new"]');
    await panel.waitFor();
    await panel.locator("[data-panel-also]").waitFor();
    check("the panel offers the rest of her family", (await panel.locator("[data-panel-also-member]").count()) === 2);
    const day = DateTime.now().setZone(TZ).plus({ days: 3 }).toISODate()!;
    await panel.locator("select[data-add-service]").selectOption(service);
    await panel.locator("select[data-doctor-select]").selectOption(doc);
    await panel.locator('input[type="date"]').fill(day);
    await panel.locator('input[type="time"]').fill("10:00");
    await panel.locator(`[data-panel-also-member="${daughter.id}"]`).click();
    await panel.locator(`[data-panel-also-member="${son}"]`).click();
    await panel.locator("[data-panel-save]").click();
    let appts: { patient_id: string; starts_at: Date }[] = [];
    for (let i = 0; i < 40 && appts.length < 3; i++) {
      await d.pg.waitForTimeout(500);
      appts = (await db.query(`select patient_id, starts_at from appointments where clinic_id = $1 order by starts_at`, [clinicId])).rows;
    }
    const at = appts.map((a) => `${a.patient_id === mum ? "mum" : a.patient_id === son ? "son" : "girl"}@${DateTime.fromJSDate(a.starts_at).setZone(TZ).toFormat("HH:mm")}`);
    check("three visits, one after another", at.join(",") === "mum@10:00,girl@10:30,son@11:00", at.join(","));
    const triggers = (await db.query(`select count(*)::int as n from jobs where clinic_id = $1 and kind = 'trigger:appointment_created'`, [clinicId])).rows[0].n;
    check("each is a visit of its own", triggers === 3, String(triggers));

    /* ============================================================ messages */
    console.log("\n[a child's messages reach the mother]");
    await go(d.pg, `/patients/${daughter.id}`);
    const header = (await d.pg.locator("[data-header-reach]").innerText().catch(() => "")).trim();
    check("the child's file says whose number she is reached on", header.includes("هبة النجار"), header);
    await d.pg.locator("[data-header-message]").click();
    await d.pg.waitForURL((u) => u.pathname.endsWith("/conversations") && u.searchParams.has("open"));
    const conv = (await db.query(`select phone_e164, patient_id from conversations where id = $1`, [new URL(d.pg.url()).searchParams.get("open")])).rows[0];
    check("Message opens the mother's thread, filed under her", conv?.phone_e164 === MUM_PHONE && conv?.patient_id === mum, JSON.stringify(conv));
    await d.pg.waitForLoadState("networkidle");
    await d.pg.locator("[data-inbox-family]").first().waitFor();
    check("the inbox shows her family beside the chat", (await d.pg.locator("[data-inbox-family-member]").count()) >= 2);
    if (SHOTS) await d.pg.locator("[data-patient-panel]").first().screenshot({ path: `${SHOTS}/family-inbox.png` });

    /* ============================================================ removing */
    console.log("\n[a member leaves]");
    await go(d.pg, `/patients/${mum}`);
    await d.pg.locator(`[data-family-remove="${son}"]`).click();
    await d.pg.getByRole("dialog").locator("button").last().click();
    await d.pg.locator('[data-family="2"]').waitFor();
    check("the son leaves the family, his file stays", (await db.query(`select 1 from patients where id = $1 and family_id is null and merged_into is null`, [son])).rowCount === 1);
    await d.pg.locator(`[data-family-remove="${daughter.id}"]`).click();
    await d.pg.getByRole("dialog").locator("button").last().click();
    await d.pg.locator('[data-family="0"]').waitFor();
    const left = (await db.query(`select count(*)::int as n from patient_families where clinic_id = $1`, [clinicId])).rows[0].n;
    check("a family of one is no family", left === 0 && (await db.query(`select 1 from patients where id = $1 and family_id is null`, [mum])).rowCount === 1, String(left));
    await d.c.close();

    /* ============================================================ phone */
    console.log("\n[on a phone]");
    await db.query(`insert into patient_families (clinic_id, contact_patient_id) values ($1,$2)`, [clinicId, mum]);
    await db.query(`update patients set family_id = (select id from patient_families where clinic_id = $1), family_role = case when id = $2 then 'parent' else 'child' end where id = any($3::uuid[])`, [clinicId, mum, [mum, son, daughter.id]]);
    const ph = await ctx(`desk-${slug}@test.local`, { width: 390, height: 844 }, true);
    await go(ph.pg, `/patients/${mum}`);
    await ph.pg.locator('[data-family="3"]').waitFor();
    const sp = await spills(ph.pg, "[data-family]");
    check("the family card fits a phone", sp.length === 0, describeSpills(sp));
    const book = await ph.pg.locator(`[data-family-book="${son}"]`).boundingBox();
    check("Book is thumb-sized", (book?.height ?? 0) >= 40, `${Math.round(book?.height ?? 0)}px`);
    if (SHOTS) await ph.pg.locator("[data-family]").screenshot({ path: `${SHOTS}/family-phone.png` });
    await ph.c.close();
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
