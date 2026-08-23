/**
 * Everything that sends on its own, and the page that now claims to list it.
 *
 * Three things shipped together and this covers all three, because their
 * failure modes are the same shape: something goes out, or fails to go out, and
 * nothing on any screen says so.
 *
 *   - the platform's own messages, now readable and editable per clinic
 *   - doctor and team alerts, now rows rather than four hardcoded rules
 *   - the specialty pack a clinic is handed on its first day
 *
 * The negative assertions are the interesting ones: a message a clinic must not
 * be able to silence stays on however it is asked; a switched-off waitlist offer
 * leaves the queue untouched rather than burning everybody's cooldown; a
 * clinic's own wording does not leak into the clinic next door.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client } from "pg";
import { chromium } from "playwright";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import {
  SYSTEM_MESSAGES,
  renderSystemMessage,
  systemMessage,
  loadSystemMessages,
} from "../src/lib/system-messages";
import { DEFAULT_STAFF_ALERTS, seedStaffAlerts } from "../src/lib/staff-alerts";
import { RECIPES } from "./seed-recipes";
import { SPECIALTY_RECIPES } from "./specialty-recipes";
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

async function main() {
  const { doctorReminders, dailyDigests, sendDigest } = await import("../worker/notifications");
  const { offerFreedSlot } = await import("../worker/waitlist");

  const db = new Client({ connectionString: PG });
  await db.connect();

  /* ================================================================== */
  console.log("\n[the registry itself]");

  check(
    "every built-in message has both languages",
    SYSTEM_MESSAGES.every((m) => m.ar.trim() && m.en.trim())
  );
  check(
    "no default leaves an unfilled token when every variable is known",
    SYSTEM_MESSAGES.every((m) => {
      const vars = Object.fromEntries(m.vars.map((v) => [v, "x"]));
      const out = renderSystemMessage(m.ar, vars) + renderSystemMessage(m.en, vars);
      return !out.includes("{{");
    })
  );
  check(
    "every token a default uses is offered as a chip",
    SYSTEM_MESSAGES.every((m) => {
      const used = [...`${m.ar}\n${m.en}`.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((x) => x[1]);
      return used.every((u) => m.vars.includes(u));
    })
  );
  check(
    "the dictionary names and explains all of them",
    SYSTEM_MESSAGES.every(
      (m) =>
        (ar.automations.messageNames as Record<string, string>)[m.key] &&
        (ar.automations.messageWhen as Record<string, string>)[m.key]
    )
  );

  console.log("\n[the empty-line rule]");
  const withGap = "a\n{{x}}\n\nb";
  check(
    "a line that was only an empty variable disappears",
    renderSystemMessage(withGap, { x: "" }) === "a\n\nb",
    JSON.stringify(renderSystemMessage(withGap, { x: "" }))
  );
  check(
    "and stays when the variable has a value",
    renderSystemMessage(withGap, { x: "v" }) === "a\nv\n\nb"
  );
  check(
    "a deliberate blank line between paragraphs survives",
    renderSystemMessage("{{a}}\n\n{{b}}", { a: "1", b: "2" }) === "1\n\n2"
  );
  check(
    "a line with text around an empty variable is kept",
    renderSystemMessage("total: {{n}}", { n: "" }) === "total:",
    renderSystemMessage("total: {{n}}", { n: "" })
  );

  /* ================================================================== fixture */
  const slug = `qaauto${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, specialty)
       values ('QA Automation','أتمتة',$1,'ar','Asia/Amman','dental') returning id`,
      [slug]
    )
  ).rows[0];
  const clinicId = clinic.id as string;
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinicId]);
  await db.query(`insert into booking_links (clinic_id, slug, name) values ($1,$2,'Default')`, [
    clinicId,
    slug,
  ]);
  await seedStaffAlerts(db as never, clinicId);

  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale) values ($1,$2,'QA Owner','ar') returning id`,
      [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinicId, owner.id]
  );
  const docUser = (
    await db.query(`insert into users (email, full_name) values ($1,'QA Doctor') returning id`, [
      `doc-${slug}@test.local`,
    ])
  ).rows[0];
  const doctor = (
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role, reminder_minutes)
       values ($1,$2,'doctor',30) returning id`,
      [clinicId, docUser.id]
    )
  ).rows[0];
  console.log(`\n✓ fixture clinic ${slug}`);

  /* ================================================================== */
  console.log("\n[a clinic's own wording]");

  const before = await systemMessage(db as never, {
    clinicId,
    key: "booking_confirmed",
    lang: "ar",
    vars: { "patient.first_name": "سارة", "clinic.name": "عيادة", "appointment.when": "غداً" },
  });
  check("out of the box, the default is used", before.body.includes("تم تأكيد موعدك"), before.body.split("\n")[1]);
  check(
    "an unset optional variable takes its whole line with it",
    !before.body.includes("\n\n") && !/^\s*$/m.test(before.body),
    JSON.stringify(before.body)
  );

  await db.query(
    `insert into clinic_system_messages (clinic_id, key, enabled, body_ar, body_en)
     values ($1,'booking_confirmed',true,$2,'')`,
    [clinicId, "خاص بالعيادة: {{patient.first_name}}"]
  );
  const after = await systemMessage(db as never, {
    clinicId,
    key: "booking_confirmed",
    lang: "ar",
    vars: { "patient.first_name": "سارة" },
  });
  check("the override replaces it", after.body === "خاص بالعيادة: سارة", after.body);

  const enAfter = await systemMessage(db as never, {
    clinicId,
    key: "booking_confirmed",
    lang: "en",
    vars: { "patient.first_name": "Sara", "clinic.name": "Clinic", "appointment.when": "tomorrow" },
  });
  check(
    "an empty override body falls back to the default rather than sending nothing",
    enAfter.body.includes("is confirmed"),
    enAfter.body.split("\n")[1]
  );

  const neighbour = (
    await db.query(
      `insert into clinics (name, slug, default_locale) values ('Neighbour',$1,'ar') returning id`,
      [`${slug}-nb`]
    )
  ).rows[0];
  const nb = await systemMessage(db as never, {
    clinicId: neighbour.id,
    key: "booking_confirmed",
    lang: "ar",
    vars: { "patient.first_name": "خالد", "clinic.name": "الجيران" },
  });
  check("the clinic next door is unaffected", !nb.body.includes("خاص بالعيادة"), nb.body.split("\n")[0]);

  /* ================================================================== */
  console.log("\n[what can and cannot be silenced]");

  await db.query(
    `insert into clinic_system_messages (clinic_id, key, enabled) values ($1,'booking_otp',false)
     on conflict (clinic_id, key) do update set enabled = false`,
    [clinicId]
  );
  const otp = await systemMessage(db as never, {
    clinicId,
    key: "booking_otp",
    lang: "ar",
    vars: { code: "123456", "clinic.name": "عيادة" },
  });
  check(
    "a verification code goes out even with the row switched off",
    otp.enabled && otp.body.includes("123456"),
    otp.body
  );

  await db.query(
    `insert into clinic_system_messages (clinic_id, key, enabled) values ($1,'document_reminder',false)
     on conflict (clinic_id, key) do update set enabled = false`,
    [clinicId]
  );
  const rem = await systemMessage(db as never, {
    clinicId,
    key: "document_reminder",
    lang: "ar",
    vars: { "clinic.name": "عيادة", "document.title": "إقرار", link: "http://x" },
  });
  check("a reminder the clinic switched off reports itself off", !rem.enabled);

  /* ================================================================== */
  console.log("\n[a switched-off waitlist offer costs nobody their place]");

  const waiting = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source)
       values ($1,'منتظرة','+962790700001','staff') returning id`,
      [clinicId]
    )
  ).rows[0];
  await db.query(
    `insert into waitlist_entries (clinic_id, patient_id, doctor_member_id) values ($1,$2,$3)`,
    [clinicId, waiting.id, doctor.id]
  );
  await db.query(
    `insert into clinic_system_messages (clinic_id, key, enabled) values ($1,'waitlist_offer',false)
     on conflict (clinic_id, key) do update set enabled = false`,
    [clinicId]
  );
  const soon = new Date(Date.now() + 3 * 86400000).toISOString();
  const offeredNone = await offerFreedSlot({
    clinicId,
    appointmentId: "00000000-0000-0000-0000-000000000000",
    doctorMemberId: doctor.id,
    serviceId: null,
    startsAt: soon,
  });
  check("nothing is offered", offeredNone === 0, String(offeredNone));
  const stillWaiting = await db.query(
    `select status, offers_sent from waitlist_entries where clinic_id = $1`,
    [clinicId]
  );
  check(
    "the entry keeps its place and its cooldown",
    stillWaiting.rows[0].status === "waiting" && stillWaiting.rows[0].offers_sent === 0,
    `${stillWaiting.rows[0].status}/${stillWaiting.rows[0].offers_sent}`
  );

  await db.query(
    `update clinic_system_messages set enabled = true, body_ar = $2
       where clinic_id = $1 and key = 'waitlist_offer'`,
    [clinicId, "صار في دور: {{patient.first_name}} — {{link}}"]
  );
  const offeredNow = await offerFreedSlot({
    clinicId,
    appointmentId: "00000000-0000-0000-0000-000000000001",
    doctorMemberId: doctor.id,
    serviceId: null,
    startsAt: soon,
  });
  check("switching it back on offers again", offeredNow === 1, String(offeredNow));
  const offerMsg = await db.query(
    `select body from messages where clinic_id = $1 and direction = 'out' order by created_at desc limit 1`,
    [clinicId]
  );
  check(
    "and the offer is sent in the clinic's own words",
    (offerMsg.rows[0]?.body ?? "").startsWith("صار في دور: منتظرة"),
    offerMsg.rows[0]?.body ?? "none"
  );

  /* ================================================================== */
  console.log("\n[doctor and team alerts]");

  const seeded = await db.query(
    `select kind, roles, minutes_before, at_hour, threshold from clinic_staff_alerts
      where clinic_id = $1 order by sort`,
    [clinicId]
  );
  check(
    "a new clinic starts with exactly what the worker used to hardcode",
    seeded.rowCount === DEFAULT_STAFF_ALERTS.length &&
      seeded.rows[0].kind === "appointment_reminder" &&
      seeded.rows[0].minutes_before === null &&
      seeded.rows[2].at_hour === 20,
    `${seeded.rowCount} rows`
  );

  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164, source)
       values ($1,'مريض التذكير','+962790700002','staff') returning id`,
      [clinicId]
    )
  ).rows[0];
  /**
   * An appointment whose reminder moment has just passed.
   *
   * Twenty seconds inside the ninety-second window, not outside it: the query
   * fires when `starts_at - lead <= now()`, so an appointment a fraction more
   * than `lead` away is one the reminder is still waiting on.
   */
  const appointmentIn = async (leadMinutes: number) =>
    (
      await db.query(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, starts_at, ends_at, status)
         values ($1,$2,$3, now() + ($4 * interval '1 minute') - interval '20 seconds',
                 now() + ($4 * interval '1 minute') + interval '30 minutes', 'confirmed')
         returning id`,
        [clinicId, patient.id, doctor.id, leadMinutes]
      )
    ).rows[0].id as string;

  const apptA = await appointmentIn(30);
  await doctorReminders();
  const told = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'doctor_reminder'`,
    [clinicId]
  );
  check("the doctor's own setting still drives the seeded reminder", told.rows[0].n === 1, `${told.rows[0].n}`);

  await doctorReminders();
  const again = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'doctor_reminder'`,
    [clinicId]
  );
  check("a second tick inside the window does not repeat it", again.rows[0].n === 1, `${again.rows[0].n}`);

  // A second alert, on its own lead time and audience.
  const extra = (
    await db.query(
      `insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, sort)
       values ($1,'appointment_reminder',array['doctor','receptionist']::text[],120,9) returning id`,
      [clinicId]
    )
  ).rows[0];
  const apptB = await appointmentIn(120);
  await doctorReminders();
  const byUser = await db.query(
    `select user_id, count(*)::int n from notifications
      where clinic_id = $1 and kind = 'doctor_reminder' group by user_id`,
    [clinicId]
  );
  const docCount = byUser.rows.find((r) => r.user_id === docUser.id)?.n ?? 0;
  const ownerCount = byUser.rows.find((r) => r.user_id === owner.id)?.n ?? 0;
  check("an added alert fires on its own lead time", docCount === 2, `doctor got ${docCount}`);
  check("and reaches the extra audience it names", ownerCount === 1, `owner got ${ownerCount}`);

  await db.query(`update clinic_staff_alerts set enabled = false where id = $1`, [extra.id]);
  const apptC = await appointmentIn(120);
  await doctorReminders();
  const afterOff = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'doctor_reminder'`,
    [clinicId]
  );
  check("switching an alert off silences it", afterOff.rows[0].n === 3, `${afterOff.rows[0].n}`);

  await db.query(`delete from clinic_staff_alerts where id = $1`, [extra.id]);
  const gone = await db.query(
    `select count(*)::int n from clinic_staff_alerts where clinic_id = $1`,
    [clinicId]
  );
  check("and deleting one removes it for good", gone.rows[0].n === DEFAULT_STAFF_ALERTS.length);

  /* --- the morning digest: when it fires, and what it says --- */
  /*
    The hour gate and the digest body are checked apart, because they fail
    differently. The gate is a clock comparison and the only honest way to test
    it without owning the clock is the negative: set an hour that is not now and
    prove nothing goes out. The body is then driven directly, with the moment
    passed in.
  */
  const localNow = DateTime.now().setZone("Asia/Amman");
  const notNow = (localNow.hour + 5) % 24;
  await db.query(
    `update clinic_staff_alerts set at_hour = $2, roles = array['doctor','receptionist']::text[]
      where clinic_id = $1 and kind = 'day_schedule'`,
    [clinicId, notNow]
  );
  await dailyDigests();
  const tooEarly = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'daily_summary'`,
    [clinicId]
  );
  check(
    "a digest set for another hour stays quiet",
    tooEarly.rows[0].n === 0,
    `${tooEarly.rows[0].n} at ${notNow}:00 vs now ${localNow.hour}:00`
  );

  const dayAlert = (
    await db.query(
      `select a.id, a.clinic_id, a.kind, a.roles, a.at_hour, a.threshold,
              cl.slug, cl.timezone, cl.currency
         from clinic_staff_alerts a join clinics cl on cl.id = a.clinic_id
        where a.clinic_id = $1 and a.kind = 'day_schedule'`,
      [clinicId]
    )
  ).rows[0];
  await sendDigest(db as never, dayAlert, localNow.set({ hour: 9, minute: 1 }));
  const digests = await db.query(
    `select user_id, title from notifications where clinic_id = $1 and kind = 'daily_summary'`,
    [clinicId]
  );
  check(
    "the morning list reaches everyone the alert names",
    digests.rowCount === 2,
    `${digests.rowCount} recipients`
  );
  check(
    "the doctor is sent their own list",
    digests.rows.some((r) => r.user_id === docUser.id && r.title.includes("جدول اليوم")),
    digests.rows.find((r) => r.user_id === docUser.id)?.title ?? "none"
  );
  check(
    "reception is sent the clinic's",
    digests.rows.some((r) => r.user_id === owner.id && r.title.includes("مواعيد العيادة")),
    digests.rows.find((r) => r.user_id === owner.id)?.title ?? "none"
  );

  /* ================================================================== */
  console.log("\n[the specialty pack]");

  const packs = await db.query(
    `select specialty, count(*)::int n from recipe_templates where active group by specialty`
  );
  check(
    "the library has a general set and per-field packs",
    packs.rows.length > 1 && packs.rows.some((r) => r.specialty === "dental"),
    packs.rows.map((r) => `${r.specialty}:${r.n}`).join(" ")
  );
  check(
    "every specialty recipe declares a real specialty",
    SPECIALTY_RECIPES.every((r) => r.specialty && r.specialty !== "general")
  );
  check(
    "and every general recipe leaves it alone",
    RECIPES.every((r) => !r.specialty || r.specialty === "general")
  );

  const forDental = await db.query(
    `select count(*)::int n from recipe_templates where active and specialty in ('general','dental')`
  );
  const generalOnly = await db.query(
    `select count(*)::int n from recipe_templates where active and specialty = 'general'`
  );
  check(
    "a dental clinic is offered more than a general one",
    forDental.rows[0].n > generalOnly.rows[0].n,
    `${forDental.rows[0].n} vs ${generalOnly.rows[0].n}`
  );
  const leaked = await db.query(
    `select count(*)::int n from recipe_templates
      where active and specialty not in ('general','dental')
        and key in (select key from recipe_templates where specialty in ('general','dental'))`
  );
  check("and never another field's", leaked.rows[0].n === 0);

  // Install the pack the way clinic creation does, then prove it is additive.
  const install = async () => {
    const rows = await db.query(
      `select * from recipe_templates
        where active and specialty in ('general','dental')
          and key not in (select recipe_key from automations where clinic_id = $1 and recipe_key is not null)
        order by sort`,
      [clinicId]
    );
    for (const r of rows.rows) {
      await db.query(
        `insert into automations (clinic_id, name, description, trigger_type, trigger_config, active, recipe_key, recipe_specialty)
         values ($1,$2,$3,$4,$5,false,$6,$7)`,
        [clinicId, r.name_ar || r.name, r.description, r.trigger_type,
         JSON.stringify(r.trigger_config ?? {}), r.key, r.specialty]
      );
    }
    return rows.rowCount ?? 0;
  };
  const first = await install();
  const second = await install();
  check("installing the pack copies it in", first === forDental.rows[0].n, `${first}`);
  check("running it again adds nothing", second === 0, `${second}`);
  const dentalCopies = await db.query(
    `select count(*)::int n from automations where clinic_id = $1 and recipe_specialty = 'dental'`,
    [clinicId]
  );
  check("the copies remember which pack they came from", dentalCopies.rows[0].n > 0, `${dentalCopies.rows[0].n}`);
  const anyOn = await db.query(
    `select count(*)::int n from automations where clinic_id = $1 and recipe_specialty = 'dental' and active`,
    [clinicId]
  );
  check("and none of them arrives switched on", anyOn.rows[0].n === 0);

  /* ================================================================== */
  console.log("\n[the page itself]");

  const messages = await loadSystemMessages(db as never, clinicId);
  check(
    "the page is handed every built-in message",
    Object.keys(messages).length === SYSTEM_MESSAGES.length,
    `${Object.keys(messages).length}`
  );

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', `owner-${slug}@test.local`);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });

    await page.goto(`${BASE}/c/${slug}/automations`);
    await page.waitForLoadState("networkidle");
    // The dev overlay floats above the page and swallows clicks aimed at it.
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await page.waitForSelector('[role="tablist"]', { timeout: 60_000 });

    /*
      innerText, never textContent. The whole dictionary ships inside every
      page, so a textContent check for an Arabic string passes on any screen in
      the product and proves nothing about this one.
    */
    const visible = async () => (await page.locator("main").first().innerText()).replace(/\s+/g, " ");

    const flows = await visible();
    check(
      "the flows tab still lists the automations",
      flows.includes(ar.automations.recipes) && flows.includes(ar.automations.sendingWindow),
      ""
    );
    check(
      "and groups the specialty pack under its own heading",
      flows.includes(ar.automations.specialtyPack.replace("{specialty}", ar.specialties.dental)),
      ""
    );

    await page.getByRole("tab", { name: ar.automations.tabMessages }).click();
    await page.waitForTimeout(300);
    const msgs = await visible();
    const missing = SYSTEM_MESSAGES.filter(
      (m) => !msgs.includes((ar.automations.messageNames as Record<string, string>)[m.key])
    );
    check("every built-in message is on the page", missing.length === 0, missing.map((m) => m.key).join(", "));
    check("each says when it is sent", msgs.includes(ar.automations.messageWhen.booking_otp), "");
    check("the ones that cannot be silenced say so", msgs.includes(ar.automations.alwaysOn), "");

    // Editing one from the UI must actually reach the database.
    await page
      .getByRole("button", { name: ar.automations.messageNames.document_signed_copy })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 15_000 });
    const arBox = dialog.locator("textarea").first();
    await arBox.fill("نسختك جاهزة يا {{patient.first_name}}");
    await dialog.getByRole("button", { name: ar.common.save }).click();
    await page.waitForTimeout(1200);
    const saved = await db.query(
      `select body_ar from clinic_system_messages where clinic_id = $1 and key = 'document_signed_copy'`,
      [clinicId]
    );
    check(
      "an edit made on the page is what the platform then sends",
      (saved.rows[0]?.body_ar ?? "").startsWith("نسختك جاهزة"),
      saved.rows[0]?.body_ar ?? "not saved"
    );

    await page.getByRole("tab", { name: ar.automations.tabAlerts }).click();
    await page.waitForTimeout(300);
    const alertsText = await visible();
    check(
      "the team alerts are listed",
      alertsText.includes(ar.automations.alertKinds.appointment_reminder) &&
        alertsText.includes(ar.automations.alertKinds.day_end),
      ""
    );
    check(
      "the seeded reminder says it follows each person's own setting",
      alertsText.includes(ar.automations.ownSetting),
      ""
    );
    check("and a new one can be added", alertsText.includes(ar.automations.addAlert), "");

    // Add one through the UI, end to end.
    await page.getByRole("button", { name: ar.automations.addAlert }).first().click();
    const alertDialog = page.getByRole("dialog");
    await alertDialog.waitFor({ timeout: 15_000 });
    await alertDialog.getByRole("button", { name: ar.common.save }).click();
    await page.waitForTimeout(1200);
    const nowRows = await db.query(
      `select count(*)::int n from clinic_staff_alerts where clinic_id = $1`,
      [clinicId]
    );
    check(
      "adding an alert on the page creates a row",
      nowRows.rows[0].n === DEFAULT_STAFF_ALERTS.length + 1,
      `${nowRows.rows[0].n}`
    );

    /*
      A phone must not scroll sideways, on all three tabs. 320 as well as 390:
      an iPhone SE is where a row that fits by a few pixels stops fitting, and
      every one of these tabs is a row of a switch, two lines of text and two
      icon buttons.
    */
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const tab of [ar.automations.tabFlows, ar.automations.tabMessages, ar.automations.tabAlerts]) {
        await page.getByRole("tab", { name: tab }).click();
        await page.waitForTimeout(250);
        const w = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        check(`${tab} fits a ${width}px phone`, w <= 1, `${w}px overflow`);
      }
    }
  } finally {
    await browser.close();
  }

  /* ================================================================== */
  await db.query(`delete from clinics where id = any($1::uuid[])`, [[clinicId, neighbour.id]]);
  await db.query(`delete from users where email like $1`, [`%-${slug}@test.local`]);
  void apptA;
  void apptB;
  void apptC;
  await db.end();

  console.log(`\n${failures.length ? "✗" : "✓"} ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
