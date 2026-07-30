"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { sanitizeHtml } from "@/lib/esign/render";
import { TEMPLATE_CATEGORIES } from "@/lib/esign/constants";
import { deleteFile } from "@/lib/storage";

/** Templates, signer roles and the clinic's signing settings. */

const signerConfigSchema = z.object({
  mode: z.enum(["sequential", "parallel"]).default("sequential"),
  signers: z
    .array(
      z.object({
        role_key: z.string().trim().min(1).max(40),
        required: z.boolean().default(true),
        order: z.coerce.number().int().min(0).max(20).default(0),
      })
    )
    .max(10)
    .default([]),
});

const extraFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,38}$/),
  label: z.string().trim().min(1).max(120),
  label_ar: z.string().trim().max(120).default(""),
  type: z.enum(["text", "number", "date", "select", "checkbox", "longtext"]).default("text"),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  roles: z.array(z.string().trim().max(40)).max(10).default([]),
});

/**
 * A box placed on an uploaded PDF. Coordinates are page fractions, never pixels,
 * so a box placed on a phone lands in the same spot when the page is printed at
 * A4 — see components/esign/pdf-field-placer.
 */
const placedFieldSchema = z.object({
  page_number: z.coerce.number().int().min(1).max(200),
  x: z.coerce.number().min(0).max(1),
  y: z.coerce.number().min(0).max(1),
  width: z.coerce.number().min(0.005).max(1),
  height: z.coerce.number().min(0.005).max(1),
  field_type: z.enum(["signature", "initials", "date", "text", "checkbox"]),
  assigned_role_key: z.string().trim().min(1).max(40),
  is_required: z.boolean().default(true),
  label: z.string().trim().max(120).default(""),
  prefilled_value: z.string().trim().max(200).nullable().default(null),
  sort: z.coerce.number().int().min(0).max(500).default(0),
});

const templateSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).default(""),
  category: z.enum(TEMPLATE_CATEGORIES),
  language: z.enum(["ar", "en", "both"]).default("both"),
  body: z.string().max(80_000).default(""),
  bodyAr: z.string().max(80_000).default(""),
  signerConfig: signerConfigSchema,
  fieldsSchema: z.array(extraFieldSchema).max(30).default([]),
  isActive: z.boolean().default(true),
  serviceIds: z.array(z.string().uuid()).max(60).default([]),
  autoSend: z.boolean().default(true),
  source: z.enum(["template", "upload"]).default("template"),
  sourcePdfPath: z.string().max(400).nullable().default(null),
  placedFields: z.array(placedFieldSchema).max(300).default([]),
});

