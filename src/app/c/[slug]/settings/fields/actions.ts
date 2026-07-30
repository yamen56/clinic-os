"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";

/**
 * Patient field definitions.
 *
 * These rows are the source of truth for three surfaces at once — the patient
 * form, the merge-variable picker in the template editor, and the document
 * preview — so a field added here is usable in a template with no further step.
 *
 * The two rules that matter: a system field may be renamed, reordered or hidden
 * but never deleted (the platform reads phone and birth date by key), and
 * deleting a field never touches a document that was already signed with it.
 */

const defSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().trim().min(1).max(80),
  labelAr: z.string().trim().max(80).default(""),
  fieldType: z.enum(["text", "number", "date", "phone", "email", "select", "checkbox", "longtext"]),
  options: z.array(z.string().trim().min(1).max(80)).max(60).default([]),
  isRequired: z.boolean().default(false),
  showInProfile: z.boolean().default(true),
  hidden: z.boolean().default(false),
});

function slugKey(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || `field_${Date.now().toString(36)}`
  );
}

export async function saveFieldDefAction(
  slug: string,
  input: unknown
): Promise<{ error?: string; id?: string }> {
  const access = await requireClinic(slug);
  if (access.role !== "owner") return { error: "forbidden" };
  const parsed = defSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    if (d.id) {
      // The key is never rewritten on edit: templates already reference it, and
      // silently renaming a variable would blank it out everywhere it is used.
      const r = await c.query(
        `update patient_field_definitions
            set label = $2, label_ar = $3, field_type = $4, options = $5,
                is_required = $6, show_in_profile = $7, hidden = $8
          where id = $1 and clinic_id = $9
          returning id, key`,
        [
          d.id,
          d.label,
          d.labelAr || null,
          d.fieldType,
          JSON.stringify(d.options),
          d.isRequired,
          d.showInProfile,
          d.hidden,
          access.clinicId,
        ]
      );
      if (!r.rowCount) return { error: "not_found" };
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "patient_field.update",
        entity: "patient_field_definition",
        entityId: d.id,
        detail: { key: r.rows[0].key, label: d.label },
      });
      revalidatePath(`/c/${slug}/settings/fields`);
      return { id: d.id };
    }

    const storageKey = slugKey(d.label);
    const r = await c.query(
      `insert into patient_field_definitions
         (clinic_id, scope, key, label, label_ar, field_type, options, is_required,
          show_in_profile, hidden, storage_key, display_order)
       values ($1, 'patient', $2, $3, $4, $5, $6, $7, $8, $9, $10,
               (select coalesce(max(display_order), 0) + 10 from patient_field_definitions where clinic_id = $1))
       on conflict (clinic_id, key) do nothing
       returning id`,
      [
        access.clinicId,
        `patient.${storageKey}`,
        d.label,
        d.labelAr || null,
        d.fieldType,
        JSON.stringify(d.options),
        d.isRequired,
        d.showInProfile,
        d.hidden,
        storageKey,
      ]
    );
    if (!r.rowCount) return { error: "duplicate" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient_field.create",
      entity: "patient_field_definition",
      entityId: r.rows[0].id,
      detail: { key: `patient.${storageKey}` },
    });
    revalidatePath(`/c/${slug}/settings/fields`);
    return { id: r.rows[0].id as string };
  });
}

export async function deleteFieldDefAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (access.role !== "owner") return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const r = await c.query(
      `delete from patient_field_definitions
        where id = $1 and clinic_id = $2 and not is_system
        returning key`,
      [id, access.clinicId]
    );
    if (!r.rowCount) return { error: "cannot_delete" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient_field.delete",
      entity: "patient_field_definition",
      entityId: id,
      detail: { key: r.rows[0].key },
    });
    revalidatePath(`/c/${slug}/settings/fields`);
    return {};
  });
}

export async function moveFieldDefAction(
  slug: string,
  id: string,
  direction: "up" | "down"
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (access.role !== "owner") return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const me = (
      await c.query(
        `select id, scope, display_order from patient_field_definitions
         where id = $1 and clinic_id = $2`,
        [id, access.clinicId]
      )
    ).rows[0];
    if (!me) return { error: "not_found" };

    // Only swap within the same section — patient fields and context fields are
    // two separate lists on screen, and reordering across them means nothing.
    const neighbour = (
      await c.query(
        `select id, display_order from patient_field_definitions
         where clinic_id = $1 and scope = $2 and display_order ${direction === "up" ? "<" : ">"} $3
         order by display_order ${direction === "up" ? "desc" : "asc"}
         limit 1`,
        [access.clinicId, me.scope, me.display_order]
      )
    ).rows[0];
    if (!neighbour) return {};

    await c.query(
      `update patient_field_definitions set display_order = case id when $1 then $4::int else $3::int end
       where id in ($1, $2)`,
      [me.id, neighbour.id, me.display_order, neighbour.display_order]
    );
    revalidatePath(`/c/${slug}/settings/fields`);
    return {};
  });
}

export async function toggleFieldHiddenAction(
  slug: string,
  id: string,
  hidden: boolean
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (access.role !== "owner") return { error: "forbidden" };
  await inClinic(access, (c) =>
    c.query(`update patient_field_definitions set hidden = $3 where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
      hidden,
    ])
  );
  revalidatePath(`/c/${slug}/settings/fields`);
  return {};
}
