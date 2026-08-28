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

export type ExportedPatient = {
  clinic: {
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
  generatedAt: string;
};

/**
 * Loads the record.
 *
 * Sequential rather than parallel: node-pg serialises every query on one client
 * anyway, so `Promise.all` here would buy nothing and cost a readable stack.
 */
export async function loadPatientExport(
  c: PoolClient,
  clinicId: string,
  patientId: string
): Promise<ExportedPatient | null> {
  const p = (
    await c.query(
      `select p.*, i.name as insurer_name
         from patients p
         left join insurers i on i.id = p.insurer_id
        where p.id = $1 and p.clinic_id = $2 and p.merged_into is null`,
      [patientId, clinicId]
    )
  ).rows[0];
  if (!p) return null;

  const clinic = (
    await c.query(
      `select name, name_ar, address, address_ar, phone_e164, logo_path, brand_color,
              timezone, currency, default_locale
         from clinics where id = $1`,
      [clinicId]
    )
  ).rows[0];

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
  ).rows;
  const isAr = clinic.default_locale !== "en";
  const custom = (p.custom_fields ?? {}) as Record<string, unknown>;
  const customFields = defs
    .filter((d) => !d.source_column)
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

  const notes = (
    await c.query(
      `select n.id, n.body, n.created_at, n.edited_at, n.audio_path, n.audio_seconds,
              cat.name as cat_name, cat.name_ar as cat_name_ar, cat.color as cat_color,
              u.full_name as author
         from patient_notes n
         left join note_categories cat on cat.id = n.category_id
         left join users u on u.id = n.author_id
        where n.clinic_id = $1 and n.patient_id = $2
        order by n.created_at desc`,
      [clinicId, patientId]
    )
  ).rows;

  const appointments = (
    await c.query(
      `select a.id, a.starts_at, a.status, s.name as service, s.name_ar as service_ar,
              u.full_name as doctor
         from appointments a
         left join services s on s.id = a.service_id
         left join clinic_members cm on cm.id = a.doctor_member_id
         left join users u on u.id = cm.user_id
        where a.clinic_id = $1 and a.patient_id = $2
        order by a.starts_at desc`,
      [clinicId, patientId]
    )
  ).rows;

  const invoices = (
    await c.query(
      `select id, number, status, total, amount_paid, issue_date
         from invoices where clinic_id = $1 and patient_id = $2
        order by created_at desc`,
      [clinicId, patientId]
    )
  ).rows;

  const documents = (
    await c.query(
      `select id, title, status, created_at from documents
        where clinic_id = $1 and patient_id = $2 order by created_at desc`,
      [clinicId, patientId]
    )
  ).rows;

  const files = (
    await c.query(
      `select id, file_name, created_at from patient_files
        where clinic_id = $1 and patient_id = $2 order by created_at desc`,
      [clinicId, patientId]
    )
  ).rows;

  return {
    clinic: {
      name: clinic.name,
      nameAr: clinic.name_ar,
      address: clinic.address,
      addressAr: clinic.address_ar,
      phone: clinic.phone_e164,
      logoPath: clinic.logo_path,
      brandColor: clinic.brand_color,
      timezone: clinic.timezone,
      currency: clinic.currency,
      locale: isAr ? "ar" : "en",
    },
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
    notes: notes.map((n) => ({
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
    appointments: appointments.map((a) => ({
      id: a.id,
      startsAt: String(a.starts_at),
      status: a.status,
      service: ((isAr ? a.service_ar : null) || a.service) ?? null,
      doctor: a.doctor ?? null,
    })),
    invoices: invoices.map((i) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      total: String(i.total),
      amountPaid: String(i.amount_paid),
      issueDate: i.issue_date ? String(i.issue_date) : null,
    })),
    documents: documents.map((d) => ({
      id: d.id,
      title: d.title,
      status: d.status,
      createdAt: String(d.created_at),
    })),
    files: files.map((f) => ({
      id: f.id,
      fileName: f.file_name,
      createdAt: String(f.created_at),
    })),
    generatedAt: new Date().toISOString(),
  };
}
