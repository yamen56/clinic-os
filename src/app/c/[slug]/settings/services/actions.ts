"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { z } from "zod";

const serviceSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(80),
  nameAr: z.string().max(80).optional().default(""),
  durationMin: z.coerce.number().int().min(5).max(600),
  price: z.coerce.number().min(0),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  bufferAfterMin: z.coerce.number().int().min(0).max(120).default(0),
  bookableOnline: z.boolean().default(true),
  doctorIds: z.array(z.string().uuid()).default([]),
});

export async function saveServiceAction(slug: string, data: unknown): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  const parsed = serviceSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    let serviceId = d.id;
    if (serviceId) {
      const r = await c.query(
        `update services set name = $3, name_ar = $4, duration_min = $5, price = $6, color = $7,
           buffer_after_min = $8, bookable_online = $9
         where id = $1 and clinic_id = $2`,
        [serviceId, access.clinicId, d.name, d.nameAr || null, d.durationMin, d.price, d.color, d.bufferAfterMin, d.bookableOnline]
      );
      if (!r.rowCount) return { error: "not_found" };
      await c.query(`delete from service_doctors where service_id = $1 and clinic_id = $2`, [
        serviceId,
        access.clinicId,
      ]);
    } else {
      const r = await c.query(
        `insert into services (clinic_id, name, name_ar, duration_min, price, color, buffer_after_min, bookable_online, sort)
         values ($1, $2, $3, $4, $5, $6, $7, $8,
           (select coalesce(max(sort), 0) + 1 from services where clinic_id = $1))
         returning id`,
        [access.clinicId, d.name, d.nameAr || null, d.durationMin, d.price, d.color, d.bufferAfterMin, d.bookableOnline]
      );
      serviceId = r.rows[0].id;
    }
    for (const mid of d.doctorIds) {
      await c.query(
        `insert into service_doctors (service_id, member_id, clinic_id) values ($1, $2, $3)
         on conflict do nothing`,
        [serviceId, mid, access.clinicId]
      );
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "service.update" : "service.create",
      entity: "service",
      entityId: serviceId!,
      detail: { name: d.name },
    });
    revalidatePath(`/c/${slug}/settings/services`);
    return {};
  });
}

export async function toggleServiceAction(slug: string, id: string, active: boolean) {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return;
  await inClinic(access, (c) =>
    c.query(`update services set active = $3 where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
      active,
    ])
  );
  revalidatePath(`/c/${slug}/settings/services`);
}

export async function deleteServiceAction(slug: string, id: string) {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return;
  await inClinic(access, async (c) => {
    await c.query(`delete from services where id = $1 and clinic_id = $2`, [id, access.clinicId]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "service.delete",
      entity: "service",
      entityId: id,
    });
  });
  revalidatePath(`/c/${slug}/settings/services`);
}
