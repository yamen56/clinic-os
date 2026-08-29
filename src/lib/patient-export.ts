import type { PoolClient } from "pg";

/**
 * Everything that belongs in a patient's record when it leaves the clinic.
 *
 * The audience is a person — the patient asking for their file, or the doctor
 * they are being referred to — so this is the clinical record and not a dump of
 * every row we hold. Notes, visits, what was billed, what was signed.
 *
 * Deliberately not included: the WhatsApp thread. A year of it is mostly
 * scheduling, and burying four clinical notes inside two hundred messages makes
 * the record worse rather than more complete. The same goes for the audit log
 * and the tag catalogue, which are about running the clinic rather than about
 * the patient.
 */

export type ExportedClinic = {
  name: string;
  nameAr: string | null;
  address: string | null;
  addressAr: string | null;
  phone: string | null;
  logoPath: string | null;
  brandColor: string;
  timezone: string;
  currency: string;
  locale: "ar" | "en";
};

/**
 * One patient's record — the unit both the single-file export and the
 * whole-clinic one are built from, so the two documents cannot drift apart.
 */
export type ExportedRecord = {
  patient: {
    id: string;
    fullName: string;
    phone: string | null;
    secondaryPhone: string | null;
    birthDate: string | null;
    gender: string | null;
    tags: string[];
    status: string;
    createdAt: string;
    insurer: string | null;
    insuranceNo: string | null;
    customFields: { label: string; value: string }[];
  };
  notes: {
    id: string;
    body: string;
    category: string | null;
    categoryColor: string | null;
    author: string | null;
    createdAt: string;
    editedAt: string | null;
    /** A recording cannot be printed; the record says one exists. */
    hasAudio: boolean;
    audioSeconds: number | null;
  }[];
  appointments: {
    id: string;
    startsAt: string;
    status: string;
    service: string | null;
    doctor: string | null;
  }[];
  invoices: {
    id: string;
    number: string;
    status: string;
    total: string;
    amountPaid: string;
    issueDate: string | null;
  }[];
  documents: { id: string; title: string; status: string; createdAt: string }[];
  files: { id: string; fileName: string; createdAt: string }[];
};

export type ExportedPatient = { clinic: ExportedClinic; generatedAt: string } & ExportedRecord;

export type ExportedBatch = {
  clinic: ExportedClinic;
  records: ExportedRecord[];
  generatedAt: string;
};

/**
 * How many records one document may hold.
 *
 * Bounded by the renderer, and measured rather than guessed. The binding limit
 * is the 30s `page.goto` in worker/pdf.ts, not the 60s fetch around it. On a
 * dev server, with three notes and two visits per file:
 *
 *     400 records -> 14s, 2.1 MB
 *     600 records -> 18s, 3.1 MB
 *    1000 records -> dead at 30s
 *
 * Production renders faster than dev, so 400 keeps roughly a 2x margin against
 * the slower of the two. A clinic that has outgrown it is told the number and
 * asked to filter, rather than handed a medical record that stops silently at
 * four hundred — the one outcome worse than an error. Past that point the
 * answer is a background job that emails a link, not a bigger number here.
 */
export const MAX_EXPORT_RECORDS = 400;

/** Loads one patient's record, or nothing if the file is not this clinic's. */
export async function loadPatientExport(
  c: PoolClient,
  clinicId: string,
  patientId: string
): Promise<ExportedPatient | null> {
  const batch = await loadPatientExportBatch(c, clinicId, [patientId]);
  const record = batch.records[0];
  if (!record) return null;
  return { clinic: batch.clinic, generatedAt: batch.generatedAt, ...record };
}

/**
 * Loads many records in a fixed number of queries.
 *
 * Eight queries whether the caller asked for one patient or four hundred: each
 * child table is fetched for the whole set at once and grouped here. Looping
 * the single-patient load would have been six round trips per patient, and
 * node-pg serialises every query on one client, so there is no concurrency to
 * hide them behind — four hundred patients would have been two thousand
 * sequential round trips, which is the difference between a few seconds and
 * giving up.
 *
 * Records come back in the order the ids were given, so the caller decides how
 * the document reads.
 */
