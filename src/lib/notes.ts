import type { PoolClient } from "pg";

/**
 * Patient notes.
 *
 * The rule this module exists to enforce: **a note is never destroyed.** There
 * is no delete, and an edit does not overwrite — it appends a version and moves
 * the note's own text forward. Anyone reading the file later can see what it
 * said the first time and every time since, and who changed it.
 *
 * That is why writing goes through `saveNoteVersion` rather than an `update`
 * scattered across an action and an autosave route: two writers, one of which
 * forgets to record the version, is the whole guarantee gone.
 */

export type NoteCategory = {
  id: string;
  key: string | null;
  name: string;
  name_ar: string | null;
  color: string;
  is_system: boolean;
  active: boolean;
  sort: number;
};

export type NoteVersion = {
  id: string;
  body: string;
  author: string | null;
  created_at: string;
};

export type PatientNote = {
  id: string;
  body: string;
  category_id: string | null;
  created_at: string;
  edited_at: string | null;
  author: string | null;
  edited_by_name: string | null;
  audio_path: string | null;
  audio_mime: string | null;
  audio_seconds: number | null;
  /** How many times it has been rewritten. 1 = never edited. */
  version_count: number;
  /**
   * The visit this note is about, when it is about one. Most notes are about
   * the patient rather than a particular appointment, so null is the norm.
   */
  appointment_id: string | null;
  appointment_starts_at: string | null;
  appointment_service: string | null;
  appointment_service_ar: string | null;
};

/** One of the patient's visits, as offered when filing a note against one. */
export type NoteAppointment = {
  id: string;
  starts_at: string;
  status: string;
  service_name: string | null;
  service_name_ar: string | null;
  doctor_name: string | null;
};

export async function loadNoteCategories(
  c: PoolClient,
  clinicId: string,
  opts: { includeInactive?: boolean } = {}
): Promise<NoteCategory[]> {
  const r = await c.query(
    `select id, key, name, name_ar, color, is_system, active, sort
     from note_categories
     where clinic_id = $1 ${opts.includeInactive ? "" : "and active"}
     order by sort, name`,
    [clinicId]
  );
  return r.rows as NoteCategory[];
}

/** The category a note falls back to when none was chosen. */
export async function defaultCategoryId(c: PoolClient, clinicId: string): Promise<string | null> {
  const r = await c.query(
    `select id from note_categories where clinic_id = $1 and active
     order by (key = 'clinical') desc, sort limit 1`,
    [clinicId]
  );
  return (r.rows[0]?.id as string) ?? null;
}

export async function loadPatientNotes(
  c: PoolClient,
  clinicId: string,
  patientId: string
): Promise<PatientNote[]> {
  const r = await c.query(
    `select n.id, n.body, n.category_id, n.created_at, n.edited_at,
            n.audio_path, n.audio_mime, n.audio_seconds,
            u.full_name as author, e.full_name as edited_by_name,
            (select count(*)::int from patient_note_versions v where v.note_id = n.id) as version_count,
            n.appointment_id,
            a.starts_at as appointment_starts_at,
            s.name as appointment_service, s.name_ar as appointment_service_ar
     from patient_notes n
     left join users u on u.id = n.author_id
     left join users e on e.id = n.edited_by
     left join appointments a on a.id = n.appointment_id
     left join services s on s.id = a.service_id
     where n.clinic_id = $1 and n.patient_id = $2
     order by n.created_at desc`,
    [clinicId, patientId]
  );
  return r.rows as PatientNote[];
}

/**
 * The visits a note may be filed against.
 *
 * Cancelled ones are included on purpose: a note explaining *why* a visit was
 * cancelled belongs to that visit, and is exactly the note somebody goes
 * looking for later.
 */
export async function loadNoteAppointments(
  c: PoolClient,
  clinicId: string,
  patientId: string
): Promise<NoteAppointment[]> {
  const r = await c.query(
    `select a.id, a.starts_at, a.status,
            s.name as service_name, s.name_ar as service_name_ar,
            u.full_name as doctor_name
     from appointments a
     left join services s on s.id = a.service_id
     left join clinic_members cm on cm.id = a.doctor_member_id
     left join users u on u.id = cm.user_id
     where a.clinic_id = $1 and a.patient_id = $2
     order by a.starts_at desc
     limit 100`,
    [clinicId, patientId]
  );
  return r.rows as NoteAppointment[];
}

