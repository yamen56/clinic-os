"use server";

import { revalidatePath } from "next/cache";
import { requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { findOrCreatePatient } from "@/lib/patients";
import { normalizePhone } from "@/lib/phone";
import { deleteFile } from "@/lib/storage";

export async function createPatientAction(
  slug: string,
  data: { fullName: string; phone: string }
): Promise<{ id?: string; existing?: boolean; error?: string }> {
  const access = await requireClinic(slug);
  const name = data.fullName.trim();
  if (!name) return { error: "name_required" };
  if (data.phone.trim() && !normalizePhone(data.phone)) return { error: "invalid_phone" };

  return inClinic(access, async (c) => {
    if (!data.phone.trim()) {
      const r = await c.query(
        `insert into patients (clinic_id, full_name, source) values ($1, $2, 'staff') returning id`,
        [access.clinicId, name]
      );
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "patient.create",
        entity: "patient",
        entityId: r.rows[0].id,
      });
      return { id: r.rows[0].id as string };
    }
    const result = await findOrCreatePatient(c, access.clinicId, {
      phone: data.phone,
      fullName: name,
      source: "staff",
    });
    if (result.created) {
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "patient.create",
        entity: "patient",
        entityId: result.id,
      });
    }
    return { id: result.id, existing: !result.created };
  });
}

export async function addTagAction(slug: string, patientId: string, tag: string) {
  const access = await requireClinic(slug);
  const clean = tag.trim().slice(0, 40);
  if (!clean) return;
  await inClinic(access, (c) =>
    c.query(
      `update patients set tags = array_append(tags, $2)
       where id = $1 and clinic_id = $3 and not ($2 = any(tags))`,
      [patientId, clean, access.clinicId]
    )
  );
  revalidatePath(`/c/${slug}/patients`);
}

export async function removeTagAction(slug: string, patientId: string, tag: string) {
  const access = await requireClinic(slug);
  await inClinic(access, (c) =>
    c.query(`update patients set tags = array_remove(tags, $2) where id = $1 and clinic_id = $3`, [
      patientId,
      tag,
      access.clinicId,
    ])
  );
  revalidatePath(`/c/${slug}/patients`);
}

export async function addNoteAction(
  slug: string,
  patientId: string,
  body: string,
  kind: "clinical" | "admin"
): Promise<{ id: string }> {
  const access = await requireClinic(slug);
  return inClinic(access, async (c) => {
    const r = await c.query(
      `insert into patient_notes (clinic_id, patient_id, author_id, kind, body)
       values ($1, $2, $3, $4, $5) returning id`,
      [access.clinicId, patientId, access.session.user.id, kind, body]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.note.create",
      entity: "patient_note",
      entityId: r.rows[0].id,
      detail: { patientId },
    });
    return { id: r.rows[0].id as string };
  });
}

export async function deleteNoteAction(slug: string, noteId: string) {
  const access = await requireClinic(slug);
  await inClinic(access, async (c) => {
    await c.query(`delete from patient_notes where id = $1 and clinic_id = $2`, [
      noteId,
      access.clinicId,
    ]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.note.delete",
      entity: "patient_note",
      entityId: noteId,
    });
  });
}

export async function deletePatientFileAction(slug: string, fileId: string) {
  const access = await requireClinic(slug);
  await inClinic(access, async (c) => {
    const r = await c.query(
      `delete from patient_files where id = $1 and clinic_id = $2 returning storage_path`,
      [fileId, access.clinicId]
    );
    if (r.rowCount) await deleteFile(r.rows[0].storage_path);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.file.delete",
      entity: "patient_file",
      entityId: fileId,
    });
  });
}

export async function setPatientStatusAction(
  slug: string,
  patientId: string,
  status: "lead" | "active" | "archived"
) {
  const access = await requireClinic(slug);
  await inClinic(access, async (c) => {
    await c.query(`update patients set status = $2 where id = $1 and clinic_id = $3`, [
      patientId,
      status,
      access.clinicId,
    ]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.status",
      entity: "patient",
      entityId: patientId,
      detail: { status },
    });
  });
  revalidatePath(`/c/${slug}/patients`);
}

/**
 * Merge tool: moves everything from `duplicateId` into `keepId`, keeps both
 * phone numbers on the surviving file, marks the duplicate as merged.
 */
