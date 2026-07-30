"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin, hashPassword, createSession, setSessionCookie } from "@/lib/auth";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import { sanitizeHtml } from "@/lib/esign/render";
import { RECIPES_ON_BY_DEFAULT } from "@/lib/esign/constants";
import { z } from "zod";

const createClinicSchema = z.object({
  name: z.string().min(2).max(80),
  nameAr: z.string().max(80).optional().default(""),
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  phone: z.string().optional().default(""),
  plan: z.string().default("standard"),
  planPrice: z.coerce.number().min(0).default(0),
  ownerName: z.string().min(2).max(80),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8),
});

export type CreateClinicResult = { error?: string; fieldErrors?: Record<string, string> } | null;

type RecipeStep = {
  step_type: string;
  config?: Record<string, unknown>;
  children?: { yes?: RecipeStep[]; no?: RecipeStep[] };
};

/** Copies a recipe's step tree (including condition branches) into a clinic. */
async function copySteps(
  c: import("pg").PoolClient,
  clinicId: string,
  automationId: string,
  steps: unknown[],
  parentId: string | null,
  branch: "yes" | "no" | null
) {
  let sort = 0;
  for (const raw of steps as RecipeStep[]) {
    const r = await c.query(
      `insert into automation_steps (clinic_id, automation_id, parent_step_id, branch, sort, step_type, config)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [clinicId, automationId, parentId, branch, sort++, raw.step_type, JSON.stringify(raw.config ?? {})]
    );
    const stepId = r.rows[0].id as string;
    if (raw.children?.yes?.length) {
      await copySteps(c, clinicId, automationId, raw.children.yes, stepId, "yes");
    }
    if (raw.children?.no?.length) {
      await copySteps(c, clinicId, automationId, raw.children.no, stepId, "no");
    }
  }
}

export async function createClinicAction(
  _prev: CreateClinicResult,
  formData: FormData
): Promise<CreateClinicResult> {
  const s = await requireSuperAdmin();
  const parsed = createClinicSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { fieldErrors };
  }
  const d = parsed.data;
  const phone = d.phone ? normalizePhone(d.phone) : null;

  let slug = "";
  try {
    slug = await withSystem(async (c) => {
      const dup = await c.query("select 1 from clinics where slug = $1", [d.slug]);
      if (dup.rowCount) throw new Error("slug_taken");

      const clinic = await c.query(
        `insert into clinics (name, name_ar, slug, phone_e164, plan, plan_price)
         values ($1, $2, $3, $4, $5, $6) returning id, slug`,
        [d.name, d.nameAr || null, d.slug, phone, d.plan, d.planPrice]
      );
      const clinicId: string = clinic.rows[0].id;

      // Owner account: reuse an existing user with this email, otherwise create one
      const existing = await c.query("select id from users where lower(email) = $1", [
        d.ownerEmail.toLowerCase(),
      ]);
      let ownerId: string;
      if (existing.rowCount) {
        ownerId = existing.rows[0].id;
      } else {
        const u = await c.query(
          `insert into users (email, password_hash, full_name) values ($1, $2, $3) returning id`,
          [d.ownerEmail, hashPassword(d.ownerPassword), d.ownerName]
        );
        ownerId = u.rows[0].id;
      }
      // The first member owns the clinic and always has full access. Their job
      // title is a guess the clinic corrects in staff settings; ownership is not.
      await c.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
         values ($1, $2, 'other', true, '{"level":"full"}')`,
        [clinicId, ownerId]
      );

      // Baseline per-clinic rows
      await c.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinicId]);
      await c.query(`insert into ai_agents (clinic_id, agent_name) values ($1, $2)`, [
        clinicId,
        d.nameAr || d.name,
      ]);
      await c.query(
        `insert into booking_links (clinic_id, slug, name) values ($1, $2, 'Default')`,
        [clinicId, d.slug]
      );

      // Copy agency defaults: automation recipes (disabled) and knowledge structure
      const recipes = await c.query(
        "select * from recipe_templates where active order by sort"
      );
      for (const r of recipes.rows) {
        const a = await c.query(
          `insert into automations (clinic_id, name, description, trigger_type, trigger_config, active, recipe_key)
           values ($1, $2, $3, $4, $5, $7, $6) returning id`,
          [
            clinicId,
            r.name_ar || r.name,
            r.description,
            r.trigger_type,
            r.trigger_config,
            r.key,
            RECIPES_ON_BY_DEFAULT.has(r.key as string),
          ]
        );
        await copySteps(c, clinicId, a.rows[0].id, Array.isArray(r.steps) ? r.steps : [], null, null);
      }
      const kts = await c.query("select * from knowledge_templates order by sort");
      for (const k of kts.rows) {
        await c.query(
          `insert into ai_knowledge_items (clinic_id, category, title, content, sort)
           values ($1, $2, $3, $4, $5)`,
          [clinicId, k.category, k.title, k.content, k.sort]
        );
      }

      // Signing: the starting field definitions and signer roles, then a copy of
      // the agency's consent-form library. Copies, not references — the clinic
      // owns its forms from the first day and can rewrite any of them.
      await c.query(`select seed_esign_defaults($1)`, [clinicId]);
      const docTemplates = await c.query(
        "select * from document_template_library where active order by sort"
      );
      for (const lt of docTemplates.rows) {
        await c.query(
          `insert into document_templates
             (clinic_id, name, name_ar, category, body, body_ar, language, signer_config,
              fields_schema, library_key, created_by)
           values ($1, $2, $3, $4, $5, $6, 'both', $7, $8, $9, $10)`,
          [
            clinicId,
            lt.name,
            lt.name_ar || null,
            lt.category,
            lt.body,
            lt.body_ar,
            /*
              Re-serialised, not passed through. pg hands jsonb back as parsed
              JavaScript, and node-pg encodes a JS *array* as a Postgres array
              literal — so `fields_schema: []` went out as `{}` and the insert
              failed with "invalid input syntax for type json", taking the whole
              clinic-creation transaction with it.
            */
            JSON.stringify(lt.signer_config ?? {}),
            JSON.stringify(lt.fields_schema ?? []),
            lt.key,
            ownerId,
          ]
        );
      }

      await audit(c, {
        clinicId,
        userId: s.user.id,
        action: "admin.clinic.create",
        entity: "clinic",
        entityId: clinicId,
        detail: { name: d.name, slug: d.slug },
      });
      return clinic.rows[0].slug as string;
    });
  } catch (e) {
    if ((e as Error).message === "slug_taken") return { fieldErrors: { slug: "taken" } };
    console.error("createClinic failed", e);
    return { error: "generic" };
  }
  revalidatePath("/admin");
  redirect(`/admin/clinics/${slug}`);
}