/** The notes written about one visit, newest first. */
export async function loadAppointmentNotes(
  c: PoolClient,
  clinicId: string,
  appointmentId: string
): Promise<PatientNote[]> {
  const r = await c.query(
    `select n.id, n.body, n.category_id, n.created_at, n.edited_at,
            n.audio_path, n.audio_mime, n.audio_seconds,
            u.full_name as author, e.full_name as edited_by_name,
            (select count(*)::int from patient_note_versions v where v.note_id = n.id) as version_count,
            n.appointment_id,
            a.starts_at as appointment_starts_at,
            s.name as appointment_service, s.name_ar as appointment_service_ar
     from patient_notes n
     left join users u on u.id = n.author_id
     left join users e on e.id = n.edited_by
     left join appointments a on a.id = n.appointment_id
     left join services s on s.id = a.service_id
     where n.clinic_id = $1 and n.appointment_id = $2
     order by n.created_at desc`,
    [clinicId, appointmentId]
  );
  return r.rows as PatientNote[];
}

/**
 * File a note against a visit, or unfile it.
 *
 * Not routed through `saveNoteVersion`, and the distinction is deliberate:
 * versions exist to preserve what a note *said*, and this changes only which
 * drawer it sits in. Recording "filed under the 14th" as a new revision of the
 * text would pad the history with entries whose body is identical to the one
 * before, which is precisely what the version list is meant not to be. The move
 * is still recorded — in the audit log, by the caller.
 *
 * The appointment is checked to belong to the same patient. Without that, a note
 * could be filed against a stranger's visit and would then show up on their
 * timeline.
 */
export async function setNoteAppointment(
  c: PoolClient,
  clinicId: string,
  noteId: string,
  appointmentId: string | null
): Promise<boolean> {
  if (appointmentId) {
    const ok = await c.query(
      `select 1 from appointments a
       join patient_notes n on n.patient_id = a.patient_id
       where a.id = $1 and n.id = $2 and a.clinic_id = $3 and n.clinic_id = $3`,
      [appointmentId, noteId, clinicId]
    );
    if (!ok.rowCount) return false;
  }
  const r = await c.query(
    `update patient_notes set appointment_id = $3 where id = $1 and clinic_id = $2`,
    [noteId, clinicId, appointmentId]
  );
  return !!r.rowCount;
}

/** Every version of one note, oldest first — so the first row is the original. */
export async function loadNoteHistory(
  c: PoolClient,
  clinicId: string,
  noteId: string
): Promise<NoteVersion[]> {
  const r = await c.query(
    `select v.id, v.body, v.created_at, u.full_name as author
     from patient_note_versions v
     left join users u on u.id = v.author_id
     where v.clinic_id = $1 and v.note_id = $2
     order by v.created_at`,
    [clinicId, noteId]
  );
  return r.rows as NoteVersion[];
}

/**
 * Record a change to a note, keeping what it said before.
 *
 * Returns false when nothing actually changed, which matters more than it
 * sounds: the notes field autosaves, so without this check a doctor who taps
 * into a note and back out again would file a version identical to the last
 * one, and a history of forty identical entries is no history at all.
 */
export async function saveNoteVersion(
  c: PoolClient,
  clinicId: string,
  noteId: string,
  patch: { body?: string; categoryId?: string | null },
  userId: string
): Promise<boolean> {
  const cur = (
    await c.query(
      `select body, category_id from patient_notes where id = $1 and clinic_id = $2 for update`,
      [noteId, clinicId]
    )
  ).rows[0];
  if (!cur) return false;

  const body = patch.body === undefined ? (cur.body as string) : patch.body;
  const categoryId =
    patch.categoryId === undefined ? (cur.category_id as string | null) : patch.categoryId;
  if (body === cur.body && categoryId === cur.category_id) return true;

  await c.query(
    `update patient_notes set body = $3, category_id = $4, edited_at = now(), edited_by = $5
     where id = $1 and clinic_id = $2`,
    [noteId, clinicId, body, categoryId, userId]
  );
  await c.query(
    `insert into patient_note_versions (clinic_id, note_id, body, category_id, author_id)
     values ($1, $2, $3, $4, $5)`,
    [clinicId, noteId, body, categoryId, userId]
  );
  return true;
}

/** Create a note and its first version in one go. */
export async function createNote(
  c: PoolClient,
  clinicId: string,
  input: {
    patientId: string;
    authorId: string;
    body: string;
    categoryId: string | null;
    appointmentId?: string | null;
    audio?: { path: string; mime: string; seconds: number } | null;
  }
): Promise<string> {
  const r = await c.query(
    `insert into patient_notes
       (clinic_id, patient_id, author_id, category_id, body, appointment_id,
        audio_path, audio_mime, audio_seconds)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      clinicId,
      input.patientId,
      input.authorId,
      input.categoryId,
      input.body,
      input.appointmentId ?? null,
      input.audio?.path ?? null,
      input.audio?.mime ?? null,
      input.audio?.seconds ?? null,
    ]
  );
  const id = r.rows[0].id as string;
  await c.query(
    `insert into patient_note_versions (clinic_id, note_id, body, category_id, author_id)
     values ($1, $2, $3, $4, $5)`,
    [clinicId, id, input.body, input.categoryId, input.authorId]
  );
  return id;
}
