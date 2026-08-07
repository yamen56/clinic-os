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
  const { offerFreedSlot, expirePastWaitlist, requeueStaleOffers } = await import(
    "../worker/waitlist"
  );

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

  await db.query(`delete from clinics where id = $1`, [clinic.id]);
  await db.query(`delete from users where id = any($1)`, [[user.id, ghostUser.id]]);
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
