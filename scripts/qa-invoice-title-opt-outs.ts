/**
 * QA: naming an invoice, choosing which invoices are filed, and muting a patient.
 *
 * Three separate features that share one shape — something that used to be true
 * for every row is now decided per row — and therefore share one failure mode:
 * the new choice is honoured in the place it is made and quietly ignored by one
 * of the four other paths that reach the same outcome.
 *
 * So the assertions that matter here are the ones about the paths nobody is
 * looking at. An invoice opted out of JoFotara must still be opted out when the
 * nightly sweep runs at 4am and when somebody records a payment against it. A
 * muted patient must still be muted when a campaign that was built before they
 * asked finally reaches their name in the list, and when a birthday automation
 * fires from the scheduler rather than from a trigger.
 *
 * Nothing here contacts ISTD. The filing checks stop at "was it queued", which
 * is the decision under test; scripts/qa-einvoicing.ts owns what happens after.
 */
try { process.loadEnvFile?.(); } catch {}

import { Client, type PoolClient } from "pg";
import { chromium } from "playwright";
import bcrypt from "bcryptjs";
import { enqueueEinvoiceSubmit } from "../src/lib/einvoice/jobs";
import { startRun } from "../worker/automations";
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
  const db = new Client({ connectionString: PG });
  await db.connect();
  /*
    The library functions under test take a pooled client. This suite runs a
    single connection as the superuser — which is also what gives it the reach
    to inspect two clinics at once — and the two are interchangeable for
    everything called below.
  */
  const c = db as unknown as PoolClient;

  const stamp = Date.now().toString(36);
  const email = `qaopt-${stamp}@test.local`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone, currency, invoice_prefix, features)
       values ('QA Options','خيارات',$1,'ar','Asia/Amman','JOD','QAO',$2) returning id`,
      [`qaopt${stamp}`, JSON.stringify({ einvoicing: true, campaigns: true, automations: true })]
    )
  ).rows[0];
  const slug = `qaopt${stamp}`;
  const user = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale)
       values ($1,$2,'QA Owner','ar') returning id`,
      [email, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, user.id]
  );
  /*
    The campaign pump refuses to run for a clinic with no connected number —
    correctly, since there would be nothing to send with. Without this row the
    drip assertions below would pass by never executing.
  */
  await db.query(`insert into whatsapp_sessions (clinic_id, status) values ($1,'connected')`, [
    clinic.id,
  ]);
  await db.query(
    `insert into clinic_einvoice_settings
       (clinic_id, enabled, taxpayer_type, registered_name, tax_number, income_source_sequence, client_id, secret_key)
     values ($1, true, 'general', 'QA Options', '11223344', '9001', 'cid', 'sk')`,
    [clinic.id]
  );

  const mkPatient = async (name: string) =>
    (
      await db.query(
        `insert into patients (clinic_id, full_name, phone_e164, source)
         values ($1,$2,$3,'staff') returning id`,
        [clinic.id, name, `+96279${Math.floor(1000000 + Math.random() * 8999999)}`]
      )
    ).rows[0].id as string;

  const listener = await mkPatient("QA Listener");
  const muted = await mkPatient("QA Muted");
  await db.query(`update patients set automation_opt_out = true where id = $1`, [muted]);

  let seq = 0;
  /** An issued invoice, straight into the table — the create action is UI-tested below. */
  const mkInvoice = async (opts: { title?: string; file?: boolean; status?: string }) => {
    seq++;
    const r = await db.query(
      `insert into invoices (clinic_id, patient_id, seq, number, status, currency,
                             subtotal, discount_amount, tax_rate, tax_amount, total,
                             title, file_einvoice, issue_date)
       values ($1,$2,$3,$4,$5,'JOD',100,0,0,0,100,$6,$7,current_date) returning id`,
      [
        clinic.id, listener, seq, `QAO-2026-${String(seq).padStart(4, "0")}`,
        opts.status ?? "sent", opts.title ?? "", opts.file ?? true,
      ]
    );
    return r.rows[0].id as string;
  };
  console.log(`\n✓ fixtures: clinic ${slug}, one muted patient, one not`);

  /* ================================================================== */
  console.log("\n[an invoice's own name]");

  const untitled = await mkInvoice({});
  const titled = await mkInvoice({ title: "علاج عصب — الضاحك العلوي" });
  const stored = async (id: string) =>
    (await db.query(`select title from invoices where id = $1`, [id])).rows[0].title as string;

  check("an invoice raised without one has an empty title, not null", (await stored(untitled)) === "");
  check("a title is stored as given", (await stored(titled)) === "علاج عصب — الضاحك العلوي");
  const col = (
    await db.query(
      `select is_nullable, column_default from information_schema.columns
        where table_name = 'invoices' and column_name = 'title'`
    )
  ).rows[0];
  check(
    "the column cannot be null, so no read site has to decide what absent means",
    col.is_nullable === "NO" && String(col.column_default).startsWith("''"),
    `${col.is_nullable} / ${col.column_default}`
  );

  /* ================================================================== */
  console.log("\n[choosing which invoices go to JoFotara]");

  const optedOut = await mkInvoice({ file: false });
  const optedIn = await mkInvoice({ file: true });

  const queuedFor = async (id: string) =>
    Number(
      (
        await db.query(`select count(*)::int n from jobs where dedupe_key = $1`, [
          `einvoice:submit:${id}`,
        ])
      ).rows[0].n
    );
  const statusOf = async (id: string) =>
    (await db.query(`select einvoice_status from invoices where id = $1`, [id])).rows[0]
      .einvoice_status as string;

  const wentOut = await enqueueEinvoiceSubmit(c, clinic.id, optedOut, "paid");
  check("payment does not file an invoice the clinic opted out", wentOut === false);
  check("and it queues no job", (await queuedFor(optedOut)) === 0);
  check("and it stays 'not_required'", (await statusOf(optedOut)) === "not_required");

  const wentIn = await enqueueEinvoiceSubmit(c, clinic.id, optedIn, "paid");
  check("the same payment does file one that was left in", wentIn === true);
  check("which queues exactly one job", (await queuedFor(optedIn)) === 1);
  check("and moves it to 'pending'", (await statusOf(optedIn)) === "pending");

  /*
    The 4am sweep. It exists to catch invoices that were never paid and never
    sent, so it is precisely the path that would undo an opt-out a day later
    without anybody watching. Run as the query rather than the function, because
    the function is a clock away from being callable here.
  */
  await db.query(`update invoices set created_at = now() - interval '3 days' where clinic_id = $1`, [
    clinic.id,
  ]);
  const swept = (
    await db.query(
      `select i.id from invoices i
         join clinic_einvoice_settings s on s.clinic_id = i.clinic_id
        where s.enabled and i.clinic_id = $1
          and i.status not in ('draft','void')
          and i.einvoice_status = 'not_required'
          and i.file_einvoice
          and i.created_at < now() - interval '24 hours'`,
      [clinic.id]
    )
  ).rows.map((r) => r.id as string);
  check("the nightly sweep leaves the opted-out invoice alone", !swept.includes(optedOut));
  check("while still catching an unfiled one that was meant to go", swept.includes(untitled));

  /* Turning it back on is the only way in, and it must actually file. */
  await db.query(`update invoices set file_einvoice = true where id = $1`, [optedOut]);
  const reinstated = await enqueueEinvoiceSubmit(c, clinic.id, optedOut, "manual");
  check("turning filing back on files it", reinstated === true);
  check("and queues the job that was never queued before", (await queuedFor(optedOut)) === 1);

  /* A clinic-level default that new invoices inherit. */
  await db.query(`update clinic_einvoice_settings set file_by_default = false where clinic_id = $1`, [
    clinic.id,
  ]);
  const { loadEinvoiceSettings } = await import("../src/lib/einvoice/settings");
  const settings = await loadEinvoiceSettings(c, clinic.id);
  check("the clinic can say new invoices are not filed by default", settings.fileByDefault === false);
  await db.query(`update clinic_einvoice_settings set file_by_default = true where clinic_id = $1`, [
    clinic.id,
  ]);

  /* ================================================================== */
  console.log("\n[a patient who asked not to be messaged]");

  const automation = (
    await db.query(
      `insert into automations (clinic_id, name, trigger_type, trigger_config, active)
       values ($1,'QA Birthday','birthday','{}'::jsonb,true) returning id`,
      [clinic.id]
    )
  ).rows[0];

  const forListener = await startRun(c, clinic.id, automation.id, { patientId: listener });
  check("an automation runs for a patient who never opted out", Boolean(forListener));
  const forMuted = await startRun(c, clinic.id, automation.id, { patientId: muted });
  check("and refuses to start for one who did", forMuted === null);
  check(
    "so nothing is left half-run in the history either",
    Number(
      (
        await db.query(
          `select count(*)::int n from automation_runs where clinic_id = $1 and patient_id = $2`,
          [clinic.id, muted]
        )
      ).rows[0].n
    ) === 0
  );
  /*
    Blocked at startRun rather than at the send step, which is what makes it hold
    for the scheduler's three time-based triggers too — those call startRun
    directly and never go near a trigger job.
  */
  const anon = await startRun(c, clinic.id, automation.id, { patientId: null, conversationId: null });
  check("a run with no patient at all still starts", Boolean(anon));

  /* Staff are not the machine: a colleague can still message them. */
  const { queueWhatsAppMessage } = await import("../src/lib/outbound");
  const byHand = await queueWhatsAppMessage(c, {
    clinicId: clinic.id,
    phoneE164: (await db.query(`select phone_e164 from patients where id = $1`, [muted])).rows[0]
      .phone_e164,
    body: "Hello from the front desk",
    senderKind: "staff",
    patientId: muted,
  });
  check("but a person at the desk can still message them by hand", Boolean(byHand.messageId));

  /* ================================================================== */
  console.log("\n[campaigns]");

  const { where, values } = (await import("../src/lib/patients")).patientFilterSql(clinic.id, {});
  const audience = (
    await db.query(
      `select
         (select count(*)::int from patients p where ${where}) as total,
         (select count(distinct p.phone_e164)::int from patients p
           where ${where} and p.phone_e164 is not null and not p.automation_opt_out) as reachable,
         (select count(*)::int from patients p where ${where} and p.automation_opt_out) as muted`,
      values
    )
  ).rows[0];
  check("the audience counts both patients", audience.total === 2, `total=${audience.total}`);
  check("but only one is reachable", audience.reachable === 1, `reachable=${audience.reachable}`);
  check("and the muted one is reported as such, not as missing a number", audience.muted === 1);

  /*
    The frozen list. A campaign's recipients are a snapshot taken when it was
    built, so somebody who opts out afterwards is still sitting in it — this is
    the check that the drip notices on the way past.
  */
  const campaign = (
    await db.query(
      `insert into campaigns (clinic_id, name, body, filters, interval_seconds, status, next_send_at, total_count)
       values ($1,'QA Drip','مرحبا','{}'::jsonb,60,'running',now(),1) returning id`,
      [clinic.id]
    )
  ).rows[0];
  await db.query(
    `insert into campaign_recipients (clinic_id, campaign_id, patient_id, phone_e164, full_name, sort)
     select $1, $2, p.id, p.phone_e164, p.full_name, 1 from patients p where p.id = $3`,
    [clinic.id, campaign.id, muted]
  );
  const { pumpClinic } = await import("../worker/campaigns");
  await pumpClinic(clinic.id);
  const recipient = (
    await db.query(
      `select status, error from campaign_recipients where campaign_id = $1`,
      [campaign.id]
    )
  ).rows[0];
  check(
    "a muted patient already in a running campaign is cancelled, not sent",
    recipient.status === "cancelled",
    `${recipient.status} / ${recipient.error ?? ""}`
  );
  check(
    "and no message was queued for them",
    Number(
      (
        await db.query(
          `select count(*)::int n from messages m
             join conversations cv on cv.id = m.conversation_id
            where cv.patient_id = $1 and m.sender_kind = 'campaign'`,
          [muted]
        )
      ).rows[0].n
    ) === 0
  );

  /* ================================================================== */
  console.log("\n[in a browser]");

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  try {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120_000 });
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });

    // innerText, never textContent: the whole dictionary ships in every page.
    const visible = async () => (await page.locator("main").first().innerText()).replace(/\s+/g, " ");

    /* --- the patient file --- */
    await page.goto(`${BASE}/c/${slug}/patients/${listener}`);
    await page.waitForLoadState("networkidle");
    check("the patient file offers the automations switch", (await visible()).includes(ar.patients.automations.title));

    await page.getByRole("switch", { name: ar.patients.automations.title }).click();
    /*
      The file autosaves 1.5s after the last change and then has a round trip to
      make, so this waits for the write rather than for a guessed interval — a
      fixed sleep here is the difference between a suite that fails on a slow
      machine and one that means something.
    */
    let nowMuted = false;
    for (let i = 0; i < 20 && !nowMuted; i++) {
      await page.waitForTimeout(500);
      nowMuted = (
        await db.query(`select automation_opt_out from patients where id = $1`, [listener])
      ).rows[0].automation_opt_out;
    }
    check("flipping it writes to the file", nowMuted === true);

    await page.reload();
    await page.waitForLoadState("networkidle");
    check(
      "and the file then says so in its header, not only on the switch",
      (await visible()).includes(ar.patients.automations.muted)
    );
    await db.query(`update patients set automation_opt_out = false where id = $1`, [listener]);

    /* --- the automations page: the rule, said where the flows are --- */
    await page.goto(`${BASE}/c/${slug}/automations`);
    await page.waitForLoadState("networkidle");
    const autoText = await visible();
    check("the automations page names the opt-out", autoText.includes(ar.automations.optOut));
    check(
      "and counts the patients it applies to",
      autoText.includes(ar.automations.optOutCount.replace("{n}", "1")),
      autoText.slice(-160)
    );

    await page.goto(`${BASE}/c/${slug}/patients?optedOut=1`);
    await page.waitForLoadState("networkidle");
    const listText = await visible();
    check(
      "the list filters to exactly those patients",
      listText.includes("QA Muted") && !listText.includes("QA Listener"),
      listText.slice(0, 220)
    );

    /* --- the invoice --- */
    await page.goto(`${BASE}/c/${slug}/invoices/new`);
    await page.waitForLoadState("networkidle");
    const newText = await visible();
    check("a new invoice offers a title", newText.includes(ar.invoices.invoiceTitle));
    check("marked optional rather than required", newText.includes(ar.common.optional));
    check(
      "and, for a clinic that files, asks whether this one goes to JoFotara",
      newText.includes(ar.einvoicing.fileThisInvoice)
    );

    await page.goto(`${BASE}/c/${slug}/invoices/${titled}`);
    await page.waitForLoadState("networkidle");
    const titleInput = page.getByLabel(ar.invoices.invoiceTitle);
    check(
      "the invoice shows its title where it can be corrected",
      (await titleInput.inputValue()) === "علاج عصب — الضاحك العلوي"
    );

    await titleInput.fill("علاج عصب — جلسة ثانية");
    await titleInput.blur();
    await page.waitForTimeout(1500);
    check(
      "renaming it saves",
      (await stored(titled)) === "علاج عصب — جلسة ثانية",
      await stored(titled)
    );

    const token = (
      await db.query(`select public_token from invoices where id = $1`, [titled])
    ).rows[0].public_token;
    await page.goto(`${BASE}/inv/${token}`);
    await page.waitForLoadState("networkidle");
    const pub = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
    check("the patient's copy carries the title too", pub.includes("علاج عصب — جلسة ثانية"));

    /* An untitled invoice must not grow an empty labelled box. */
    const plainToken = (
      await db.query(`select public_token from invoices where id = $1`, [untitled])
    ).rows[0].public_token;
    await page.goto(`${BASE}/inv/${plainToken}`);
    await page.waitForLoadState("networkidle");
    const plainPub = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
    check("and an untitled one says nothing at all about a title", !plainPub.includes("الموضوع"));
  } finally {
    await browser.close();
  }

  /* ================================================================== */
  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = $1`, [user.id]);
  await db.end();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
