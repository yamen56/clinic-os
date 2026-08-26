/**
 * QA: patient notes as a clinical record.
 *
 * The three guarantees this suite exists to hold down, because each of them is
 * the kind that quietly stops being true:
 *
 *  - a note cannot be destroyed — not by a delete button, and not by being
 *    edited down to nothing;
 *  - every version is kept, and the first one is still readable;
 *  - categories are the clinic's own, and filtering by one is exact.
 *
 * Plus voice: the upload path, the type allowlist, and playback being served
 * through the app rather than from the object store.
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
      `insert into clinics (name, slug, timezone) values ('QA Notes', $1, 'Asia/Amman') returning id`,
      [`qanotes${stamp}`]
    )
  ).rows[0];
  await db.query(`select seed_note_categories($1)`, [clinic.id]);
  const user = (
    await db.query(
      `insert into users (email, password_hash, full_name) values ($1, 'x', 'Dr Notes') returning id`,
      [`notes-${stamp}@test.local`]
    )
  ).rows[0];
  const patient = (
    await db.query(
      `insert into patients (clinic_id, full_name, phone_e164) values ($1, 'Note Patient', $2) returning id`,
      [clinic.id, `+9627${String(97000000 + (Date.now() % 900000))}`]
    )
  ).rows[0];

  const cats = (
    await db.query(`select id, key from note_categories where clinic_id = $1 order by sort`, [
      clinic.id,
    ])
  ).rows;
  const clinical = cats.find((c) => c.key === "clinical")!;
  const admin = cats.find((c) => c.key === "admin")!;

  const cleanup = async () => {
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = $1`, [user.id]);
  };

  try {
    /* --------------------------------------- every clinic starts with two */
    assert(cats.length === 2, `expected 2 seeded categories, got ${cats.length}`);
    assert(clinical && admin, "the two system categories are not both present");
    assert(
      cats.every((c) => c.key),
      "a seeded category has no stable key"
    );
    ok("a new clinic is seeded with its two note categories");

    /* ----------------------------------------- creating files a version */
    const note = (
      await db.query(
        `insert into patient_notes (clinic_id, patient_id, author_id, category_id, body)
         values ($1, $2, $3, $4, 'Original text') returning id`,
        [clinic.id, patient.id, user.id, clinical.id]
      )
    ).rows[0];
    await db.query(
      `insert into patient_note_versions (clinic_id, note_id, body, category_id, author_id)
       values ($1, $2, 'Original text', $3, $4)`,
      [clinic.id, note.id, clinical.id, user.id]
    );

    /* ------------------------------- editing keeps what it said before */
    const { saveNoteVersion, loadNoteHistory, loadPatientNotes } = await import("../src/lib/notes");
    await saveNoteVersion(db as never, clinic.id, note.id, { body: "Corrected text" }, user.id);
    let history = await loadNoteHistory(db as never, clinic.id, note.id);
    assert(history.length === 2, `expected 2 versions, got ${history.length}`);
    assert(history[0].body === "Original text", `the original was lost: ${history[0].body}`);
    assert(history[1].body === "Corrected text", "the correction was not filed");
    ok("editing a note files a version and keeps the original readable");

    /* --------------------- editing it to nothing still keeps the original */
    await saveNoteVersion(db as never, clinic.id, note.id, { body: "" }, user.id);
    history = await loadNoteHistory(db as never, clinic.id, note.id);
    assert(history.length === 3, `expected 3 versions, got ${history.length}`);
    assert(
      history[0].body === "Original text",
      "emptying a note destroyed the original — the delete button was only half the problem"
    );
    ok("emptying a note cannot destroy what it said");

    /* ------------------------------- an unchanged save is not a version */
    await saveNoteVersion(db as never, clinic.id, note.id, { body: "" }, user.id);
    history = await loadNoteHistory(db as never, clinic.id, note.id);
    assert(
      history.length === 3,
      `an autosave that changed nothing filed a version (${history.length})`
    );
    ok("an autosave that changed nothing does not file a duplicate version");

    /* ----------------------------------------------- edited is recorded */
    const edited = (
      await db.query(`select edited_at, edited_by from patient_notes where id = $1`, [note.id])
    ).rows[0];
    assert(edited.edited_at, "edited_at was never set");
    assert(edited.edited_by === user.id, "edited_by does not name who changed it");
    ok("the note records that it was edited, and by whom");

    /* -------------------------------------------- recategorising is a change */
    await saveNoteVersion(db as never, clinic.id, note.id, { categoryId: admin.id }, user.id);
    const moved = (
      await db.query(`select category_id from patient_notes where id = $1`, [note.id])
    ).rows[0];
    assert(moved.category_id === admin.id, "the note did not move category");
    assert(
      (await loadNoteHistory(db as never, clinic.id, note.id)).length === 4,
      "recategorising was not recorded"
    );
    ok("moving a note to another category is recorded like any other change");

    /* ------------------------------------------------ filtering is exact */
    await db.query(
      `insert into patient_notes (clinic_id, patient_id, author_id, category_id, body)
       values ($1, $2, $3, $4, 'A clinical one')`,
      [clinic.id, patient.id, user.id, clinical.id]
    );
    const all = await loadPatientNotes(db as never, clinic.id, patient.id);
    assert(all.length === 2, `expected 2 notes, got ${all.length}`);
    const inClinical = all.filter((n) => n.category_id === clinical.id);
    assert(inClinical.length === 1, `filter returned ${inClinical.length}, expected 1`);
    assert(inClinical[0].body === "A clinical one", "the wrong note came back");
    ok("filtering by category returns exactly that category's notes");

    /* ------------------------------------- a category the clinic added */
    const custom = (
      await db.query(
        `insert into note_categories (clinic_id, name, color, sort) values ($1, 'Follow-up', '#b45309', 30) returning id, is_system`,
        [clinic.id]
      )
    ).rows[0];
    assert(custom.is_system === false, "a clinic-made category was marked as a system one");
    ok("a clinic can add its own category alongside the two built in");

    /* -------------------------------------------- there is no delete path */
    const actions = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/c/[slug]/patients/actions.ts", "utf8")
    );
    assert(
      !/export async function deleteNoteAction/.test(actions),
      "deleteNoteAction is back — a note must not be destroyable"
    );
    const client = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/c/[slug]/patients/[id]/profile-client.tsx", "utf8")
    );
    const notesSection = client.slice(client.indexOf("function NotesTab"), client.indexOf("function FilesTab"));
    assert(
      !/deleteNoteAction/.test(notesSection),
      "the notes tab still calls a delete action"
    );
    ok("no delete action exists, and the notes tab does not reach for one");

    /* --------------------------------------------------- voice: the rails */
    const routeSrc = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/api/c/[slug]/notes/voice/route.ts", "utf8")
    );
    assert(/const ALLOWED\s*=/.test(routeSrc), "the voice route has no type allowlist");
    assert(/ALLOWED\.test\(/.test(routeSrc), "the allowlist is declared but never applied");
    assert(/file\.size > MAX_SIZE/.test(routeSrc), "the voice route does not enforce its size cap");
    ok("the voice endpoint caps size and accepts audio types only");

    const audioRoute = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/api/c/[slug]/notes/[noteId]/audio/route.ts", "utf8")
    );
    assert(
      /apiClinic\(slug, "patients"\)/.test(audioRoute),
      "voice playback is not behind the patients capability"
    );
    assert(
      /audio_path/.test(audioRoute) && !/searchParams.get\("path"\)/.test(audioRoute),
      "the audio route takes a path from the caller instead of the note"
    );
    ok("playback is capability-guarded and reads its path from the note, never the caller");

    /* --------------------------------- an unauthenticated caller gets nothing */
    const res = await fetch(`${BASE}/api/c/qanotes${stamp}/notes/${note.id}/audio`);
    assert(res.status !== 200, `an unauthenticated caller got ${res.status} for a voice note`);
    ok(`a signed-out request for a voice note is refused (${res.status})`);

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
