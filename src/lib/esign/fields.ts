import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import type { FieldType } from "./constants";

/**
 * Merge variables.
 *
 * There is no fixed list. A clinic's `patient_field_definitions` rows *are* the
 * list: the same rows drive the patient profile form, the variable picker in
 * the template editor, and the preview, so adding a field in settings makes it
 * usable in a template immediately.
 *
 * `key` is the token exactly as it appears between the braces — `patient.phone`,
 * `clinic.name`, `today` — so nothing has to translate between what the editor
 * shows and what the renderer looks for.
 */

export type FieldDefinition = {
  id: string;
  scope: "patient" | "context";
  key: string;
  label: string;
  label_ar: string | null;
  field_type: FieldType;
  options: string[];
  is_required: boolean;
  is_system: boolean;
  hidden: boolean;
  show_in_profile: boolean;
  source_column: string | null;
  source_path: string | null;
  storage_key: string | null;
  display_order: number;
};

export type ResolvedField = {
  key: string;
  label: string;
  labelAr: string;
  value: string;
  /** Set on the document rather than read from the patient record. */
  isOverride: boolean;
  /** Exists only on this document. */
  isOneOff: boolean;
  scope: "patient" | "context";
  /** Where staff must go to fill this in, when it is empty. */
  fixHint: "patient" | "clinic" | "appointment" | "service" | "doctor" | null;
};

export async function loadFieldDefinitions(
  c: PoolClient,
  clinicId: string,
  opts: { includeHidden?: boolean } = {}
): Promise<FieldDefinition[]> {
  const r = await c.query(
    `select id, scope, key, label, label_ar, field_type, options, is_required, is_system,
            hidden, show_in_profile, source_column, source_path, storage_key, display_order
     from patient_field_definitions
     where clinic_id = $1 ${opts.includeHidden ? "" : "and not hidden"}
     order by display_order, label`,
    [clinicId]
  );
  return r.rows.map((row) => ({
    ...row,
    options: Array.isArray(row.options) ? row.options : [],
  })) as FieldDefinition[];
}

export function labelFor(d: { label: string; label_ar: string | null }, locale: string): string {
  return locale === "ar" ? d.label_ar || d.label : d.label;
}

/** Everything a document merges from, loaded once. */
export type MergeSources = {
  clinic: {
    id: string;
    name: string;
    name_ar: string | null;
    address: string | null;
    address_ar: string | null;
    phone_e164: string | null;
    timezone: string;
    currency: string;
  };
  patient: Record<string, unknown> | null;
  doctorName: string | null;
  service: { name: string; name_ar: string | null; price: string } | null;
  appointmentStartsAt: string | null;
};

/**
 * The visit a document is about, when nobody said which one.
 *
 * A consent form raised chairside from the patient's file has no appointment
 * attached, and without one the doctor, the service and the price all merge
 * empty — which blocks sending and reads as a bug rather than as missing data.
 * The visit staff mean is almost always the next one booked; failing that, the
 * one that just happened.
 *
 * Returned rather than assumed, so the caller can record it on the document and
 * the merged values have a traceable source.
 */
export async function resolveContextAppointment(
  c: PoolClient,
  clinicId: string,
  patientId: string
): Promise<string | null> {
  const r = await c.query(
    `select id from appointments
     where clinic_id = $1 and patient_id = $2
       and status not in ('cancelled', 'no_show')
     order by
       -- Upcoming first, nearest first; then the most recent past visit.
       case when starts_at >= now() then 0 else 1 end,
       case when starts_at >= now() then starts_at else null end asc nulls last,
       starts_at desc
     limit 1`,
    [clinicId, patientId]
  );
  return (r.rows[0]?.id as string) ?? null;
}

export async function loadMergeSources(
  c: PoolClient,
  clinicId: string,
  ids: {
    patientId?: string | null;
    appointmentId?: string | null;
    serviceId?: string | null;
    doctorMemberId?: string | null;
  }
): Promise<MergeSources> {
  const clinic = (
    await c.query(
      `select id, name, name_ar, address, address_ar, phone_e164, timezone, currency
       from clinics where id = $1`,
      [clinicId]
    )
  ).rows[0];

  const patient = ids.patientId
    ? ((
        await c.query(`select * from patients where id = $1 and clinic_id = $2`, [
          ids.patientId,
          clinicId,
        ])
      ).rows[0] ?? null)
    : null;

  // The appointment supplies the service and doctor unless they were named
  // outright, so a document raised from the calendar merges without staff
  // repeating what the booking already knows. A document raised from the patient
  // file falls back to the visit it is obviously about.
  let serviceId = ids.serviceId ?? null;
  let doctorMemberId = ids.doctorMemberId ?? null;
  let appointmentStartsAt: string | null = null;

  const appointmentId =
    ids.appointmentId ??
    (ids.patientId ? await resolveContextAppointment(c, clinicId, ids.patientId) : null);

  if (appointmentId) {
    const a = (
      await c.query(
        `select starts_at, service_id, doctor_member_id from appointments
         where id = $1 and clinic_id = $2`,
        [appointmentId, clinicId]
      )
    ).rows[0];
    if (a) {
      appointmentStartsAt = a.starts_at ? new Date(a.starts_at).toISOString() : null;
      serviceId = serviceId ?? a.service_id;
      doctorMemberId = doctorMemberId ?? a.doctor_member_id;
    }
  }

  const service = serviceId
    ? ((
        await c.query(
          `select name, name_ar, price from services where id = $1 and clinic_id = $2`,
          [serviceId, clinicId]
        )
      ).rows[0] ?? null)
    : null;

  const doctorName = doctorMemberId
    ? ((
        await c.query(
          `select u.full_name from clinic_members cm join users u on u.id = cm.user_id
           where cm.id = $1 and cm.clinic_id = $2`,
          [doctorMemberId, clinicId]
        )
      ).rows[0]?.full_name ?? null)
    : null;

  return {
    clinic,
    patient,
    doctorName,
    service: service
      ? { name: service.name, name_ar: service.name_ar, price: String(service.price) }
      : null,
    appointmentStartsAt,
  };
}

