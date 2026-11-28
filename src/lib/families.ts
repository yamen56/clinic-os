import type { PoolClient } from "pg";

/**
 * Families (migration 0127): patient files that belong together — a mother
 * and the children she brings, from one phone.
 *
 * Each member has a role, said on screen with their gender (أم، ابن، جدة…),
 * and one member is the contact: the number whatever is sent to a member
 * without a phone of their own goes to (`patient_reach_phone`).
 */

export const FAMILY_ROLES = ["parent", "child", "grandparent", "other"] as const;
export type FamilyRole = (typeof FAMILY_ROLES)[number];

export function asFamilyRole(v: unknown): FamilyRole | null {
  return FAMILY_ROLES.includes(v as FamilyRole) ? (v as FamilyRole) : null;
}

export type FamilyMember = {
  id: string;
  name: string;
  gender: "male" | "female" | null;
  birthDate: string | null;
  phone: string | null;
  role: FamilyRole | null;
  isContact: boolean;
  /** What they owe, for a member who may see it; null otherwise. */
  owed: number | null;
  nextAt: string | null;
};

export type Family = {
  id: string;
  contactId: string | null;
  members: FamilyMember[];
};

export type RoleWords = {
  parentMale: string;
  parentFemale: string;
  parent: string;
  childMale: string;
  childFemale: string;
  child: string;
  grandparentMale: string;
  grandparentFemale: string;
  grandparent: string;
  otherMale: string;
  otherFemale: string;
  other: string;
};

/** "Mother", "Son", "Grandfather" — the role in the member's own gender, or the neutral word. */
export function familyRoleLabel(role: FamilyRole | null, gender: string | null, w: RoleWords): string {
  if (!role) return "";
  const g = gender === "male" ? "Male" : gender === "female" ? "Female" : "";
  return (w as Record<string, string>)[`${role}${g}`] ?? w[role];
}

/**
 * The family a patient belongs to, every member with what the screen says
 * about them. `owes` is the caller's decision (canSeeOwes plus the invoice
 * scope): a figure the member may not see is not computed. Its placeholders
 * start at $4 — build it with `invoiceScopeSql(access, "i", 4)`.
 */
export async function loadFamily(
  c: PoolClient,
  clinicId: string,
  patientId: string,
  owes: { sql: string; params: unknown[] } | null
): Promise<Family | null> {
  const fam = (
    await c.query(
      `select f.id, f.contact_patient_id from patients p join patient_families f on f.id = p.family_id
        where p.id = $1 and p.clinic_id = $2`,
      [patientId, clinicId]
    )
  ).rows[0];
  if (!fam) return null;
  const owedSql = owes
    ? `(select coalesce(sum(i.total - i.amount_paid), 0)::float from invoices i
         where i.clinic_id = $1 and i.patient_id = m.id
           and i.status in ('draft', 'sent', 'partially_paid') and i.credit_note_of is null${owes.sql})`
    : "null::float";
  const rows = (
    await c.query(
      `select m.id, m.full_name, m.gender, m.birth_date::text as birth_date, m.phone_e164, m.family_role,
              ${owedSql} as owed,
              (select min(a.starts_at) from appointments a
                where a.patient_id = m.id and a.clinic_id = $1 and a.starts_at > now()
                  and a.status in ('pending_approval', 'scheduled', 'confirmed')) as next_at
         from patients m
        where m.clinic_id = $1 and m.family_id = $2 and m.merged_into is null
        order by coalesce(m.id = $3, false) desc, coalesce(m.family_role = 'child', false), m.birth_date nulls last, m.created_at`,
      [clinicId, fam.id, fam.contact_patient_id, ...(owes?.params ?? [])]
    )
  ).rows;
  return {
    id: fam.id as string,
    contactId: (fam.contact_patient_id as string | null) ?? null,
    members: rows.map((r) => ({
      id: r.id as string,
      name: r.full_name as string,
      gender: r.gender === "male" || r.gender === "female" ? r.gender : null,
      birthDate: (r.birth_date as string | null) ?? null,
      phone: (r.phone_e164 as string | null) ?? null,
      role: asFamilyRole(r.family_role),
      isContact: r.id === fam.contact_patient_id,
      owed: r.owed === null || r.owed === undefined ? null : Number(r.owed),
      nextAt: r.next_at ? new Date(r.next_at).toISOString() : null,
    })),
  };
}

/** Each member's age in whole years on `today`, or null without a birth date. */
export function ageOn(birthDate: string | null, today: string): number | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}/.test(birthDate)) return null;
  const [by, bm, bd] = birthDate.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = today.slice(0, 10).split("-").map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return age >= 0 && age < 130 ? age : null;
}