export async function saveTemplateAction(
  slug: string,
  input: unknown
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  // An uploaded template carries a file instead of a body.
  if (d.source === "template" && !d.body.trim() && !d.bodyAr.trim()) return { error: "bodyRequired" };
  if (!d.signerConfig.signers.length) return { error: "signerRequired" };

  // Sanitize on the way in, not just on the way out: the stored body is what a
  // later version diff and the frozen snapshot are both built from.
  const body = sanitizeHtml(d.body);
  const bodyAr = sanitizeHtml(d.bodyAr);

  return inClinic(access, async (c) => {
    let templateId = d.id;

    if (templateId) {
      /*
        Editing publishes a new version rather than overwriting one.

        Documents that were already sent do not read this row at all — they
        carry their own frozen snapshot — so the version number is for the
        record, not for correctness. Keeping the history means a completed
        document can always be traced back to the exact wording it came from.
      */
      const cur = (
        await c.query(
          `select version from document_templates where id = $1 and clinic_id = $2 for update`,
          [templateId, access.clinicId]
        )
      ).rows[0];
      if (!cur) return { error: "not_found" };
      const nextVersion = Number(cur.version) + 1;

      await c.query(
        `update document_templates
            set name = $2, name_ar = $3, category = $4, language = $5, body = $6, body_ar = $7,
                signer_config = $8, fields_schema = $9, is_active = $10, version = $11,
                source = $13, source_pdf_path = coalesce($14, source_pdf_path)
          where id = $1 and clinic_id = $12`,
        [
          templateId,
          d.name,
          d.nameAr || null,
          d.category,
          d.language,
          body,
          bodyAr,
          JSON.stringify(d.signerConfig),
          JSON.stringify(d.fieldsSchema),
          d.isActive,
          nextVersion,
          access.clinicId,
          d.source,
          d.sourcePdfPath,
        ]
      );
      await c.query(
        `insert into document_template_versions
           (clinic_id, template_id, version, name, body, body_ar, signer_config, fields_schema, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (template_id, version) do nothing`,
        [
          access.clinicId,
          templateId,
          nextVersion,
          d.name,
          body,
          bodyAr,
          JSON.stringify(d.signerConfig),
          JSON.stringify(d.fieldsSchema),
          access.session.user.id,
        ]
      );
    } else {
      const r = await c.query(
        `insert into document_templates
           (clinic_id, name, name_ar, category, language, body, body_ar, signer_config,
            fields_schema, is_active, created_by, source, source_pdf_path)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         returning id`,
        [
          access.clinicId,
          d.name,
          d.nameAr || null,
          d.category,
          d.language,
          body,
          bodyAr,
          JSON.stringify(d.signerConfig),
          JSON.stringify(d.fieldsSchema),
          d.isActive,
          access.session.user.id,
          d.source,
          d.sourcePdfPath,
        ]
      );
      templateId = r.rows[0].id as string;
      await c.query(
        `insert into document_template_versions
           (clinic_id, template_id, version, name, body, body_ar, signer_config, fields_schema, created_by)
         values ($1, $2, 1, $3, $4, $5, $6, $7, $8)`,
        [
          access.clinicId,
          templateId,
          d.name,
          body,
          bodyAr,
          JSON.stringify(d.signerConfig),
          JSON.stringify(d.fieldsSchema),
          access.session.user.id,
        ]
      );
    }

    /*
      Placed boxes are replaced wholesale rather than diffed. They are only ever
      edited as a set, and documents in flight already hold their own copy —
      `createDocument` clones them at creation precisely so that re-placing a box
      here never moves it on something a patient is about to sign.
    */
    if (d.source === "upload") {
      await c.query(`delete from document_fields where template_id = $1 and clinic_id = $2`, [
        templateId,
        access.clinicId,
      ]);
      let sort = 0;
      for (const f of d.placedFields) {
        await c.query(
          `insert into document_fields
             (clinic_id, template_id, page_number, x, y, width, height, field_type,
              assigned_role_key, is_required, label, prefilled_value, sort)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            access.clinicId,
            templateId,
            f.page_number,
            f.x,
            f.y,
            f.width,
            f.height,
            f.field_type,
            f.assigned_role_key,
            f.is_required,
            f.label,
            f.prefilled_value,
            sort++,
          ]
        );
      }
    }

    await c.query(`delete from service_documents where template_id = $1 and clinic_id = $2`, [
      templateId,
      access.clinicId,
    ]);
    for (const serviceId of d.serviceIds) {
      await c.query(
        `insert into service_documents (clinic_id, service_id, template_id, auto_send)
         values ($1, $2, $3, $4) on conflict do nothing`,
        [access.clinicId, serviceId, templateId, d.autoSend]
      );
    }

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "document_template.update" : "document_template.create",
      entity: "document_template",
      entityId: templateId!,
      detail: { name: d.name },
    });
    revalidatePath(`/c/${slug}/settings/documents`);
    return { id: templateId };
  });
}

export async function deleteTemplateAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.clinic")) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    const r = await c.query(
      `delete from document_templates where id = $1 and clinic_id = $2 returning source_pdf_path`,
      [id, access.clinicId]
    );
    if (!r.rowCount) return { error: "not_found" };
    if (r.rows[0].source_pdf_path) await deleteFile(r.rows[0].source_pdf_path);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "document_template.delete",
      entity: "document_template",
      entityId: id,
    });
    revalidatePath(`/c/${slug}/settings/documents`);
    return {};
  });
}

/** Copies an agency library form into this clinic, where it becomes editable. */
export async function copyLibraryTemplateAction(
  slug: string,
  libraryKey: string
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const lt = (
      await c.query(`select * from document_template_library where key = $1 and active`, [libraryKey])
    ).rows[0];
    if (!lt) return { error: "not_found" };

    const r = await c.query(
      `insert into document_templates
         (clinic_id, name, name_ar, category, language, body, body_ar, signer_config,
          fields_schema, library_key, created_by)
       values ($1, $2, $3, $4, 'both', $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        access.clinicId,
        lt.name,
        lt.name_ar || null,
        lt.category,
        lt.body,
        lt.body_ar,
        JSON.stringify(lt.signer_config ?? {}),
        JSON.stringify(lt.fields_schema ?? []),
        lt.key,
        access.session.user.id,
      ]
    );
    const id = r.rows[0].id as string;
    await c.query(
      `insert into document_template_versions
         (clinic_id, template_id, version, name, body, body_ar, signer_config, fields_schema, created_by)
       values ($1, $2, 1, $3, $4, $5, $6, $7, $8)`,
      [
        access.clinicId,
        id,
        lt.name,
        lt.body,
        lt.body_ar,
        JSON.stringify(lt.signer_config ?? {}),
        JSON.stringify(lt.fields_schema ?? []),
        access.session.user.id,
      ]
    );
    revalidatePath(`/c/${slug}/settings/documents`);
    return { id };
  });
}

// ------------------------------------------------------------- signer roles

const roleSchema = z.object({
  id: z.string().uuid().optional(),
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,38}$/),
  label: z.string().trim().min(1).max(60),
  labelAr: z.string().trim().max(60).default(""),
  isStaff: z.boolean().default(false),
});

