"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { FACE_TREATMENT_BY_KEY } from "@/lib/charts/face/catalog";
import { loadPlans, type PackagePlan } from "@/lib/charts/face/packages";

const schema = z.object({
  id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(80),
  nameAr: z.string().trim().max(80).default(""),
  price: z.number().min(0).max(1_000_000),
  validMonths: z.number().int().min(1).max(60).nullable().default(null),
  active: z.boolean().default(true),
  items: z
    .array(z.object({ treatmentKey: z.string().max(64), sessions: z.number().int().min(1).max(100) }))
    .min(1)
    .max(10),
});

/**
 * A package the clinic sells: its name in both languages, its price, how long
 * it is good for, and what it holds — one treatment for so many sessions, or
 * a bundle of several. Saving a plan never touches a package already sold:
 * those were written down as they were when sold.
 */
export async function savePlanAction(slug: string, data: unknown): Promise<{ plans?: PackagePlan[]; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  if (!access.clinic.features.aesthetic) return { error: "forbidden" };
  const parsed = schema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  if (!d.items.every((i) => FACE_TREATMENT_BY_KEY.has(i.treatmentKey))) return { error: "invalid" };

  return inClinic(access, async (c) => {
    let id = d.id;
    if (id) {
      const u = await c.query(`update package_plans set name = $3, name_ar = $4, price = $5, valid_months = $6, active = $7 where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
        d.name,
        d.nameAr,
        d.price,
        d.validMonths,
        d.active,
      ]);
      if (!u.rowCount) return { error: "not_found" };
      await c.query(`delete from package_plan_items where plan_id = $1`, [id]);
    } else {
      id = (
        await c.query(
          `insert into package_plans (clinic_id, name, name_ar, price, valid_months, active, created_by, sort)
           values ($1, $2, $3, $4, $5, $6, $7, (select coalesce(max(sort), 0) + 1 from package_plans where clinic_id = $1)) returning id`,
          [access.clinicId, d.name, d.nameAr, d.price, d.validMonths, d.active, access.session.user.id]
        )
      ).rows[0].id as string;
    }
    for (const [i, it] of d.items.entries()) {
      await c.query(`insert into package_plan_items (clinic_id, plan_id, treatment_key, sessions, sort) values ($1, $2, $3, $4, $5)`, [
        access.clinicId,
        id,
        it.treatmentKey,
        it.sessions,
        i,
      ]);
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "face.plan.update" : "face.plan.create",
      entity: "package_plan",
      entityId: id!,
      detail: { name: d.name, price: d.price, items: d.items },
    });
    revalidatePath(`/c/${slug}/settings/face-packages`);
    return { plans: await loadPlans(c, access.clinicId, false) };
  });
}
