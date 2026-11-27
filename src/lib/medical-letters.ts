import type { PoolClient } from "pg";

/**
 * Medical letters: sick leave, a medical report, a referral (migration 0123).
 *
 * Built like prescriptions (lib/prescriptions): one numbered series per
 * clinic, written in a doctor's name, printed on the letterhead with the
 * doctor's signature, sent on WhatsApp or printed.
 *
 * Imported by the composer in the browser as well as by the server, so
 * nothing here may reach for a Node module — `PoolClient` is a type only.
 */

export type LetterKind = "sick_leave" | "report" | "referral";
export const LETTER_KINDS: readonly LetterKind[] = ["sick_leave", "report", "referral"];
export type LetterLocale = "ar" | "en";

export const MAX_LEAVE_DAYS = 90;
export const MAX_BODY = 4000;
export const MAX_DIAGNOSIS = 300;
export const MAX_ADDRESSEE = 200;

/** The one-tap lengths of a sick leave; anything else is typed. */
export const LEAVE_DAY_CHIPS = [1, 2, 3, 5, 7] as const;

export function letterNumber(n: number): string {
  return `ML-${String(n).padStart(4, "0")}`;
}

/** yyyy-MM-dd plus whole days, with no timezone to drift through: the leave is calendar days. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** The last day of a leave, counted inclusively: one day from the 3rd ends on the 3rd. */
export function leaveUntil(from: string, days: number): string {
  return addDays(from, Math.max(1, days) - 1);
}

/**
 * "3 أيام", "يومين", "11 يوماً" — Arabic counts its nouns, and a sick leave
 * that reads "2 أيام" looks typed by a machine to the employer who reads it.
 */
export function daysPhrase(n: number, locale: LetterLocale): string {
  if (locale === "en") return n === 1 ? "1 day" : `${n} days`;
  if (n === 1) return "يوم واحد";
  if (n === 2) return "يومين";
  if (n <= 10) return `${n} أيام`;
  return `${n} يوماً`;
}

/** Whole years on a given day, or null without a birth date. */
export function ageOn(birth: string | null | undefined, onIso: string): number | null {
  if (!birth) return null;
  const b = String(birth).slice(0, 10);
  const [by, bm, bd] = b.split("-").map(Number);
  const [y, m, d] = onIso.slice(0, 10).split("-").map(Number);
  if (!by || !y) return null;
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age >= 0 && age < 130 ? age : null;
}

/** A letter as the patient file lists it. */
export type LetterRow = {
  id: string;
  kind: LetterKind;
  number: number;
  created_at: string;
  locale: LetterLocale;
  doctor_member_id: string | null;
  doctor_name: string;
  author_name: string | null;
  by_other: boolean;
  diagnosis: string;
  body: string;
  addressee: string;
  leave_from: string | null;
  leave_days: number | null;
  urgent: boolean;
  signed: boolean;
  has_pdf: boolean;
  sent_at: string | null;
  message_id: string | null;
  message_status: string | null;
  appointment_id: string | null;
};

const ROW_SELECT = `
  select l.id, l.kind, l.number, l.created_at, l.locale, l.doctor_member_id, l.doctor_name,
         au.full_name as author_name, coalesce(dm.user_id <> l.author_id, false) as by_other,
         l.diagnosis, l.body, l.addressee, l.leave_from::text as leave_from, l.leave_days, l.urgent,
         l.signed, l.pdf_path is not null as has_pdf, l.sent_at, l.message_id,
         m.status as message_status, l.appointment_id
    from medical_letters l
    left join users au on au.id = l.author_id
    left join clinic_members dm on dm.id = l.doctor_member_id
    left join messages m on m.id = l.message_id`;

/**
 * The patient's letters as a json column, for folding into the patient
 * select the file already makes (see PATIENT_PRESCRIPTIONS_JSON for why).
 * `$1` is the patient id and `$2` the clinic id.
 */
export const PATIENT_LETTERS_JSON = `(
  select coalesce(json_agg(r order by r.created_at desc), '[]'::json) from (
    ${ROW_SELECT}
     where l.patient_id = $1 and l.clinic_id = $2
  ) r
)`;

export const LETTER_ROW_SQL = `${ROW_SELECT} where l.id = $1 and l.clinic_id = $2`;

/** The next number in the clinic's letter series, serialised on the clinic row. */
export async function allocateLetterNumber(c: PoolClient, clinicId: string): Promise<number> {
  const r = await c.query(
    `update clinics set letter_counter = letter_counter + 1 where id = $1 returning letter_counter`,
    [clinicId]
  );
  return r.rows[0].letter_counter as number;
}

/**
 * What a draft may not be without, so the composer and the server refuse the
 * same things. Returns the field to point at, or null when it can be written.
 */
export function letterProblem(d: {
  kind: LetterKind;
  addressee: string;
  body: string;
  diagnosis: string;
  leaveFrom: string | null;
  leaveDays: number | null;
}): "leave" | "addressee" | "body" | null {
  if (d.kind === "sick_leave") {
    if (!d.leaveFrom || !/^\d{4}-\d{2}-\d{2}$/.test(d.leaveFrom)) return "leave";
    if (!d.leaveDays || d.leaveDays < 1 || d.leaveDays > MAX_LEAVE_DAYS) return "leave";
    return null;
  }
  if (d.kind === "referral" && !d.addressee.trim()) return "addressee";
  // A report or a referral that says nothing is not a letter.
  if (!d.body.trim() && !d.diagnosis.trim()) return "body";
  return null;
}
