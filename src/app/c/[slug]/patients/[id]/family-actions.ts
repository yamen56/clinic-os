"use server";

/*
  Families (migration 0127), from the patient file's Family card.

  Joining is always "this file and that one": the family is created the first
  time two files are put together, and dissolved when only one member is left.
  A member moved here from another family leaves that one; nobody is in two.

  The contact — whose number a member without one is reached on — must have a
  number. It is chosen for the clinic when the family is made (the first
  member with a phone) and whenever the contact leaves; reception can change it.
*/

import type { PoolClient } from "pg";
import { revalidatePath } from "next/cache";
import { can, requireClinic, type ClinicAccess } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { emitTrigger } from "@/lib/triggers";
import { asFamilyRole, type FamilyRole } from "@/lib/families";
import { isUuid } from "@/lib/uuid";

type Result = { error?: string; memberId?: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whoever has a number, the given one first, when the family has no contact. */
async function settleContact(c: PoolClient, clinicId: string, familyId: string, prefer?: string): Promise<void> {
  await c.query(
    `update patient_families f
        set contact_patient_id = (
          select m.id from patients m
           where m.family_id = f.id and m.clinic_id = $2 and m.merged_into is null and m.phone_e164 is not null
           order by (m.id = $3::uuid) desc, (m.family_role = 'parent') desc nulls last, m.created_at
           limit 1)
      where f.id = $1 and f.clinic_id = $2
        and (f.contact_patient_id is null
             or not exists (select 1 from patients g where g.id = f.contact_patient_id and g.family_id = f.id
                              and g.merged_into is null and g.phone_e164 is not null))`,
    [familyId, clinicId, prefer ?? null]
  );
}

/** A family of one is no family: its last member is let go and the family removed. */
async function dissolveIfAlone(c: PoolClient, clinicId: string, familyId: string): Promise<void> {
  const n = (
    await c.query(`select count(*)::int as n from patients where family_id = $1 and clinic_id = $2 and merged_into is null`, [familyId, clinicId])
  ).rows[0].n as number;
  if (n > 1) return;
  await c.query(`update patients set family_id = null, family_role = null where family_id = $1 and clinic_id = $2`, [familyId, clinicId]);
  await c.query(`delete from patient_families where id = $1 and clinic_id = $2`, [familyId, clinicId]);
}

function done(slug: string, ...ids: string[]) {
  for (const id of ids) revalidatePath(`/c/${slug}/patients/${id}`);
}

function logged(access: ClinicAccess, action: string, entityId: string, detail: Record<string, unknown>) {
  return {
    clinicId: access.clinicId,
    userId: access.session.user.id,
    impersonatedBy: access.session.impersonatedBy,
    action,
    entity: "patient",
    entityId,
    detail,
  };
}

/**
 * Puts another file in this patient's family — one already on file, or a new
 * one typed here with no phone (a child) — with its role, and this patient's
 * own role when it had none: adding a child makes this patient a parent, and
 * adding a parent makes them a child.
 */
export async function addFamilyMemberAction(
  slug: string,
  patientId: string,
  input: {
    otherId?: string;
    newMember?: { fullName: string; gender?: string | null; birthDate?: string | null };
    role: FamilyRole | null;
  }
): Promise<Result> {
  const access = await requireClinic(slug);
  if (!can(access, "patients")) return { error: "forbidden" };
  if (!isUuid(patientId)) return { error: "not_found" };
  const role = asFamilyRole(input.role);
  const fresh = input.newMember;
  if (!input.otherId && !fresh) return { error: "invalid" };
  if (input.otherId && !isUuid(input.otherId)) return { error: "not_found" };
  if (input.otherId === patientId) return { error: "self" };
  if (fresh) {
    if (!fresh.fullName?.trim() || fresh.fullName.trim().length > 200) return { error: "name_required" };
    if (fresh.birthDate && !ISO_DAY.test(fresh.birthDate)) return { error: "bad_date" };
  }

  return inClinic(access, async (c) => {
    const me = (
      await c.query(
        `select id, family_id, family_role, phone_e164 from patients where id = $1 and clinic_id = $2 and merged_into is null for update`,
        [patientId, access.clinicId]
      )
    ).rows[0];
    if (!me) return { error: "not_found" };

    let familyId = me.family_id as string | null;
    if (!familyId) {
      familyId = (
        await c.query(`insert into patient_families (clinic_id, created_by) values ($1, $2) returning id`, [access.clinicId, access.session.user.id])
      ).rows[0].id as string;
      await c.query(`update patients set family_id = $1 where id = $2`, [familyId, patientId]);
    }

    let memberId: string;
    if (fresh) {
      const gender = fresh.gender === "male" || fresh.gender === "female" ? fresh.gender : null;
      memberId = (
        await c.query(
          `insert into patients (clinic_id, full_name, gender, birth_date, source, created_by, family_id, family_role)
           values ($1, $2, $3, $4::date, 'staff', $5, $6, $7) returning id`,
          [access.clinicId, fresh.fullName.trim(), gender, fresh.birthDate || null, access.session.user.id, familyId, role]
        )
      ).rows[0].id as string;
      await audit(c, logged(access, "patient.create", memberId, { family: familyId }));
      // As any patient typed in by hand; a welcome skips itself for want of a number of the member's own.
      await emitTrigger(c, access.clinicId, "patient_created", { patientId: memberId, source: "staff" });
    } else {
      const other = (
        await c.query(`select id, family_id from patients where id = $1 and clinic_id = $2 and merged_into is null for update`, [input.otherId, access.clinicId])
      ).rows[0];
      if (!other) return { error: "not_found" };
      memberId = other.id as string;
      const left = other.family_id && other.family_id !== familyId ? (other.family_id as string) : null;
      await c.query(`update patients set family_id = $1, family_role = coalesce($2, family_role) where id = $3`, [familyId, role, memberId]);
      if (left) {
        await settleContact(c, access.clinicId, left);
        await dissolveIfAlone(c, access.clinicId, left);
      }
    }

    // This patient's own role, when it had none and the other's says what it must be.
    if (!me.family_role && (role === "child" || role === "parent")) {
      await c.query(`update patients set family_role = $1 where id = $2`, [role === "child" ? "parent" : "child", patientId]);
    }
    await settleContact(c, access.clinicId, familyId, me.phone_e164 ? patientId : undefined);
    await audit(c, logged(access, "patient.family_add", patientId, { familyId, memberId, role }));
    done(slug, patientId, memberId);
    return { memberId };
  });
}

/** Takes a member out of the family (never deletes their file). */
export async function removeFamilyMemberAction(slug: string, patientId: string, memberId: string): Promise<Result> {
  const access = await requireClinic(slug);
  if (!can(access, "patients")) return { error: "forbidden" };
  if (!isUuid(patientId) || !isUuid(memberId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const fam = (
      await c.query(
        `select m.family_id from patients m join patients p on p.family_id = m.family_id
          where m.id = $1 and p.id = $2 and m.clinic_id = $3 and p.clinic_id = $3`,
        [memberId, patientId, access.clinicId]
      )
    ).rows[0]?.family_id as string | undefined;
    if (!fam) return { error: "not_found" };
    await c.query(`update patients set family_id = null, family_role = null where id = $1 and clinic_id = $2`, [memberId, access.clinicId]);
    await settleContact(c, access.clinicId, fam);
    await dissolveIfAlone(c, access.clinicId, fam);
    await audit(c, logged(access, "patient.family_remove", patientId, { familyId: fam, memberId }));
    done(slug, patientId, memberId);
    return { memberId };
  });
}

/** Makes a member with a phone the one the others are reached through. */
export async function setFamilyContactAction(slug: string, patientId: string, memberId: string): Promise<Result> {
  const access = await requireClinic(slug);
  if (!can(access, "patients")) return { error: "forbidden" };
  if (!isUuid(patientId) || !isUuid(memberId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const r = await c.query(
      `update patient_families f set contact_patient_id = m.id
         from patients m, patients p
        where m.id = $1 and p.id = $2 and m.family_id = f.id and p.family_id = f.id
          and m.clinic_id = $3 and f.clinic_id = $3 and m.phone_e164 is not null and m.merged_into is null
        returning f.id`,
      [memberId, patientId, access.clinicId]
    );
    if (!r.rowCount) return { error: "no_phone" };
    await audit(c, logged(access, "patient.family_contact", patientId, { familyId: r.rows[0].id, memberId }));
    done(slug, patientId);
    return { memberId };
  });
}