export async function saveSignerRoleAction(
  slug: string,
  input: unknown
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.clinic")) return { error: "forbidden" };
  const parsed = roleSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    if (d.id) {
      // The key stays put: templates and existing signer rows reference it.
      const r = await c.query(
        `update signer_roles set label = $2, label_ar = $3, is_staff = $4
          where id = $1 and clinic_id = $5`,
        [d.id, d.label, d.labelAr || null, d.isStaff, access.clinicId]
      );
      if (!r.rowCount) return { error: "not_found" };
    } else {
      const r = await c.query(
        `insert into signer_roles (clinic_id, key, label, label_ar, is_staff, display_order)
         values ($1, $2, $3, $4, $5,
                 (select coalesce(max(display_order), 0) + 10 from signer_roles where clinic_id = $1))
         on conflict (clinic_id, key) do nothing
         returning id`,
        [access.clinicId, d.key, d.label, d.labelAr || null, d.isStaff]
      );
      if (!r.rowCount) return { error: "duplicate" };
    }
    revalidatePath(`/c/${slug}/settings/documents`);
    return {};
  });
}

export async function deleteSignerRoleAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.clinic")) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    const r = await c.query(
      `delete from signer_roles where id = $1 and clinic_id = $2 and not is_system`,
      [id, access.clinicId]
    );
    if (!r.rowCount) return { error: "cannot_delete" };
    revalidatePath(`/c/${slug}/settings/documents`);
    return {};
  });
}

// -------------------------------------------------------- signing settings

const settingsSchema = z.object({
  linkDays: z.coerce.number().int().min(1).max(90),
  requireCode: z.boolean(),
  reminderHours: z.coerce.number().int().min(1).max(336),
});

export async function saveEsignSettingsAction(
  slug: string,
  input: unknown
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.clinic")) return { error: "forbidden" };
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  await inClinic(access, async (c) => {
    await c.query(
      `update clinics set esign_link_days = $2, esign_require_code = $3, esign_reminder_hours = $4
       where id = $1`,
      [access.clinicId, d.linkDays, d.requireCode, d.reminderHours]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "clinic.esign_settings",
      entity: "clinic",
      entityId: access.clinicId,
      detail: { ...d },
    });
  });
  revalidatePath(`/c/${slug}/settings/documents`);
  return {};
}
