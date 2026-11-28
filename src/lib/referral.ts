/**
 * Where a patient came from (migration 0128): the answer to "كيف عرفت عنا؟",
 * one of a short list, with a note for the friend's or the doctor's name.
 *
 * Not `patients.source`, which is how the file was made (the desk, the booking
 * link, WhatsApp). This is why the person came, which is what tells a clinic
 * which of its ads, or which referring doctor, brings patients.
 */

export const REFERRAL_SOURCES = ["instagram", "facebook", "tiktok", "google", "friend", "doctor", "insurance", "walk_in", "other"] as const;
export type ReferralSource = (typeof REFERRAL_SOURCES)[number];

export function asReferral(v: unknown): ReferralSource | null {
  return REFERRAL_SOURCES.includes(v as ReferralSource) ? (v as ReferralSource) : null;
}

/** The sources a note is asked for: who referred them, or what "other" was. */
export const REFERRAL_WITH_NOTE: ReadonlySet<ReferralSource> = new Set(["friend", "doctor", "other"]);

export function cleanReferralNote(v: unknown): string | null {
  const s = String(v ?? "").trim().slice(0, 120);
  return s || null;
}
