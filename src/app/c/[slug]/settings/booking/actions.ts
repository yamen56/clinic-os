"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { z } from "zod";

const linkSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(60),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  doctorMemberId: z.string().uuid().nullable().default(null),
  serviceIds: z.array(z.string().uuid()).default([]),
  minNoticeMin: z.coerce.number().int().min(0).max(10080),
  maxDaysAhead: z.coerce.number().int().min(1).max(365),
  slotGranularityMin: z.coerce.number().int().min(5).max(120),
  approvalMode: z.enum(["instant", "approval"]),
  active: z.boolean().default(true),
});

export async function saveBookingLinkAction(
  slug: string,
  data: unknown
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  const parsed = linkSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    const dup = await c.query(
      `select 1 from booking_links where slug = $1 and ($2::uuid is null or id <> $2)`,
      [d.slug, d.id ?? null]
    );
    if (dup.rowCount) return { error: "slug_taken" };

    if (d.id) {
      const r = await c.query(
        `update booking_links set name = $3, slug = $4, doctor_member_id = $5, service_ids = $6,
           min_notice_min = $7, max_days_ahead = $8, slot_granularity_min = $9, approval_mode = $10, active = $11
         where id = $1 and clinic_id = $2`,
        [d.id, access.clinicId, d.name, d.slug, d.doctorMemberId, d.serviceIds, d.minNoticeMin, d.maxDaysAhead, d.slotGranularityMin, d.approvalMode, d.active]
      );
      if (!r.rowCount) return { error: "not_found" };
    } else {
      await c.query(
        `insert into booking_links (clinic_id, name, slug, doctor_member_id, service_ids, min_notice_min, max_days_ahead, slot_granularity_min, approval_mode, active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [access.clinicId, d.name, d.slug, d.doctorMemberId, d.serviceIds, d.minNoticeMin, d.maxDaysAhead, d.slotGranularityMin, d.approvalMode, d.active]
      );
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "booking_link.save",
      entity: "booking_link",
      entityId: d.slug,
    });
    revalidatePath(`/c/${slug}/settings/booking`);
    return {};
  });
}

export async function deleteBookingLinkAction(slug: string, id: string) {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return;
  await inClinic(access, (c) =>
    c.query(`delete from booking_links where id = $1 and clinic_id = $2`, [id, access.clinicId])
  );
  revalidatePath(`/c/${slug}/settings/booking`);
}
