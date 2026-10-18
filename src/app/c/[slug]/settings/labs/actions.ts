"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { resolveTreatment } from "@/lib/charts/dental/db";
import { PRICE_BY } from "@/lib/charts/dental/pricing";
import { toLab, type LabRow, type LabPrice } from "@/lib/charts/dental/labs";

/*
  The clinic's dental labs, and what each charges.

  Settings → Dental labs, beside Treatment prices and behind the same
  capability: what the work costs the clinic is part of pricing it. A lab is
  archived, never deleted, while work it did is on record (lab_cases.lab_id
  restricts it).
*/

const labSchema = z.object({
  id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(40).default(""),
  inHouse: z.boolean().default(false),
  note: z.string().trim().max(500).default(""),
});

export async function saveLabAction(slug: string, data: unknown): Promise<{ lab?: LabRow; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  if (!access.clinic.features.dental) return { error: "forbidden" };
  const parsed = labSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  return inClinic(access, async (c) => {
    const r = d.id
      ? await c.query(
          `update dental_labs set name = $3, phone = $4, in_house = $5, note = $6, active = true
            where id = $1 and clinic_id = $2 returning *`,
          [d.id, access.clinicId, d.name, d.phone, d.inHouse, d.note]
        )
      : await c.query(
          `insert into dental_labs (clinic_id, name, phone, in_house, note, created_by, sort)
           values ($1, $2, $3, $4, $5, $6, (select coalesce(max(sort), 0) + 1 from dental_labs where clinic_id = $1))
           returning *`,
          [access.clinicId, d.name, d.phone, d.inHouse, d.note, access.session.user.id]
        );
    if (!r.rows[0]) return { error: "not_found" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "dental_lab.update" : "dental_lab.create",
      entity: "dental_lab",
      entityId: r.rows[0].id,
      detail: { name: d.name, inHouse: d.inHouse },
    });
    revalidatePath(`/c/${slug}/settings/labs`);
    return { lab: toLab(r.rows[0]) };
  });
}

/** Off the pickers, its work and its prices kept. Saving it again brings it back. */
export async function archiveLabAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  if (!access.clinic.features.dental) return { error: "forbidden" };
  if (!z.string().uuid().safeParse(id).success) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const r = await c.query(`update dental_labs set active = false where id = $1 and clinic_id = $2 returning name`, [id, access.clinicId]);
    if (!r.rowCount) return { error: "not_found" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "dental_lab.archive",
      entity: "dental_lab",
      entityId: id,
      detail: { name: r.rows[0].name },
    });
    revalidatePath(`/c/${slug}/settings/labs`);
    return {};
  });
}

const labPriceSchema = z.object({
  labId: z.string().uuid(),
  key: z.string().min(1).max(64),
  variant: z.string().max(24).nullable(),
  /** Null clears it: the work then starts at the lab's price for the treatment, or at nothing. */
  cost: z.number().min(0).max(1_000_000).nullable(),
});

/** What one lab charges for a treatment, or one kind of it. */
export async function saveLabPriceAction(slug: string, data: unknown): Promise<{ price?: LabPrice | null; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  if (!access.clinic.features.dental) return { error: "forbidden" };
  const parsed = labPriceSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  return inClinic(access, async (c) => {
    const lab = await c.query(`select 1 from dental_labs where id = $1 and clinic_id = $2`, [d.labId, access.clinicId]);
    if (!lab.rowCount) return { error: "not_found" };
    const tr = await resolveTreatment(c, access.clinicId, d.key);
    if (!tr || tr.kind !== "procedure") return { error: "invalid" };
    if (d.variant) {
      const field = PRICE_BY[tr.key] ? tr.details?.find((f) => f.key === PRICE_BY[tr.key]) : undefined;
      if (!field?.options.some((o) => o.key === d.variant)) return { error: "invalid" };
    }
    let price: LabPrice | null = null;
    if (d.cost === null) {
      await c.query(
        `delete from dental_lab_prices where lab_id = $1 and clinic_id = $2 and chart_key = $3 and coalesce(chart_variant, '') = coalesce($4, '')`,
        [d.labId, access.clinicId, d.key, d.variant]
      );
    } else {
      const r = await c.query(
        `insert into dental_lab_prices (clinic_id, lab_id, chart_key, chart_variant, cost) values ($1, $2, $3, $4, $5)
         on conflict (lab_id, chart_key, coalesce(chart_variant, '')) do update set cost = excluded.cost
         returning lab_id, chart_key, chart_variant, cost`,
        [access.clinicId, d.labId, d.key, d.variant, d.cost]
      );
      const x = r.rows[0];
      price = { labId: x.lab_id, chartKey: x.chart_key, variant: x.chart_variant ?? null, cost: Number(x.cost) };
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "dental_lab.price",
      entity: "dental_lab",
      entityId: d.labId,
      detail: { key: d.key, variant: d.variant, cost: d.cost },
    });
    revalidatePath(`/c/${slug}/settings/labs`);
    return { price };
  });
}
