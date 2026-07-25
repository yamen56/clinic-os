"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin, hashPassword, createSession, setSessionCookie } from "@/lib/auth";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
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
      await c.query(
        `insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'owner')`,
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
           values ($1, $2, $3, $4, $5, false, $6) returning id`,
          [clinicId, r.name, r.description, r.trigger_type, r.trigger_config, r.key]
        );
        const steps: unknown[] = Array.isArray(r.steps) ? r.steps : [];
        let sort = 0;
        for (const st of steps as { step_type: string; config?: Record<string, unknown> }[]) {
          await c.query(
            `insert into automation_steps (clinic_id, automation_id, sort, step_type, config)
             values ($1, $2, $3, $4, $5)`,
            [clinicId, a.rows[0].id, sort++, st.step_type, JSON.stringify(st.config ?? {})]
          );
        }
      }
      const kts = await c.query("select * from knowledge_templates order by sort");
      for (const k of kts.rows) {
        await c.query(
          `insert into ai_knowledge_items (clinic_id, category, title, content, sort)
           values ($1, $2, $3, $4, $5)`,
          [clinicId, k.category, k.title, k.content, k.sort]
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
