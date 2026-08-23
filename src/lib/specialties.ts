/**
 * What a clinic actually practises.
 *
 * Used for one thing: deciding which automation recipes it is handed on day
 * one. A dental clinic needs post-extraction aftercare and an orthodontic
 * recall; an eye clinic needs a warning that its patients will not be able to
 * drive home. Neither is any use to the other, and a library containing both is
 * a library nobody reads.
 *
 * 'general' is the neutral value and means two different things on purpose: a
 * clinic that is general practice, and a recipe that suits every clinic
 * whatever it practises. Every clinic gets the 'general' recipes plus the ones
 * for its own field — the specialty adds, it never replaces.
 */
export const SPECIALTIES = [
  "general",
  "dental",
  "dermatology",
  "ophthalmology",
  "obgyn",
  "pediatrics",
  "orthopedics",
  "physiotherapy",
  "ent",
  "cardiology",
  "nutrition",
  "psychiatry",
  "plastic_surgery",
  "urology",
  "internal_medicine",
] as const;

export type Specialty = (typeof SPECIALTIES)[number];

export function isSpecialty(v: unknown): v is Specialty {
  return typeof v === "string" && (SPECIALTIES as readonly string[]).includes(v);
}

export function asSpecialty(v: unknown): Specialty {
  return isSpecialty(v) ? v : "general";
}
