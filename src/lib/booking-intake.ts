import type { PoolClient } from "pg";

/**
 * The questions a clinic asks on its booking page, and what happens to the
 * answers.
 *
 * Two rules shape everything here:
 *
 * 1. An answer is a fact about the *visit*, so it is written onto the
 *    appointment as a frozen snapshot — label included. Clinics reword their
 *    questions constantly, and an appointment must keep showing the question
 *    the patient was actually asked.
 *
 * 2. A question may *also* be a fact about the person ("date of birth", "do you
 *    have insurance"). Those name a `patient_field_definitions` key, and the
 *    answer is written to the patient file through that definition — the same
 *    row the profile form and the document merge variables read. There is no
 *    second definition of where "allergies" lives.
 */

export const QUESTION_TYPES = [
  "text",
  "longtext",
  "number",
  "date",
  "select",
  "multiselect",
  "checkbox",
  "phone",
  "email",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export type BookingQuestion = {
  id: string;
  booking_link_id: string | null;
  label: string;
  label_ar: string | null;
  help: string | null;
  help_ar: string | null;
  field_type: QuestionType;
  options: string[];
  options_ar: string[];
  required: boolean;
  service_ids: string[];
  patient_field_key: string | null;
  active: boolean;
  display_order: number;
};

/** What the public page is told about a question — never the mapping. */
export type PublicQuestion = {
  id: string;
  label: string;
  labelAr: string;
  help: string | null;
  helpAr: string | null;
  type: QuestionType;
  options: string[];
  optionsAr: string[];
  required: boolean;
  serviceIds: string[];
};

/** One answer, as stored on the appointment. */
export type IntakeAnswer = {
  id: string;
  label: string;
  labelAr: string;
  type: QuestionType;
  /** A string for every type, so reading an answer never needs the question. */
  value: string;
};

const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * The questions for one link: the clinic-wide ones plus the ones scoped to it.
 *
 * `includeInactive` is for the settings screen, which has to show a question
 * that is switched off in order to switch it back on.
 */
export async function loadBookingQuestions(
  c: PoolClient,
  clinicId: string,
  opts: { linkId?: string | null; includeInactive?: boolean } = {}
): Promise<BookingQuestion[]> {
  const scope =
    opts.linkId === undefined
      ? ""
      : opts.linkId === null
        ? "and booking_link_id is null"
        : "and (booking_link_id is null or booking_link_id = $2)";
  const params: unknown[] = [clinicId];
  if (scope.includes("$2")) params.push(opts.linkId);

  const r = await c.query(
    `select id, booking_link_id, label, label_ar, help, help_ar, field_type, options, options_ar,
            required, service_ids, patient_field_key, active, display_order
     from booking_questions
     where clinic_id = $1 ${opts.includeInactive ? "" : "and active"} ${scope}
     order by display_order, label`,
    params
  );
  return r.rows.map((row) => ({
    ...row,
    options: asArray(row.options),
    options_ar: asArray(row.options_ar),
    service_ids: Array.isArray(row.service_ids) ? row.service_ids : [],
  })) as BookingQuestion[];
}

export function toPublicQuestion(q: BookingQuestion): PublicQuestion {
  return {
    id: q.id,
    label: q.label,
    labelAr: q.label_ar || q.label,
    help: q.help,
    helpAr: q.help_ar || q.help,
    type: q.field_type,
    options: q.options,
    // A half-translated option list would pair an Arabic label with an English
    // value and store the wrong string; fall back to one language for all.
    optionsAr: q.options_ar.length === q.options.length ? q.options_ar : q.options,
    required: q.required,
    serviceIds: q.service_ids,
  };
}

/**
 * The questions that apply to the service the patient picked.
 *
 * A question with no services listed applies to all of them — that is the
 * common case, and making a clinic tick every service to get it would be a
 * chore that silently breaks the day a new service is added.
 */
export function questionsForService<T extends { serviceIds: string[] }>(
  questions: T[],
  serviceId: string | null
): T[] {
  return questions.filter(
    (q) => !q.serviceIds.length || (serviceId !== null && q.serviceIds.includes(serviceId))
  );
}

const MAX_LEN: Record<QuestionType, number> = {
  text: 200,
  longtext: 2000,
  number: 40,
  date: 10,
  select: 200,
  multiselect: 600,
  checkbox: 10,
  phone: 40,
  email: 160,
};

/**
 * Check what the browser sent against the questions that actually apply.
 *
 * Done server-side against the clinic's own rows rather than trusting the
 * payload: the public page is the one surface where the form itself is
 * attacker-controlled, so a required question the browser chose not to render
 * is still required here, and a `select` still has to be one of the clinic's
 * own options rather than whatever was posted.
 */
export function validateAnswers(
  questions: PublicQuestion[],
  raw: unknown
): { answers: IntakeAnswer[] } | { error: string; questionId: string } {
  const given = new Map<string, unknown>();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) given.set(k, v);
  }

  const answers: IntakeAnswer[] = [];
  for (const q of questions) {
    const v = given.get(q.id);
    let value: string;

    if (q.type === "checkbox") {
      value = v === true || v === "true" ? "yes" : "no";
      // A required tick-box is a consent, not a question: "no" is not an answer.
      if (q.required && value !== "yes") return { error: "answer_required", questionId: q.id };
    } else if (q.type === "multiselect") {
      const picked = (Array.isArray(v) ? v : [])
        .filter((x): x is string => typeof x === "string")
        .filter((x) => q.options.includes(x));
      if (q.required && !picked.length) return { error: "answer_required", questionId: q.id };
      if (!picked.length) continue;
      value = picked.join(", ");
    } else {
      value = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
      if (!value) {
        if (q.required) return { error: "answer_required", questionId: q.id };
        // An unanswered optional question is left out entirely rather than
        // stored empty, so the appointment shows what was said, not a form.
        continue;
      }
      if (q.type === "select" && !q.options.includes(value)) {
        return { error: "answer_invalid", questionId: q.id };
      }
      if (q.type === "number" && !/^-?\d+(\.\d+)?$/.test(value)) {
        return { error: "answer_invalid", questionId: q.id };
      }
      if (q.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { error: "answer_invalid", questionId: q.id };
      }
      if (q.type === "email" && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value)) {
        return { error: "answer_invalid", questionId: q.id };
      }
      value = value.slice(0, MAX_LEN[q.type]);
    }

    answers.push({ id: q.id, label: q.label, labelAr: q.labelAr, type: q.type, value });
  }
  return { answers };
}