export async function mergePatientsAction(
  slug: string,
  keepId: string,
  duplicateId: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (keepId === duplicateId) return { error: "self" };
  return inClinic(access, async (c) => {
    const both = await c.query(
      `select id, phone_e164, secondary_phone_e164, extra_phones, tags, custom_fields, notes_summary, whatsapp_name, birth_date, gender, last_visit_at
       from patients where clinic_id = $1 and id = any($2::uuid[]) and merged_into is null for update`,
      [access.clinicId, [keepId, duplicateId]]
    );
    if (both.rowCount !== 2) return { error: "not_found" };
    const keep = both.rows.find((r) => r.id === keepId)!;
    const dup = both.rows.find((r) => r.id === duplicateId)!;

    // Re-point every child record
    for (const [table, col] of [
      ["patient_notes", "patient_id"],
      ["patient_files", "patient_id"],
      ["appointments", "patient_id"],
      ["invoices", "patient_id"],
      ["payments", "patient_id"],
      ["tasks", "patient_id"],
      ["automation_runs", "patient_id"],
    ] as const) {
      await c.query(`update ${table} set ${col} = $1 where ${col} = $2 and clinic_id = $3`, [
        keepId,
        duplicateId,
        access.clinicId,
      ]);
    }
    // Conversations: keep is authoritative; duplicate's threads point to keep
    await c.query(
      `update conversations set patient_id = $1 where patient_id = $2 and clinic_id = $3`,
      [keepId, duplicateId, access.clinicId]
    );

    // Merge identity: all numbers stay reachable on the surviving file
    const phones = new Set<string>(
      [
        keep.phone_e164,
        keep.secondary_phone_e164,
        ...(keep.extra_phones ?? []),
        dup.phone_e164,
        dup.secondary_phone_e164,
        ...(dup.extra_phones ?? []),
      ].filter(Boolean)
    );
    phones.delete(keep.phone_e164);
    const secondary = keep.secondary_phone_e164 ?? [...phones][0] ?? null;
    if (secondary) phones.delete(secondary);

    const tags = [...new Set([...(keep.tags ?? []), ...(dup.tags ?? [])])];
    const customFields = { ...(dup.custom_fields ?? {}), ...(keep.custom_fields ?? {}) };
    const notesSummary = [keep.notes_summary, dup.notes_summary].filter(Boolean).join("\n").trim();

    await c.query(
      `update patients set
         secondary_phone_e164 = $2, extra_phones = $3, tags = $4, custom_fields = $5,
         notes_summary = $6,
         whatsapp_name = coalesce(whatsapp_name, $7),
         birth_date = coalesce(birth_date, $8),
         gender = coalesce(gender, $9),
         last_visit_at = nullif(
           greatest(coalesce(last_visit_at, 'epoch'::timestamptz), coalesce($10::timestamptz, 'epoch'::timestamptz)),
           'epoch'::timestamptz
         )
       where id = $1`,
      [
        keepId,
        secondary,
        [...phones],
        tags,
        JSON.stringify(customFields),
        notesSummary,
        dup.whatsapp_name,
        dup.birth_date,
        dup.gender,
        dup.last_visit_at,
      ]
    );
    // Free the unique phone slot, then tombstone the duplicate
    await c.query(
      `update patients set merged_into = $1, phone_e164 = null, status = 'archived' where id = $2`,
      [keepId, duplicateId]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.merge",
      entity: "patient",
      entityId: keepId,
      detail: { duplicateId, phones: [...phones] },
    });
    return {};
  });
}

export async function saveCustomFieldDefAction(
  slug: string,
  def: {
    id?: string;
    label: string;
    labelAr: string;
    fieldType: string;
    options: string[];
  }
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (access.role !== "owner") return { error: "forbidden" };
  const key =
    def.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || `field_${Date.now().toString(36)}`;
  await inClinic(access, async (c) => {
    if (def.id) {
      await c.query(
        `update custom_field_defs set label = $2, label_ar = $3, field_type = $4, options = $5
         where id = $1 and clinic_id = $6`,
        [def.id, def.label, def.labelAr, def.fieldType, JSON.stringify(def.options), access.clinicId]
      );
    } else {
      await c.query(
        `insert into custom_field_defs (clinic_id, key, label, label_ar, field_type, options, sort)
         values ($1, $2, $3, $4, $5, $6, (select coalesce(max(sort), 0) + 1 from custom_field_defs where clinic_id = $1))
         on conflict (clinic_id, key) do update set label = excluded.label, label_ar = excluded.label_ar`,
        [access.clinicId, key, def.label, def.labelAr, def.fieldType, JSON.stringify(def.options)]
      );
    }
  });
  revalidatePath(`/c/${slug}/settings/fields`);
  return {};
}

export async function deleteCustomFieldDefAction(slug: string, id: string) {
  const access = await requireClinic(slug);
  if (access.role !== "owner") return;
  await inClinic(access, (c) =>
    c.query(`delete from custom_field_defs where id = $1 and clinic_id = $2`, [id, access.clinicId])
  );
  revalidatePath(`/c/${slug}/settings/fields`);
}
