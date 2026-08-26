"use server";

import { revalidatePath } from "next/cache";
import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { findOrCreatePatient } from "@/lib/patients";
import { normalizePhone } from "@/lib/phone";
import { deleteFile } from "@/lib/storage";
import { emitTrigger } from "@/lib/triggers";
import { createNote, defaultCategoryId, loadNoteHistory, saveNoteVersion } from "@/lib/notes";

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
      /*
        Fires even with no phone. A welcome message will skip itself for want of
        a number, but an automation on this trigger may equally tag the file or
        raise a task, and those are still owed.
      */
      await emitTrigger(c, access.clinicId, "patient_created", {
        patientId: r.rows[0].id,
        source: "staff",
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
      /*
        Only on creation, and only from here — which is the point. This action is
        one patient typed by one person, so a welcome message is a greeting. A
        bulk import reaches `findOrCreatePatient` directly and emits nothing,
        because greeting four hundred numbers at once is how a WhatsApp number
        gets banned.
      */
      await emitTrigger(c, access.clinicId, "patient_created", {
        patientId: result.id,
        source: "staff",
      });
    }
    return { id: result.id, existing: !result.created };
  });
}

/**
 * Opens the WhatsApp thread for a patient, creating it if there is none.
 *
 * Staff could previously only reply. The send route takes a conversation id, and
 * a conversation only came into existence when the patient wrote in — so the one
 * patient who most needs a message, the one just added, was the one nobody could
 * message. The clinic's workaround was wa.me, which sends from the phone and
 * leaves the platform knowing nothing about it.
 *
 * Nothing new is being invented here: `queueWhatsAppMessage` already opens a
 * conversation on demand for every automated sender. This gives staff the same
 * door.
 */
export async function openConversationAction(
  slug: string,
  patientId: string
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "conversations")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const p = await c.query(
      `select phone_e164 from patients where id = $1 and clinic_id = $2 and merged_into is null`,
      [patientId, access.clinicId]
    );
    if (!p.rowCount) return { error: "not_found" };
    const phone = p.rows[0].phone_e164 as string | null;
    if (!phone) return { error: "no_phone" };

    const conv = await c.query(
      `insert into conversations (clinic_id, phone_e164, patient_id)
       values ($1, $2, $3)
       on conflict (clinic_id, phone_e164)
       do update set patient_id = coalesce(conversations.patient_id, excluded.patient_id)
       returning id`,
      [access.clinicId, phone, patientId]
    );
    return { id: conv.rows[0].id as string };
  });
}

export async function addTagAction(slug: string, patientId: string, tag: string) {
  const access = await requireClinic(slug);
  const clean = tag.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!clean) return;
  await inClinic(access, async (c) => {
    await c.query(
      `update patients set tags = array_append(tags, $2)
       where id = $1 and clinic_id = $3 and not ($2 = any(tags))`,
      [patientId, clean, access.clinicId]
    );
    /*
      Typing a tag on a patient file is how most of them get created, so the
      catalogue has to adopt it here. Skip this and Settings → Tags shows a
      different vocabulary from the one the patient list is filtering by, and
      the tag nobody can rename is the one everybody actually uses.
    */
    await c.query(
      `insert into clinic_tags (clinic_id, name) values ($1, $2)
       on conflict (clinic_id, name) do nothing`,
      [access.clinicId, clean]
    );
  });
  revalidatePath(`/c/${slug}/patients`);
  revalidatePath(`/c/${slug}/settings/tags`);
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
  categoryId: string | null
): Promise<{ id: string }> {
  const access = await requireClinic(slug);
  return inClinic(access, async (c) => {
    const id = await createNote(c, access.clinicId, {
      patientId,
      authorId: access.session.user.id,
      body,
      categoryId: categoryId ?? (await defaultCategoryId(c, access.clinicId)),
    });
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.note.create",
      entity: "patient_note",
      entityId: id,
      detail: { patientId },
    });
    return { id };
  });
}

/** The versions of one note, oldest first. The first row is the original. */
export async function noteHistoryAction(
  slug: string,
  noteId: string
): Promise<{ id: string; body: string; author: string | null; created_at: string }[]> {
  const access = await requireClinic(slug);
  return inClinic(access, (c) =>
    loadNoteHistory(c, access.clinicId, noteId).then((rows) =>
      JSON.parse(JSON.stringify(rows))
    )
  );
}

/**
 * Move a note to another category.
 *
 * Goes through `saveNoteVersion` like every other change, so recategorising is
 * recorded rather than silently rewriting a filed record.
 */
export async function setNoteCategoryAction(
  slug: string,
  noteId: string,
  categoryId: string | null
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  return inClinic(access, async (c) => {
    const ok = await saveNoteVersion(
      c,
      access.clinicId,
      noteId,
      { categoryId },
      access.session.user.id
    );
    if (!ok) return { error: "not_found" };
    revalidatePath(`/c/${slug}/patients`);
    return {};
  });
}

/**
 * Categories are clinic-defined, and managed from the patient file rather than
 * a settings screen — the moment you want a new one is the moment you are
 * writing a note that does not fit the existing ones.
 */
export async function saveNoteCategoryAction(
  slug: string,
  input: { id?: string; name: string; nameAr?: string; color?: string; active?: boolean }
): Promise<{ error?: string; id?: string }> {
  const access = await requireClinic(slug);
  const name = input.name.trim().slice(0, 60);
  if (!name) return { error: "invalid" };
  const color = /^#[0-9a-fA-F]{6}$/.test(input.color ?? "") ? input.color! : "#6989a6";

  return inClinic(access, async (c) => {
    if (input.id) {
      const r = await c.query(
        `update note_categories set name = $3, name_ar = $4, color = $5, active = $6
         where id = $1 and clinic_id = $2`,
        [input.id, access.clinicId, name, input.nameAr?.trim() || null, color, input.active !== false]
      );
      if (!r.rowCount) return { error: "not_found" };
      revalidatePath(`/c/${slug}/patients`);
      return { id: input.id };
    }
    const r = await c.query(
      `insert into note_categories (clinic_id, name, name_ar, color, sort)
       values ($1, $2, $3, $4,
               (select coalesce(max(sort), 0) + 10 from note_categories where clinic_id = $1))
       returning id`,
      [access.clinicId, name, input.nameAr?.trim() || null, color]
    );
    revalidatePath(`/c/${slug}/patients`);
    return { id: r.rows[0].id as string };
  });
}

/*
  There is no deleteNoteAction, and its absence is the feature.

  A patient note is a clinical record: the thing you most want to remove is
  usually the thing that most needs to still be there. Corrections go through
  saveNoteVersion, which keeps what the note said before — see lib/notes.ts.
*/

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

/*
  Custom field definitions moved to `patient_field_definitions` and now live in
  `settings/fields/actions.ts`. They had to move: the same rows have to drive the
  patient form, the merge-variable picker and the document preview, and two
  tables would have meant two truths. The old `custom_field_defs` rows were
  copied across by migration 0010 and are no longer read.
*/
