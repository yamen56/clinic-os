/** Shared vocabulary for the document signing module. */

export type DocumentStatus =
  | "draft"
  | "sent"
  | "partially_signed"
  | "completed"
  | "declined"
  | "expired"
  | "voided";

export type SignerStatus = "pending" | "viewed" | "signed" | "declined";

export type DocumentEventType =
  | "created"
  | "sent"
  | "link_opened"
  | "otp_sent"
  | "otp_verified"
  | "viewed"
  | "field_completed"
  | "signed"
  | "declined"
  | "reminder_sent"
  | "completed"
  | "downloaded"
  | "voided"
  | "expired"
  | "revoked"
  | "resent"
  | "hash_mismatch"
  | "locked"
  | "unlocked"
  | "superseded"
  /** A signed copy from outside this platform was attached. */
  | "final_uploaded"
  /** A template was built from a file the clinic already had. */
  | "imported";

export type FieldType =
  | "text"
  | "number"
  | "date"
  | "phone"
  | "email"
  | "select"
  | "checkbox"
  | "longtext";

export type PlacedFieldType = "signature" | "initials" | "date" | "text" | "checkbox";

export const TEMPLATE_CATEGORIES = [
  "consent",
  "treatment_plan",
  "financial",
  "privacy",
  "other",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** Roles that sign inside the workspace with a saved signature. */
export const STAFF_ROLE_KEYS = new Set(["doctor", "clinic_owner", "clinic_representative"]);

/** A document nobody can act on any more. */
export const TERMINAL_STATUSES = new Set<DocumentStatus>([
  "completed",
  "declined",
  "expired",
  "voided",
]);

/** Guardians are required below this age; taken from the patient's birth date. */
export const AGE_OF_MAJORITY = 18;

/**
 * Recipes a new clinic gets switched on.
 *
 * Everything else in the library arrives disabled, so a clinic never sends a
 * patient something it did not choose to send. The three document alerts send
 * nothing to a patient at all — they raise a task or notify staff — which is why
 * they are safe to have live on day one, and why leaving them off would mean
 * unsigned paperwork quietly going nowhere.
 *
 * `welcome_new_patient` is the deliberate exception, and the only entry here
 * that messages a patient. It is on because the platform now promises that
 * behaviour: adding a patient greets them. Migration 0023 switched it on for the
 * clinics that already existed, so leaving it off here would mean a clinic
 * onboarded next month silently behaved differently from the one it was
 * demonstrated on — the worst kind of difference, because nothing reports it.
 *
 * Worth knowing when onboarding: a brand-new WhatsApp number whose first
 * outbound activity is unsolicited first contact is the likeliest ban profile
 * there is. The rails in worker/outbound.ts (daily cap, blast guard, sending
 * window) bound it, but a new number should still be warmed up on replies before
 * it leans on this.
 *
 * Lives here rather than in the seed script because both the seed script and
 * clinic creation need the same answer.
 */
export const RECIPES_ON_BY_DEFAULT = new Set([
  "document_expired_alert",
  "document_unsigned_escalate",
  "document_declined_alert",
  "welcome_new_patient",
  /*
    Reminders, on from the first day (Yamen, 2026-10-31): a clinic that has to
    find and switch on the one thing that cuts its no-shows usually never does.
    The confirmation answers reception's bookings only; the booking page and
    the AI confirm their own.
  */
  "confirm_on_booking",
  "reminder_24h",
  /*
    The doctor's own recall (2026-11-08): it only ever writes when a doctor
    set "come back in…" on the finish sheet and nothing is booked — the
    clinic asked for it at the chair, so it is on from the first day.
  */
  "next_visit_due_book",
  /*
    A psychiatry clinic's reminder: installed in place of reminder_24h, which
    names the clinic and the service on a lock screen (see clinic-provision).
  */
  "psych_discreet_reminder",
]);