export async function loadPatientExportBatch(
  c: PoolClient,
  clinicId: string,
  patientIds: string[]
): Promise<ExportedBatch> {
  const clinicRow = (
    await c.query(
      `select name, name_ar, address, address_ar, phone_e164, logo_path, brand_color,
              timezone, currency, default_locale
         from clinics where id = $1`,
      [clinicId]
    )
  ).rows[0];
  const isAr = clinicRow.default_locale !== "en";
  const clinic: ExportedClinic = {
    name: clinicRow.name,
    nameAr: clinicRow.name_ar,
    address: clinicRow.address,
    addressAr: clinicRow.address_ar,
    phone: clinicRow.phone_e164,
    logoPath: clinicRow.logo_path,
    brandColor: clinicRow.brand_color,
    timezone: clinicRow.timezone,
    currency: clinicRow.currency,
    locale: isAr ? "ar" : "en",
  };

  const generatedAt = new Date().toISOString();
  if (!patientIds.length) return { clinic, records: [], generatedAt };

  const scope: [string, string[]] = [clinicId, patientIds];

  const patients = (
    await c.query(
      `select p.*, i.name as insurer_name
         from patients p
         left join insurers i on i.id = p.insurer_id
        where p.clinic_id = $1 and p.id = any($2::uuid[]) and p.merged_into is null`,
      scope
    )
  ).rows;

  /*
    The clinic's own field definitions, resolved to labels and values. A clinic
    that renamed "Allergies" or added "Referred by" has that on the file, and a
    record that silently drops it is missing exactly the part that clinic
    thought was worth collecting.
  */
  const defs = (
    await c.query(
      // Same filter the patient page uses, so the record shows the fields the
      // clinic actually put on the file — not hidden or retired ones.
      `select key, label, label_ar, field_type, storage_key, source_column
         from patient_field_definitions
        where clinic_id = $1 and scope = 'patient' and not hidden and show_in_profile
        order by display_order, label`,
      [clinicId]
    )
  ).rows.filter((d) => !d.source_column);

  const notes = (
    await c.query(
      `select n.patient_id, n.id, n.body, n.created_at, n.edited_at, n.audio_path, n.audio_seconds,
              cat.name as cat_name, cat.name_ar as cat_name_ar, cat.color as cat_color,
              u.full_name as author
         from patient_notes n
         left join note_categories cat on cat.id = n.category_id
         left join users u on u.id = n.author_id
        where n.clinic_id = $1 and n.patient_id = any($2::uuid[])
        order by n.created_at desc`,
      scope
    )
  ).rows;

  const appointments = (
    await c.query(
      `select a.patient_id, a.id, a.starts_at, a.status, s.name as service, s.name_ar as service_ar,
              u.full_name as doctor
         from appointments a
         left join services s on s.id = a.service_id
         left join clinic_members cm on cm.id = a.doctor_member_id
         left join users u on u.id = cm.user_id
        where a.clinic_id = $1 and a.patient_id = any($2::uuid[])
        order by a.starts_at desc`,
      scope
    )
  ).rows;

  const invoices = (
    await c.query(
      `select patient_id, id, number, status, total, amount_paid, issue_date
         from invoices where clinic_id = $1 and patient_id = any($2::uuid[])
        order by created_at desc`,
      scope
    )
  ).rows;

  const documents = (
    await c.query(
      `select patient_id, id, title, status, created_at from documents
        where clinic_id = $1 and patient_id = any($2::uuid[]) order by created_at desc`,
      scope
    )
  ).rows;

  const files = (
    await c.query(
      `select patient_id, id, file_name, created_at from patient_files
        where clinic_id = $1 and patient_id = any($2::uuid[]) order by created_at desc`,
      scope
    )
  ).rows;

  /** Rows arrive sorted; bucketing keeps that order within each patient. */
  const bucket = <T extends { patient_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.patient_id);
      if (list) list.push(r);
      else m.set(r.patient_id, [r]);
    }
    return m;
  };
  const notesBy = bucket(notes);
  const apptsBy = bucket(appointments);
  const invoicesBy = bucket(invoices);
  const docsBy = bucket(documents);
  const filesBy = bucket(files);

  const byId = new Map(patients.map((p) => [p.id as string, p]));
  const records: ExportedRecord[] = [];

  for (const id of patientIds) {
    const p = byId.get(id);
    if (!p) continue;
    const custom = (p.custom_fields ?? {}) as Record<string, unknown>;
    const customFields = defs
      .map((d) => {
        const key = (d.storage_key as string) ?? String(d.key).replace(/^patient\./, "");
        const raw = custom[key];
        const value =
          raw === null || raw === undefined || raw === ""
            ? ""
            : Array.isArray(raw)
              ? raw.join(", ")
              : String(raw);
        return { label: (isAr ? d.label_ar : null) || d.label, value };
      })
      .filter((f) => f.value !== "");

    records.push({
      patient: {
        id: p.id,
        fullName: p.full_name,
        phone: p.phone_e164,
        secondaryPhone: p.secondary_phone_e164,
        birthDate: p.birth_date ? String(p.birth_date) : null,
        gender: p.gender,
        tags: p.tags ?? [],
        status: p.status,
        createdAt: String(p.created_at),
        insurer: p.insurer_name ?? null,
        insuranceNo: p.insurance_no || null,
        customFields,
      },
      notes: (notesBy.get(id) ?? []).map((n) => ({
        id: n.id,
        body: n.body,
        category: ((isAr ? n.cat_name_ar : null) || n.cat_name) ?? null,
        categoryColor: n.cat_color ?? null,
        author: n.author ?? null,
        createdAt: String(n.created_at),
        editedAt: n.edited_at ? String(n.edited_at) : null,
        hasAudio: !!n.audio_path,
        audioSeconds: n.audio_seconds ?? null,
      })),
      appointments: (apptsBy.get(id) ?? []).map((a) => ({
        id: a.id,
        startsAt: String(a.starts_at),
        status: a.status,
        service: ((isAr ? a.service_ar : null) || a.service) ?? null,
        doctor: a.doctor ?? null,
      })),
      invoices: (invoicesBy.get(id) ?? []).map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
        total: String(i.total),
        amountPaid: String(i.amount_paid),
        issueDate: i.issue_date ? String(i.issue_date) : null,
      })),
      documents: (docsBy.get(id) ?? []).map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
        createdAt: String(d.created_at),
      })),
      files: (filesBy.get(id) ?? []).map((f) => ({
        id: f.id,
        fileName: f.file_name,
        createdAt: String(f.created_at),
      })),
    });
  }

  return { clinic, records, generatedAt };
}