function fmtDateValue(iso: string | Date | null, tz: string, locale: string): string {
  if (!iso) return "";
  return DateTime.fromJSDate(new Date(iso))
    .setZone(tz)
    .setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB")
    .toFormat("d LLLL yyyy");
}

/** Resolves one definition against the loaded sources. Empty string means missing. */
function resolveOne(
  def: FieldDefinition,
  src: MergeSources,
  locale: "ar" | "en"
): { value: string; fixHint: ResolvedField["fixHint"] } {
  const tz = src.clinic.timezone;

  if (def.scope === "context") {
    switch (def.source_path) {
      case "clinic.name":
        return {
          value: (locale === "ar" ? src.clinic.name_ar : null) || src.clinic.name || "",
          fixHint: "clinic",
        };
      case "clinic.address":
        return {
          value: (locale === "ar" ? src.clinic.address_ar : null) || src.clinic.address || "",
          fixHint: "clinic",
        };
      case "clinic.phone":
        return { value: src.clinic.phone_e164 || "", fixHint: "clinic" };
      case "doctor.name":
        return { value: src.doctorName || "", fixHint: "doctor" };
      case "service.name":
        return {
          value: src.service
            ? (locale === "ar" ? src.service.name_ar : null) || src.service.name
            : "",
          fixHint: "service",
        };
      case "service.price":
        return {
          value: src.service ? `${Number(src.service.price).toFixed(2)} ${src.clinic.currency}` : "",
          fixHint: "service",
        };
      case "appointment.date":
        return {
          value: fmtDateValue(src.appointmentStartsAt, tz, locale),
          fixHint: "appointment",
        };
      case "today":
        // Never missing, and never the server's timezone.
        return { value: fmtDateValue(new Date(), tz, locale), fixHint: null };
      default:
        return { value: "", fixHint: null };
    }
  }

  const p = src.patient;
  if (!p) return { value: "", fixHint: "patient" };

  if (def.source_column) {
    const raw = p[def.source_column];
    if (raw === null || raw === undefined || raw === "") return { value: "", fixHint: "patient" };
    if (def.field_type === "date") return { value: fmtDateValue(raw as string, tz, locale), fixHint: "patient" };
    if (def.source_column === "gender") {
      const g = String(raw);
      const label = locale === "ar" ? (g === "male" ? "ذكر" : "أنثى") : g === "male" ? "Male" : "Female";
      return { value: label, fixHint: "patient" };
    }
    return { value: String(raw), fixHint: "patient" };
  }

  const custom = (p.custom_fields ?? {}) as Record<string, unknown>;
  const storageKey = def.storage_key ?? def.key.replace(/^patient\./, "");
  const raw = custom[storageKey];
  if (raw === null || raw === undefined || raw === "") return { value: "", fixHint: "patient" };
  if (typeof raw === "boolean") {
    return { value: raw ? (locale === "ar" ? "نعم" : "Yes") : locale === "ar" ? "لا" : "No", fixHint: "patient" };
  }
  if (def.field_type === "date") return { value: fmtDateValue(String(raw), tz, locale), fixHint: "patient" };
  return { value: String(raw), fixHint: "patient" };
}

/**
 * The merge table for a document that has not been frozen yet: every visible
 * definition, resolved, in display order.
 */
export function resolveFields(
  defs: FieldDefinition[],
  src: MergeSources,
  locale: "ar" | "en"
): ResolvedField[] {
  return defs.map((def) => {
    const { value, fixHint } = resolveOne(def, src, locale);
    return {
      key: def.key,
      label: def.label,
      labelAr: def.label_ar || def.label,
      value,
      isOverride: false,
      isOneOff: false,
      scope: def.scope,
      fixHint: value ? null : fixHint,
    };
  });
}

/** The tokens a body actually uses — `{{ patient.phone }}` and `{{patient.phone}}` both count. */
export function tokensUsed(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) found.add(m[1]);
  return [...found];
}
