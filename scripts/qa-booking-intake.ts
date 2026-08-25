/**
 * QA: the questions a clinic adds to its booking page.
 *
 * Everything here drives the public endpoints, because that is the surface an
 * attacker gets. The form is served to the browser, so the checks that matter
 * are the ones the browser cannot be trusted to have made: a required question
 * skipped, a choice that is not on the list, a mapping that would overwrite a
 * patient record staff already curated.
 */
import { Client } from "pg";
import { DateTime } from "luxon";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const ok = (m: string) => {
  passed++;
  console.log(`✓ ${m}`);
};
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const post = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }));

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qaintake${Date.now().toString(36)}`;
  const hours = JSON.stringify(
    Object.fromEntries(
      ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["00:00", "23:59"]]])
    )
  );
  const clinic = (
    await db.query(
      `insert into clinics (name, slug, timezone, working_hours) values ('QA Intake', $1, 'Asia/Amman', $2)
       returning id, timezone`,
      [slug, hours]
    )
  ).rows[0];
  // No whatsapp_sessions row -> the clinic reads as offline, so `start`
  // finalises inline and we can assert on the appointment in one round trip.
  const link = (
    await db.query(
      `insert into booking_links (clinic_id, slug, min_notice_min) values ($1, $2, 0) returning id`,
      [clinic.id, slug]
    )
  ).rows[0];
  const docUser = (
    await db.query(
      `insert into users (email, password_hash, full_name) values ($1, 'x', 'Dr Intake') returning id`,
      [`intake-doc-${slug}@test.local`]
    )
  ).rows[0];
  const member = (
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'doctor') returning id`,
      [clinic.id, docUser.id]
    )
  ).rows[0];
  const [checkup, whitening] = (
    await db.query(
      `insert into services (clinic_id, name, duration_min, price)
       values ($1, 'Checkup', 30, 10), ($1, 'Whitening', 30, 90) returning id, name`,
      [clinic.id]
    )
  ).rows;
  await db.query(
    `insert into service_doctors (service_id, member_id, clinic_id) values ($1, $3, $4), ($2, $3, $4)`,
    [checkup.id, whitening.id, member.id, clinic.id]
  );

  // The patient fields a mapped question writes to. Real clinics get the system
  // ones from `seed_esign_defaults` when the agency creates them; a fixture
  // inserted straight into the table has to ask for them.
  await db.query(`select seed_esign_defaults($1)`, [clinic.id]);
  await db.query(
    `insert into patient_field_definitions (clinic_id, scope, key, label, field_type, storage_key)
     values ($1, 'patient', 'patient.allergies', 'Allergies', 'text', 'allergies')
     on conflict (clinic_id, key) do nothing`,
    [clinic.id]
  );

  const q = async (
    label: string,
    type: string,
    extra: Record<string, unknown> = {}
  ): Promise<string> =>
    (
      await db.query(
        `insert into booking_questions
           (clinic_id, booking_link_id, label, field_type, options, required, service_ids,
            patient_field_key, display_order)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) returning id`,
        [
          clinic.id,
          (extra.linkId as string) ?? null,
          label,
          type,
          JSON.stringify(extra.options ?? []),
          extra.required ?? false,
          (extra.serviceIds as string[]) ?? [],
          (extra.patientFieldKey as string) ?? null,
          (extra.order as number) ?? 10,
        ]
      )
    ).rows[0].id;

  const qReason = await q("Reason for visit", "longtext", { required: true, order: 10 });
  const qHow = await q("How did you hear about us?", "select", {
    options: ["Instagram", "A friend", "Google"],
    order: 20,
  });
  const qShade = await q("Which shade?", "select", {
    options: ["Natural", "Bright"],
    serviceIds: [whitening.id],
    order: 30,
  });
  const qAllergy = await q("Any allergies?", "text", {
    patientFieldKey: "patient.allergies",
    order: 40,
  });
  const qDob = await q("Date of birth", "date", {
    patientFieldKey: "patient.birth_date",
    order: 50,
  });
  const qOff = await q("Retired question", "text", { order: 60 });
  await db.query(`update booking_questions set active = false where id = $1`, [qOff]);

  const cleanup = async () => {
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = $1`, [docUser.id]);
  };

  const at = (hour: number) =>
    DateTime.now()
      .setZone(clinic.timezone)
      .plus({ days: 1 })
      .set({ hour, minute: 0, second: 0, millisecond: 0 })
      .toUTC()
      .toISO()!;

  let phoneSeq = 0;
  const nextPhone = () => `+9627${String(96000000 + phoneSeq++)}`;

  try {
    /* ------------------------------------------------ the page serves them */
    const page = await fetch(`${BASE}/book/${slug}`).then((r) => r.text());
    assert(page.includes("Reason for visit"), "the public page does not carry the question");
    assert(
      !page.includes("Retired question"),
      "a switched-off question is still being served to patients"
    );
    assert(
      !page.includes("patient.allergies"),
      "the patient-field mapping leaked to the public page"
    );
    ok("active questions reach the page; inactive ones and the mapping do not");

    /* ------------------------------------------ a required answer is required */
    const missing = await post(`/api/public/book/${slug}/start`, {
      serviceId: checkup.id,
      doctorId: member.id,
      startISO: at(9),
      fullName: "Skips Questions",
      phone: nextPhone(),
      locale: "en",
      answers: {},
    });
    assert(missing.status === 422, `expected 422 for a missing answer, got ${missing.status} ${JSON.stringify(missing.body)}`);
    assert(missing.body.error === "answer_required", `wrong error: ${missing.body.error}`);
    assert(missing.body.questionId === qReason, "the response does not name the failing question");
    ok("a required question cannot be skipped, even with the field never rendered");

    /* --------------------------------------- a choice must be one of the list */
    const bogus = await post(`/api/public/book/${slug}/start`, {
      serviceId: checkup.id,
      doctorId: member.id,
      startISO: at(9),
      fullName: "Invents Options",
      phone: nextPhone(),
      locale: "en",
      answers: { [qReason]: "Toothache", [qHow]: "<script>alert(1)</script>" },
    });
    assert(bogus.status === 422 && bogus.body.error === "answer_invalid", "an off-list choice was accepted");
    ok("a choice question only accepts the clinic's own options");

    /* -------------------------------------------- the happy path, end to end */
    const bookedPhone = nextPhone();
    const good = await post(`/api/public/book/${slug}/start`, {
      serviceId: checkup.id,
      doctorId: member.id,
      startISO: at(10),
      fullName: "Answers Everything",
      phone: bookedPhone,
      locale: "en",
      answers: {
        [qReason]: "  Pain in the lower left molar  ",
        [qHow]: "Instagram",
        [qShade]: "Bright",
        [qAllergy]: "Penicillin",
        [qDob]: "1990-05-14",
      },
    });
    assert(good.status === 200, `booking failed: ${JSON.stringify(good.body)}`);
    const appt = (
      await db.query(
        `select a.intake_answers, a.patient_id from appointments a where a.id = $1`,
        [good.body.appointmentId]
      )
    ).rows[0];
    const answers = appt.intake_answers as { id: string; label: string; value: string }[];
    assert(Array.isArray(answers), "intake_answers is not an array — jsonb was not re-stringified");
    const byId = Object.fromEntries(answers.map((a) => [a.id, a]));
    assert(byId[qReason]?.value === "Pain in the lower left molar", "the answer was not trimmed/stored");
    assert(byId[qReason]?.label === "Reason for visit", "the label was not frozen onto the appointment");
    assert(
      byId[qShade] === undefined,
      "a question scoped to another service was stored anyway"
    );
    ok("answers land on the appointment, trimmed, labelled, and scoped to the service");

    /* -------------------------------------- mapped answers reach the patient */
    const patient = (
      await db.query(`select birth_date, custom_fields from patients where id = $1`, [appt.patient_id])
    ).rows[0];
    assert(
      DateTime.fromJSDate(patient.birth_date).toISODate() === "1990-05-14",
      `birth date not written: ${patient.birth_date}`
    );
    assert(
      patient.custom_fields?.allergies === "Penicillin",
      `custom field not written: ${JSON.stringify(patient.custom_fields)}`
    );
    ok("a mapped answer fills the patient file through its field definition");

    /* ----------------------------- and never overwrites what staff had entered */
    await db.query(
      `update patients set birth_date = '1985-01-01',
              custom_fields = custom_fields || '{"allergies":"Checked in person: none"}'::jsonb
       where id = $1`,
      [appt.patient_id]
    );
    const again = await post(`/api/public/book/${slug}/start`, {
      serviceId: checkup.id,
      doctorId: member.id,
      startISO: at(12),
      // Same number → the identity rule finds the same patient.
      phone: bookedPhone,
      fullName: "Answers Everything",
      locale: "en",
      answers: { [qReason]: "Follow up", [qAllergy]: "Nothing", [qDob]: "1990-05-14" },
    });
    assert(again.status === 200, `second booking failed: ${JSON.stringify(again.body)}`);
    const after = (
      await db.query(`select birth_date, custom_fields from patients where id = $1`, [appt.patient_id])
    ).rows[0];
    assert(
      DateTime.fromJSDate(after.birth_date).toISODate() === "1985-01-01",
      "a booking form overwrote a birth date staff had already corrected"
    );
    assert(
      after.custom_fields.allergies === "Checked in person: none",
      "a booking form overwrote a custom field staff had already filled"
    );
    ok("a second booking never overwrites what the clinic already knows");

    /* ---------------------------------- the service-scoped question does apply */
    const wh = await post(`/api/public/book/${slug}/start`, {
      serviceId: whitening.id,
      doctorId: member.id,
      startISO: at(14),
      fullName: "Wants Whitening",
      phone: nextPhone(),
      locale: "en",
      answers: { [qReason]: "Whiter teeth", [qShade]: "Natural" },
    });
    assert(wh.status === 200, `whitening booking failed: ${JSON.stringify(wh.body)}`);
    const whAnswers = (
      await db.query(`select intake_answers from appointments where id = $1`, [wh.body.appointmentId])
    ).rows[0].intake_answers as { id: string; value: string }[];
    assert(
      whAnswers.some((a) => a.id === qShade && a.value === "Natural"),
      "the service-scoped question was not asked on its own service"
    );
    ok("a question scoped to one service is asked on that service");

    /* ------------------------------------------------- one clinic, one set */
    /*
      `booking_questions` is a new tenant-scoped table, so the isolation is
      asserted rather than assumed: another clinic's question must not appear on
      this page, and posting its id here must not smuggle an answer onto this
      clinic's appointment.
    */
    const other = (
      await db.query(
        `insert into clinics (name, slug, timezone, working_hours) values ('QA Other', $1, 'Asia/Amman', $2)
         returning id`,
        [`${slug}other`, hours]
      )
    ).rows[0];
    const foreignQ = (
      await db.query(
        `insert into booking_questions (clinic_id, label, field_type, required, display_order)
         values ($1, 'Neighbouring clinic question', 'text', true, 10) returning id`,
        [other.id]
      )
    ).rows[0].id;
    try {
      const page2 = await fetch(`${BASE}/book/${slug}`).then((r) => r.text());
      assert(
        !page2.includes("Neighbouring clinic question"),
        "another clinic's question is being served on this clinic's booking page"
      );

      const smuggle = await post(`/api/public/book/${slug}/start`, {
        serviceId: checkup.id,
        doctorId: member.id,
        startISO: at(15),
        fullName: "Smuggler",
        phone: nextPhone(),
        locale: "en",
        answers: { [qReason]: "Cleaning", [foreignQ]: "should not be stored" },
      });
      assert(smuggle.status === 200, `booking failed: ${JSON.stringify(smuggle.body)}`);
      const smuggled = (
        await db.query(`select intake_answers from appointments where id = $1`, [
          smuggle.body.appointmentId,
        ])
      ).rows[0].intake_answers as { id: string }[];
      assert(
        !smuggled.some((a) => a.id === foreignQ),
        "an answer keyed to another clinic's question was stored on this appointment"
      );
      ok("another clinic's questions are neither served here nor accepted here");
    } finally {
      await db.query(`delete from clinics where id = $1`, [other.id]);
    }

    /* ------------------------------------------------------ required consent */
    await db.query(
      `update booking_links set require_consent = true, consent_text = 'I agree.' where id = $1`,
      [link.id]
    );
    const noConsent = await post(`/api/public/book/${slug}/start`, {
      serviceId: checkup.id,
      doctorId: member.id,
      startISO: at(16),
      fullName: "Did Not Agree",
      phone: nextPhone(),
      locale: "en",
      answers: { [qReason]: "Cleaning" },
    });
    assert(
      noConsent.status === 422 && noConsent.body.error === "consent_required",
      `consent was not enforced: ${noConsent.status} ${JSON.stringify(noConsent.body)}`
    );
    ok("a link that requires agreement refuses a booking without it");
    await db.query(`update booking_links set require_consent = false where id = $1`, [link.id]);

    /* -------------------------------------------------- the day availability */
    const days = await fetch(
      `${BASE}/api/public/book/${slug}/days?serviceId=${checkup.id}&doctorId=${member.id}`
    ).then((r) => r.json());
    const counts = days.counts as Record<string, number>;
    assert(counts && Object.keys(counts).length > 1, "the day endpoint returned nothing");
    const tomorrow = DateTime.now().setZone(clinic.timezone).plus({ days: 1 }).toISODate()!;
    assert(counts[tomorrow] > 0, "tomorrow reads as closed on a clinic open every day");
    ok(`the strip knows availability for ${Object.keys(counts).length} days in one request`);

    // Close the clinic entirely and the same window must read as shut.
    await db.query(`update clinics set working_hours = '{}'::jsonb where id = $1`, [clinic.id]);
    const shut = await fetch(
      `${BASE}/api/public/book/${slug}/days?serviceId=${checkup.id}&doctorId=${member.id}`
    ).then((r) => r.json());
    assert(
      Object.values(shut.counts as Record<string, number>).every((n) => n === 0),
      "a clinic with no working hours still reports open days"
    );
    ok("closed days come back as zero, so the strip can grey them out");

    console.log(`\n  ${passed} checks passed\n`);
  } finally {
    await cleanup();
    await db.end();
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
