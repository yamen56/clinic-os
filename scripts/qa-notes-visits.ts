/**
 * QA: a note that belongs to a visit.
 *
 * `patient_notes.appointment_id` existed since the first migration and nothing
 * ever wrote to it. Now both ends do — the patient file files a note against a
 * visit, and the appointment panel writes one from the other direction — so the
 * checks that matter are that the two agree, and that a note can never be filed
 * against a visit belonging to somebody else.
 */
import { Client } from "pg";

const BASE = process.env.APP_URL || "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const ok = (m: string) => {
  passed++;
  console.log(`✓ ${m}`);
};
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const stamp = Date.now().toString(36);
  const clinic = (
    await db.query(
      `insert into clinics (name, slug, timezone) values ('QA Visit Notes', $1, 'Asia/Amman') returning id`,
      [`qavn${stamp}`]
    )
  ).rows[0];
  await db.query(`select seed_note_categories($1)`, [clinic.id]);
  const user = (
    await db.query(
      `insert into users (email, password_hash, full_name) values ($1, 'x', 'Dr Visit') returning id`,
      [`vn-${stamp}@test.local`]
    )
  ).rows[0];

  const mk = async (name: string, phone: string) =>
    (
      await db.query(
        `insert into patients (clinic_id, full_name, phone_e164) values ($1, $2, $3) returning id`,
        [clinic.id, name, phone]
      )
    ).rows[0].id as string;
  const alice = await mk("Alice Visit", `+9627${String(98000000 + (Date.now() % 800000))}`);
  const bob = await mk("Bob Other", `+9627${String(98800000 + (Date.now() % 100000))}`);

  const appt = async (patientId: string, hourOffset: number) =>
    (
      await db.query(
        `insert into appointments (clinic_id, patient_id, starts_at, ends_at)
         values ($1, $2, now() + ($3 || ' hours')::interval, now() + (($3::int + 1) || ' hours')::interval)
         returning id`,
        [clinic.id, patientId, String(hourOffset)]
      )
    ).rows[0].id as string;
  const aliceVisit = await appt(alice, 24);
  const aliceVisit2 = await appt(alice, 48);
  const bobVisit = await appt(bob, 24);

  const cats = (
    await db.query(`select id, key from note_categories where clinic_id = $1`, [clinic.id])
  ).rows;
  const clinical = cats.find((c) => c.key === "clinical")!;

  const cleanup = async () => {
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = $1`, [user.id]);
  };

  try {
    const notes = await import("../src/lib/notes");

    /* ------------------------------------- a note filed against a visit */
    const filed = await notes.createNote(db as never, clinic.id, {
      patientId: alice,
      authorId: user.id,
      body: "Filling on the upper left.",
      categoryId: clinical.id,
      appointmentId: aliceVisit,
    });
    const unfiled = await notes.createNote(db as never, clinic.id, {
      patientId: alice,
      authorId: user.id,
      body: "Generally anxious about the drill.",
      categoryId: clinical.id,
    });

    const onVisit = await notes.loadAppointmentNotes(db as never, clinic.id, aliceVisit);
    assert(onVisit.length === 1, `expected 1 note on the visit, got ${onVisit.length}`);
    assert(onVisit[0].id === filed, "the wrong note came back for the visit");
    ok("a note filed against a visit is readable from that visit");

    const other = await notes.loadAppointmentNotes(db as never, clinic.id, aliceVisit2);
    assert(other.length === 0, "a note leaked onto a different visit of the same patient");
    ok("it does not appear on the patient's other visits");

    /* -------------------------- and both notes still sit on the patient */
    const all = await notes.loadPatientNotes(db as never, clinic.id, alice);
    assert(all.length === 2, `expected 2 notes on the file, got ${all.length}`);
    const byId = Object.fromEntries(all.map((n) => [n.id, n]));
    assert(byId[filed].appointment_id === aliceVisit, "the file does not show which visit");
    assert(byId[filed].appointment_starts_at, "the visit's date did not come back with the note");
    assert(byId[unfiled].appointment_id === null, "a note with no visit claims one");
    ok("the patient file shows every note, and which visit each one belongs to");

    /* ---------------------------------------- filing an existing note */
    assert(
      await notes.setNoteAppointment(db as never, clinic.id, unfiled, aliceVisit2),
      "filing an existing note failed"
    );
    assert(
      (await notes.loadAppointmentNotes(db as never, clinic.id, aliceVisit2)).length === 1,
      "the re-filed note is not on its new visit"
    );
    ok("an existing note can be filed against a visit afterwards");

    /* -------------------------------------------------- and unfiled again */
    assert(
      await notes.setNoteAppointment(db as never, clinic.id, unfiled, null),
      "unfiling failed"
    );
    assert(
      (await notes.loadAppointmentNotes(db as never, clinic.id, aliceVisit2)).length === 0,
      "the note stayed on the visit after being unfiled"
    );
    ok("and taken off one again");

    /* ------------------------ never onto somebody else's visit */
    const wrong = await notes.setNoteAppointment(db as never, clinic.id, filed, bobVisit);
    assert(wrong === false, "a note was filed against another patient's visit");
    const stillMine = (
      await db.query(`select appointment_id from patient_notes where id = $1`, [filed])
    ).rows[0].appointment_id;
    assert(stillMine === aliceVisit, "the rejected move changed the note anyway");
    assert(
      (await notes.loadAppointmentNotes(db as never, clinic.id, bobVisit)).length === 0,
      "another patient's visit is showing a note that is not theirs"
    );
    ok("a note cannot be filed against another patient's visit");

    /* ----------------------------------- the visit list offered to staff */
    const visits = await notes.loadNoteAppointments(db as never, clinic.id, alice);
    assert(visits.length === 2, `expected 2 visits for Alice, got ${visits.length}`);
    assert(
      !visits.some((v) => v.id === bobVisit),
      "another patient's visit is offered when filing Alice's note"
    );
    ok("only this patient's visits are offered when filing a note");

    /* ------------------------------------ deleting the visit keeps the note */
    await db.query(`delete from appointments where id = $1`, [aliceVisit]);
    const survived = (
      await db.query(`select id, appointment_id from patient_notes where id = $1`, [filed])
    ).rows[0];
    assert(survived, "deleting an appointment destroyed the clinical note written at it");
    assert(survived.appointment_id === null, "the note still points at a deleted visit");
    ok("removing a visit unfiles its notes rather than destroying them");

    /* ------------------------------------------- the endpoint is guarded */
    const res = await fetch(`${BASE}/api/c/qavn${stamp}/appointments/${aliceVisit2}/notes`);
    assert(res.status !== 200, `a signed-out caller read visit notes (${res.status})`);
    const post = await fetch(`${BASE}/api/c/qavn${stamp}/appointments/${aliceVisit2}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "should not land" }),
    });
    assert(post.status !== 200, `a signed-out caller wrote a visit note (${post.status})`);
    ok(`the visit-notes endpoint refuses a signed-out caller (${res.status}/${post.status})`);

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
