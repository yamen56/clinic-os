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
  | "superseded";

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

/** Built-in signer roles. A clinic may add its own on top of these. */
export const SYSTEM_SIGNER_ROLES = [
  "patient",
  "guardian",
  "doctor",
  "clinic_owner",
  "clinic_representative",
  "witness",
] as const;

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

export const SIGNING_STEPS = 3;

/**
 * Recipes a new clinic gets switched on.
 *
 * Everything else in the library arrives disabled, so a clinic never sends a
 * patient something it did not choose to send. These three send nothing to a
 * patient at all — they raise a task or notify staff — which is why they are
 * safe to have live on day one, and why leaving them off would mean unsigned
 * paperwork quietly going nowhere.
 *
 * Lives here rather than in the seed script because both the seed script and
 * clinic creation need the same answer.
 */
export const RECIPES_ON_BY_DEFAULT = new Set([
  "document_expired_alert",
  "document_unsigned_escalate",
  "document_declined_alert",
]);
