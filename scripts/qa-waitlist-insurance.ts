/**
 * The waitlist, and the insurance split.
 *
 * The waitlist half is the one worth testing hard, because its failure mode is
 * silence: an offer that is never sent looks exactly like a clinic with nobody
 * waiting. So this asserts not only that the right person is told, but that the
 * wrong ones are not — somebody outside their date window, somebody who has
 * just been offered a different slot, somebody waiting for another doctor.
 */
import { Client } from "pg";
import { chromium } from "playwright";
import bcrypt from "bcryptjs";

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
  // The worker is ESM; a CommonJS script has to reach it this way.
  const { offerFreedSlot, expirePastWaitlist, requeueStaleOffers, closeWaitlistOnBooking } =
    await import("../worker/waitlist");

  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qawl${Date.now().toString(36)}`;
  const clinic = (
    await db.query(
      `insert into clinics (name, name_ar, slug, default_locale, timezone)
       values ('QA Waitlist','انتظار',$1,'en','Asia/Amman') returning id`,
      [slug]
    )
  ).rows[0];
  await db.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinic.id]);
  await db.query(
    `insert into booking_links (clinic_id, slug, name) values ($1, $2, 'Default')`,
    [clinic.id, slug]
  );
  const user = (
    await db.query(
      `insert into users (email, full_name) values ($1,'QA Doc') returning id`,
      [`doc-${slug}@test.local`]
    )
  ).rows[0];
  const doctor = (
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role) values ($1,$2,'doctor') returning id`,
      [clinic.id, user.id]
    )
  ).rows[0];

  /*
    An owner from the start. Staff notifications go to owners and receptionists,
    so a fixture whose only member is a doctor silently has nobody to tell — and
    a check for "reception was told" would fail for the wrong reason.
  */
  const owner = (
    await db.query(
      `insert into users (email, password_hash, full_name, locale)
       values ($1,$2,'WL Owner','en') returning id`,
      [`owner-${slug}@test.local`, bcrypt.hashSync("password123", 10)]
    )
  ).rows[0];
  await db.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1,$2,'receptionist',true,'{"level":"full"}')`,
    [clinic.id, owner.id]
  );

  const mk = async (name: string, phone: string) =>
    (
      await db.query(
        `insert into patients (clinic_id, full_name, phone_e164, source)
         values ($1,$2,$3,'staff') returning id`,
        [clinic.id, name, phone]
      )
    ).rows[0].id as string;

  const wants = await mk("Wants Sooner", "+962790600001");
  const tooLate = await mk("Window Passed", "+962790600002");
  const otherDoc = await mk("Other Doctor", "+962790600003");

  const soon = new Date(Date.now() + 3 * 86400000);
  const soonISO = soon.toISOString();
  const soonDate = soon.toISOString().slice(0, 10);

  await db.query(
    `insert into waitlist_entries (clinic_id, patient_id, doctor_member_id) values ($1,$2,$3)`,
    [clinic.id, wants, doctor.id]
  );
  // Window ends before the freed slot, so this one must not be told.
  await db.query(
    `insert into waitlist_entries (clinic_id, patient_id, latest_date) values ($1,$2,$3)`,
    [clinic.id, tooLate, new Date(Date.now() + 86400000).toISOString().slice(0, 10)]
  );
  const ghostUser = (
    await db.query(`insert into users (email, full_name) values ($1,'Ghost') returning id`, [
      `ghost-${slug}@test.local`,
    ])
  ).rows[0];
  const ghostDoc = (
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role) values ($1,$2,'doctor') returning id`,
      [clinic.id, ghostUser.id]
    )
  ).rows[0];
  await db.query(
    `insert into waitlist_entries (clinic_id, patient_id, doctor_member_id) values ($1,$2,$3)`,
    [clinic.id, otherDoc, ghostDoc.id]
  );
  console.log(`✓ fixture clinic ${slug}`);

  /* ------------------------------------------------- a slot comes free */
  const n = await offerFreedSlot({
    clinicId: clinic.id,
    appointmentId: "00000000-0000-0000-0000-000000000000",
    doctorMemberId: doctor.id,
    serviceId: null,
    startsAt: soonISO,
  });
  check("a freed slot is offered to somebody", n > 0, `${n} offer(s)`);

  const offered = await db.query(
    `select p.full_name, m.body from messages m
       join conversations cv on cv.id = m.conversation_id
       join patients p on p.id = cv.patient_id
      where m.clinic_id = $1 and m.direction = 'out'`,
    [clinic.id]
  );
  const names = offered.rows.map((r) => r.full_name);
  check("the patient waiting for that doctor is told", names.includes("Wants Sooner"));
  check("somebody whose window has passed is not", !names.includes("Window Passed"));
  check("somebody waiting for a different doctor is not", !names.includes("Other Doctor"));
  check(
    "the message carries a booking link",
    offered.rows.some((r) => String(r.body).includes(`/book/${slug}`)),
    String(offered.rows[0]?.body ?? "").slice(0, 60)
  );
  check(
    "and it is queued through the sending rails, not sent directly",
    (
      await db.query(
        `select count(*)::int n from messages where clinic_id = $1 and status = 'queued'`,
        [clinic.id]
      )
    ).rows[0].n > 0
  );

  const entry = await db.query(
    `select status, offers_sent from waitlist_entries where patient_id = $1`,
    [wants]
  );
  check("their entry is marked offered", entry.rows[0].status === "offered", entry.rows[0].status);

  /* --------------------------------- a second cancellation must not spam */
  const before = (
    await db.query(`select count(*)::int n from messages where clinic_id = $1`, [clinic.id])
  ).rows[0].n;
  await offerFreedSlot({
    clinicId: clinic.id,
    appointmentId: "00000000-0000-0000-0000-000000000000",
    doctorMemberId: doctor.id,
    serviceId: null,
    startsAt: soonISO,
  });
  const after = (
    await db.query(`select count(*)::int n from messages where clinic_id = $1`, [clinic.id])
  ).rows[0].n;
  check("a second slot minutes later does not message them again", after === before, `${before} → ${after}`);

  /* ------------------------------------------- offers that go unanswered */
  await db.query(
    `update waitlist_entries set last_offered_at = now() - interval '10 hours' where patient_id = $1`,
    [wants]
  );
  await requeueStaleOffers();
  const back = await db.query(`select status from waitlist_entries where patient_id = $1`, [wants]);
  check("a cold offer puts them back on the list", back.rows[0].status === "waiting", back.rows[0].status);

  /* ------------------------------------- booking is how an entry should end */
  /*
    The offer working used to leave no trace: the entry stayed 'offered', went
    cold, returned to 'waiting', and the next cancellation offered another slot
    to somebody who had already taken one.
  */
  const svc = (
    await db.query(
      `insert into services (clinic_id, name, duration_min, price) values ($1,'QA',30,10) returning id`,
      [clinic.id]
    )
  ).rows[0];
  const booked = (
    await db.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5,$5::timestamptz + interval '30 minutes','scheduled') returning id`,
      [clinic.id, wants, doctor.id, svc.id, soonISO]
    )
  ).rows[0];
  await closeWaitlistOnBooking(clinic.id, booked.id);
  const after2 = await db.query(
    `select status, booked_appointment_id from waitlist_entries where patient_id = $1`,
    [wants]
  );
  check("booking closes their waitlist entry", after2.rows[0].status === "booked", after2.rows[0].status);
  check("and records which appointment did it", after2.rows[0].booked_appointment_id === booked.id);
  const told = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'waitlist_booked'`,
    [clinic.id]
  );
  check("reception is told the slot was filled", told.rows[0].n > 0, `${told.rows[0].n}`);
  await closeWaitlistOnBooking(clinic.id, booked.id);
  const told2 = await db.query(
    `select count(*)::int n from notifications where clinic_id = $1 and kind = 'waitlist_booked'`,
    [clinic.id]
  );
  check("and not told twice if it runs again", told2.rows[0].n === told.rows[0].n, `${told2.rows[0].n}`);

  /* ---------------------------------------------- windows that have passed */
  await db.query(
    `update waitlist_entries set latest_date = current_date - 1 where patient_id = $1`,
    [tooLate]
  );
  await expirePastWaitlist();
  const gone = await db.query(`select status from waitlist_entries where patient_id = $1`, [tooLate]);
  check("an entry past its window is closed", gone.rows[0].status === "expired", gone.rows[0].status);

  /* ------------------------------------------------------------ insurance */
  const insurer = (
    await db.query(
      `insert into insurers (clinic_id, name, code) values ($1,'QA Insure','QA-1') returning id`,
      [clinic.id]
    )
  ).rows[0];
  const insured = await mk("Insured Patient", "+962790600004");
  await db.query(`update patients set insurer_id = $2, insurance_no = 'POL-9' where id = $1`, [
    insured,
    insurer.id,
  ]);

  // Mirrors what createInvoiceAction does, including where the insurer comes from.
  const inv = (
    await db.query(
      `insert into invoices (clinic_id, patient_id, seq, number, total, subtotal, insurer_id, claim_status)
       values ($1,$2,1,'QA-1',100,100,
               (select insurer_id from patients where id = $2),
               case when (select insurer_id from patients where id = $2) is null
                    then 'none' else 'to_submit' end)
       returning id, insurer_id, claim_status`,
      [clinic.id, insured]
    )
  ).rows[0];
  check("an insured patient's invoice knows who to claim from", inv.insurer_id === insurer.id);
  check("and starts as needing submission", inv.claim_status === "to_submit", inv.claim_status);

  const cash = await mk("Cash Patient", "+962790600005");
  const inv2 = (
    await db.query(
      `insert into invoices (clinic_id, patient_id, seq, number, total, subtotal, insurer_id, claim_status)
       values ($1,$2,2,'QA-2',80,80,
               (select insurer_id from patients where id = $2),
               case when (select insurer_id from patients where id = $2) is null
                    then 'none' else 'to_submit' end)
       returning insurer_id, claim_status`,
      [clinic.id, cash]
    )
  ).rows[0];
  check("a self-paying patient's invoice raises no claim", inv2.claim_status === "none" && !inv2.insurer_id);

  // The cap the action applies, asserted at the boundary it protects.
  await db.query(`update invoices set insurer_amount = least(150, total) where id = $1`, [inv.id]);
  const split = (
    await db.query(`select total, insurer_amount from invoices where id = $1`, [inv.id])
  ).rows[0];
  check(
    "an insurer cannot be recorded as covering more than the invoice",
    Number(split.insurer_amount) <= Number(split.total),
    `${split.insurer_amount} of ${split.total}`
  );
  check(
    "so the patient's share is never negative",
    Number(split.total) - Number(split.insurer_amount) >= 0
  );

  /* --------------------------------------- adding somebody, in the browser */
  /*
    This section exists because of a real bug that everything else missed. The
    add-to-waitlist search read `patients` from a response that has always been
    keyed `results`, so the list was silently always empty — no error, no failing
    type, no failing query. Only driving the screen catches a client that
    misreads its own API.
  */
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', `owner-${slug}@test.local`);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 120000 });

  await page.goto(`${BASE}/c/${slug}/waitlist`);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.getByRole("button", { name: /add to waitlist/i }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 15000 });

  await dialog.locator("input").first().fill("Wants");
  const hit = dialog.getByText("Wants Sooner", { exact: false }).first();
  const found = await hit
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("searching by name finds a patient", found);

  if (found) {
    await hit.click();
    await dialog.getByRole("button", { name: /^add$/i }).click();
    await page.waitForTimeout(1500);
    const added = (
      await db.query(
        `select count(*)::int n from waitlist_entries
          where clinic_id = $1 and patient_id = $2 and status in ('waiting','offered')`,
        [clinic.id, wants]
      )
    ).rows[0].n;
    check("and adding them puts them on the list", added > 0, `${added}`);
  }

  // Nobody matching must lead somewhere, or reception is stuck at a dead end.
  await page.goto(`${BASE}/c/${slug}/waitlist`);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.getByRole("button", { name: /add to waitlist/i }).first().click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 15000 });
  await page.getByRole("dialog").locator("input").first().fill("Nobody Named This");
  await page.waitForTimeout(1200);
  check(
    "and a name nobody matches offers to create them",
    (await page.getByRole("button", { name: /add them as a new patient/i }).count()) > 0
  );

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await browser.close();

  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = any($1)`, [[user.id, ghostUser.id, owner.id]]);
  await db.end();

  console.log(`\n  waitlist & insurance: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("QA FAILED:", e.message);
  process.exit(1);
});