/**
 * Write the mapped answers onto the patient file.
 *
 * `coalesce` in every branch on purpose: booking is not the authority on the
 * patient record. A returning patient whose file already carries a birth date
 * must not have it overwritten by whatever was typed on a phone in a waiting
 * room — blanks get filled, existing values are left alone. Staff correct the
 * file from the profile, where the change is theirs and audited.
 */
export async function applyAnswersToPatient(
  c: PoolClient,
  clinicId: string,
  patientId: string,
  questions: BookingQuestion[],
  answers: IntakeAnswer[]
): Promise<void> {
  const mapped = questions.filter((q) => q.patient_field_key);
  if (!mapped.length) return;
  const byId = new Map(answers.map((a) => [a.id, a]));

  const defs = (
    await c.query(
      `select key, source_column, storage_key from patient_field_definitions
       where clinic_id = $1 and key = any($2::text[])`,
      [clinicId, mapped.map((q) => q.patient_field_key)]
    )
  ).rows as { key: string; source_column: string | null; storage_key: string | null }[];
  const defByKey = new Map(defs.map((d) => [d.key, d]));

  // The only columns a public form is allowed to fill. Phone is the patient
  // identity rule and the name is already collected, so neither is settable
  // here — a mapping pointing at one is ignored rather than honoured.
  const WRITABLE = new Set(["birth_date", "gender", "secondary_phone_e164"]);

  const custom: Record<string, string> = {};
  for (const q of mapped) {
    const a = byId.get(q.id);
    if (!a || !a.value) continue;
    const def = defByKey.get(q.patient_field_key!);
    if (!def) continue;

    if (def.source_column) {
      if (!WRITABLE.has(def.source_column)) continue;
      if (def.source_column === "birth_date") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(a.value)) continue;
        await c.query(
          `update patients set birth_date = coalesce(birth_date, $3::date)
           where id = $1 and clinic_id = $2`,
          [patientId, clinicId, a.value]
        );
      } else if (def.source_column === "gender") {
        const g = a.value.toLowerCase();
        if (g !== "male" && g !== "female") continue;
        await c.query(
          `update patients set gender = coalesce(gender, $3) where id = $1 and clinic_id = $2`,
          [patientId, clinicId, g]
        );
      } else {
        await c.query(
          `update patients set secondary_phone_e164 = coalesce(secondary_phone_e164, $3)
           where id = $1 and clinic_id = $2`,
          [patientId, clinicId, a.value]
        );
      }
      continue;
    }
    custom[def.storage_key ?? def.key.replace(/^patient\./, "")] = a.value;
  }

  if (Object.keys(custom).length) {
    /*
      `$3 || custom_fields` and not the other way round: the stored object wins
      key by key, so this fills the gaps without clobbering what staff typed.
      Re-stringified because a jsonb parameter handed a JS object goes out as a
      Postgres array literal.
    */
    await c.query(
      `update patients set custom_fields = $3::jsonb || custom_fields
       where id = $1 and clinic_id = $2`,
      [patientId, clinicId, JSON.stringify(custom)]
    );
  }
}

/**
 * One line per answer, for the notification staff actually read.
 *
 * Capped in both directions. A `longtext` answer can run to two thousand
 * characters and a clinic can ask a dozen questions; either would turn a
 * notification into a wall and push everything after it off the screen. The
 * full set is on the appointment, which is one tap away and where staff go to
 * read it properly.
 */
export function answersSummary(answers: IntakeAnswer[], locale: "ar" | "en"): string {
  const MAX_LINES = 6;
  const shown = answers.slice(0, MAX_LINES);
  const lines = shown.map((a) => {
    const label = locale === "ar" ? a.labelAr : a.label;
    const value = a.value.replace(/\s+/g, " ").trim();
    return `${label}: ${value.length > 120 ? `${value.slice(0, 119)}…` : value}`;
  });
  const rest = answers.length - shown.length;
  if (rest > 0) lines.push(locale === "ar" ? `و${rest} إجابة أخرى` : `and ${rest} more`);
  return lines.join("\n");
}