export async function updateSubscriptionAction(
  clinicId: string,
  data: { status?: string; plan?: string; planPrice?: number }
) {
  const s = await requireSuperAdmin();
  const status = data.status;
  if (status && !["trial", "active", "past_due", "suspended"].includes(status)) return;
  await withSystem(async (c) => {
    await c.query(
      `update clinics set
         subscription_status = coalesce($2, subscription_status),
         plan = coalesce($3, plan),
         plan_price = coalesce($4, plan_price)
       where id = $1`,
      [clinicId, status ?? null, data.plan ?? null, data.planPrice ?? null]
    );
    await audit(c, {
      clinicId,
      userId: s.user.id,
      action: "admin.subscription.update",
      entity: "clinic",
      entityId: clinicId,
      detail: data as Record<string, unknown>,
    });
  });
  revalidatePath("/admin");
}

/** Ends support mode: drops the impersonation session and issues a clean admin one. */
export async function exitImpersonationAction() {
  const s = await requireSuperAdmin();
  await withSystem(async (c) => {
    if (s.impersonatedBy) {
      await audit(c, {
        userId: s.user.id,
        impersonatedBy: s.impersonatedBy,
        action: "admin.impersonate.end",
      });
    }
    await c.query(`delete from sessions where id = $1`, [s.sessionId]);
  });
  const token = await createSession(s.user.id);
  await setSessionCookie(token);
  redirect("/admin");
}

/** Support-mode entry: a new audited session that keeps the admin identity attached. */
export async function impersonateAction(clinicSlug: string) {
  const s = await requireSuperAdmin();
  await withSystem(async (c) => {
    const r = await c.query("select id from clinics where slug = $1", [clinicSlug]);
    if (!r.rowCount) throw new Error("clinic not found");
    await audit(c, {
      clinicId: r.rows[0].id,
      userId: s.user.id,
      impersonatedBy: s.user.id,
      action: "admin.impersonate.start",
      entity: "clinic",
      entityId: r.rows[0].id,
    });
  });
  const token = await createSession(s.user.id, { impersonatedBy: s.user.id });
  await setSessionCookie(token);
  redirect(`/c/${clinicSlug}`);
}

/* ------------------------------------------------- agency document library */

const librarySchema = z.object({
  id: z.string().uuid().optional(),
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{2,58}$/),
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).default(""),
  category: z.enum(["consent", "treatment_plan", "financial", "privacy", "other"]),
  body: z.string().max(80_000).default(""),
  bodyAr: z.string().max(80_000).default(""),
  sort: z.coerce.number().int().min(0).max(9999).default(100),
  active: z.boolean().default(true),
});

/**
 * The starter form every new clinic is seeded with.
 *
 * Editing one never reaches a clinic that already holds a copy — copies are made
 * once, at clinic creation, and are the clinic's own from that moment. That is
 * the point: a clinic must be able to rewrite its consent wording without the
 * agency overwriting it later.
 */
export async function saveLibraryTemplateAction(
  input: unknown
): Promise<{ error?: string; id?: string }> {
  const s = await requireSuperAdmin();
  const parsed = librarySchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const body = sanitizeHtml(d.body);
  const bodyAr = sanitizeHtml(d.bodyAr);

  const id = await withSystem(async (c) => {
    if (d.id) {
      await c.query(
        `update document_template_library
            set name = $2, name_ar = $3, category = $4, body = $5, body_ar = $6,
                sort = $7, active = $8
          where id = $1`,
        [d.id, d.name, d.nameAr, d.category, body, bodyAr, d.sort, d.active]
      );
      return d.id;
    }
    const r = await c.query(
      `insert into document_template_library (key, name, name_ar, category, body, body_ar, sort, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (key) do nothing
       returning id`,
      [d.key, d.name, d.nameAr, d.category, body, bodyAr, d.sort, d.active]
    );
    return (r.rows[0]?.id as string) ?? null;
  });
  if (!id) return { error: "duplicate" };

  await withSystem((c) =>
    audit(c, {
      userId: s.user.id,
      action: d.id ? "admin.doc_library.update" : "admin.doc_library.create",
      entity: "document_template_library",
      entityId: id,
      detail: { key: d.key },
    })
  );
  revalidatePath("/admin/documents");
  return { id };
}

export async function deleteLibraryTemplateAction(id: string): Promise<void> {
  const s = await requireSuperAdmin();
  await withSystem(async (c) => {
    await c.query(`delete from document_template_library where id = $1`, [id]);
    await audit(c, {
      userId: s.user.id,
      action: "admin.doc_library.delete",
      entity: "document_template_library",
      entityId: id,
    });
  });
  revalidatePath("/admin/documents");
}
