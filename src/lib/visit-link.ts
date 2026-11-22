import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { internalSecret } from "./internal-secret";
import { appUrl } from "./urls";

/**
 * The patient's own link to one appointment: see it, move it, cancel it.
 *
 * Derived, not stored. The token is the appointment's id followed by an HMAC of
 * that id and the patient it belongs to, so:
 *
 *  - any message can print it at any time — the confirmation, the day-before
 *    reminder, a reply to "2", reception's "send the link" — without a column
 *    to fill or a backfill for the visits booked before this existed;
 *  - it is not guessable and cannot be made for another appointment;
 *  - it dies on its own when the visit is given to a different patient, since
 *    the patient is part of what was signed.
 *
 * What makes a link enough is where it goes: only ever to the patient's own
 * WhatsApp, the same footing as a signing link. What it allows is bounded by the
 * clinic's rules (`patient_changes`, migration 0115) and checked on every
 * request, so a link that leaks can at worst do what the patient could, and the
 * patient hears about anything done with it.
 */

const ID_LEN = 22; // 16 bytes of uuid, base64url
const MAC_BYTES = 16;

function mac(appointmentId: string, patientId: string): Buffer {
  return createHmac("sha256", internalSecret())
    .update(`visit:${appointmentId}:${patientId}`)
    .digest()
    .subarray(0, MAC_BYTES);
}

function uuidToB64(id: string): string {
  return Buffer.from(id.replace(/-/g, ""), "hex").toString("base64url");
}

function b64ToUuid(s: string): string | null {
  const hex = Buffer.from(s, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function visitToken(appointmentId: string, patientId: string): string {
  return uuidToB64(appointmentId) + mac(appointmentId, patientId).toString("base64url");
}

export function visitUrl(appointmentId: string, patientId: string): string {
  return `${appUrl()}/v/${visitToken(appointmentId, patientId)}`;
}

/** The appointment a token names. Not yet proof: `verifyVisitToken` once its patient is known. */
export function visitTokenAppointment(token: string): string | null {
  if (typeof token !== "string" || token.length !== ID_LEN + 22 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return b64ToUuid(token.slice(0, ID_LEN));
}

/*
  The whole string, against the one this visit would be given. Comparing decoded
  bytes accepted other spellings of the same token: base64url's last character
  carries padding bits, so "…A" and "…B" can decode alike. One visit, one link.
*/
export function verifyVisitToken(token: string, appointmentId: string, patientId: string): boolean {
  const given = Buffer.from(token);
  const expected = Buffer.from(visitToken(appointmentId, patientId));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/* -------------------------------------------------------------------------
   The clinic's rules
   ------------------------------------------------------------------------- */

export type PatientChangesMode = "off" | "cancel" | "cancel_move";
export const PATIENT_CHANGE_MODES: PatientChangesMode[] = ["off", "cancel", "cancel_move"];
export const CUTOFF_CHOICES = [2, 6, 12, 24, 48] as const;
/** After this many moves from the link, the patient is asked to call. */
export const MAX_PATIENT_MOVES = 2;
export const ACTIVE_STATUSES = ["pending_approval", "scheduled", "confirmed"];

export type VisitRights = {
  cancel: boolean;
  move: boolean;
  /**
   * Why the link can do less than everything, for the page to say:
   * `closed` (cancelled, done, no-show) · `past` · `off` · `too_late` ·
   * `cancel_only` · `moves_used` · `not_online` (a service not bookable online).
   */
  why: null | "closed" | "past" | "off" | "too_late" | "cancel_only" | "moves_used" | "not_online";
};

export function visitRights(v: {
  mode: PatientChangesMode;
  cutoffHours: number;
  status: string;
  startsAt: string | Date;
  moves: number;
  /** Every service on the visit is active and bookable online, and there is at least one. */
  bookable: boolean;
  now?: number;
}): VisitRights {
  const now = v.now ?? Date.now();
  const start = new Date(v.startsAt).getTime();
  if (!ACTIVE_STATUSES.includes(v.status)) return { cancel: false, move: false, why: "closed" };
  if (start <= now) return { cancel: false, move: false, why: "past" };
  if (v.mode === "off") return { cancel: false, move: false, why: "off" };
  if (start - now < v.cutoffHours * 3_600_000) return { cancel: false, move: false, why: "too_late" };
  if (v.mode === "cancel") return { cancel: true, move: false, why: "cancel_only" };
  if (v.moves >= MAX_PATIENT_MOVES) return { cancel: true, move: false, why: "moves_used" };
  if (!v.bookable) return { cancel: true, move: false, why: "not_online" };
  return { cancel: true, move: true, why: null };
}

/** The link to print in a message, or "" when the clinic keeps patient changes off or the visit is over. */
export async function manageLinkFor(c: PoolClient, appointmentId: string): Promise<string> {
  const r = (
    await c.query(
      `select a.id, a.patient_id, a.status, a.starts_at, cl.patient_changes
         from appointments a join clinics cl on cl.id = a.clinic_id where a.id = $1`,
      [appointmentId]
    )
  ).rows[0];
  if (!r || r.patient_changes === "off") return "";
  if (!ACTIVE_STATUSES.includes(r.status)) return "";
  if (new Date(r.starts_at).getTime() <= Date.now()) return "";
  return visitUrl(r.id, r.patient_id);
}

/**
 * Whether the patient can change this visit from its link right now — the
 * automation condition "They can change it online", which the day-before
 * reminder's "2" asks before it hands the patient their link instead of
 * giving reception a call to make.
 */
export async function patientCanChange(c: PoolClient, appointmentId: string): Promise<boolean> {
  const r = (
    await c.query(
      `select a.status, a.starts_at, a.patient_moves, ${VISIT_BOOKABLE_SQL("a")} as bookable,
              cl.patient_changes, cl.patient_changes_cutoff_hours
         from appointments a join clinics cl on cl.id = a.clinic_id where a.id = $1`,
      [appointmentId]
    )
  ).rows[0];
  if (!r) return false;
  const rights = visitRights({
    mode: r.patient_changes,
    cutoffHours: r.patient_changes_cutoff_hours,
    status: r.status,
    startsAt: r.starts_at,
    moves: r.patient_moves,
    bookable: r.bookable,
  });
  return rights.cancel || rights.move;
}

/**
 * The SQL that answers "is every service on this visit one the booking page
 * could offer". Moving a visit uses the online booking's engine, and a clinic
 * that kept a service off its booking page (a surgery, a first assessment) did
 * so for a reason: the patient can still cancel it, not reschedule it alone.
 */
export const VISIT_BOOKABLE_SQL = (a: string) => `(
  ${a}.service_id is not null
  and not exists (
    select 1 from services s
     where s.id in (select ${a}.service_id union all select e.service_id from appointment_extra_services e where e.appointment_id = ${a}.id)
       and not (s.active and s.bookable_online)
  )
)`;
