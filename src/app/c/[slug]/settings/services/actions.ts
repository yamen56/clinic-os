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
  /*
    Where this is held. 'in_person' is every service that existed before this
    column did, and stays the default, so a clinic that never opens this dropdown
    is unaffected.
  */
  locationKind: z.enum(["in_person", "online"]).default("in_person"),
  /* The part of the clinic this belongs to. Null is unfiled, and stays the
     default — a clinic that never creates a section is unaffected. */
  sectionId: z.string().uuid().nullable().default(null),
  doctorIds: z.array(z.string().uuid()).default([]),
});

const sectionSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(60),
  nameAr: z.string().max(60).optional().default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

/**
 * Does this section belong to the clinic doing the writing?
 *
 * Checked by hand rather than left to the foreign key, because a foreign key
 * cannot answer it: FK checks run as the table owner and bypass row-level
 * security, so a forged id from another clinic would satisfy the constraint.
 * The same reason the notes routes validate `note_categories` themselves.
 */
async function sectionBelongs(
  c: { query: (q: string, v: unknown[]) => Promise<{ rowCount: number | null }> },
  clinicId: string,
  sectionId: string | null
): Promise<boolean> {
  if (!sectionId) return true;
  const r = await c.query(`select 1 from service_sections where id = $1 and clinic_id = $2`, [
    sectionId,
    clinicId,
  ]);
  return !!r.rowCount;
}

export async function saveServiceAction(slug: string, data: unknown): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  const parsed = serviceSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    if (!(await sectionBelongs(c, access.clinicId, d.sectionId))) return { error: "invalid" };
    let serviceId = d.id;
    if (serviceId) {
      const r = await c.query(
        `update services set name = $3, name_ar = $4, duration_min = $5, price = $6, color = $7,
           buffer_after_min = $8, bookable_online = $9, location_kind = $10, section_id = $11
         where id = $1 and clinic_id = $2`,
        [serviceId, access.clinicId, d.name, d.nameAr || null, d.durationMin, d.price, d.color, d.bufferAfterMin, d.bookableOnline, d.locationKind, d.sectionId]
      );
      if (!r.rowCount) return { error: "not_found" };
      await c.query(`delete from service_doctors where service_id = $1 and clinic_id = $2`, [
        serviceId,
        access.clinicId,
      ]);
    } else {
      const r = await c.query(
        `insert into services (clinic_id, name, name_ar, duration_min, price, color, buffer_after_min, bookable_online, location_kind, section_id, sort)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           (select coalesce(max(sort), 0) + 1 from services where clinic_id = $1))
         returning id`,
        [access.clinicId, d.name, d.nameAr || null, d.durationMin, d.price, d.color, d.bufferAfterMin, d.bookableOnline, d.locationKind, d.sectionId]
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

/* -------------------------------------------------------------------------- *
 *  Sections — the clinic's own division of itself, above the services list.
 * -------------------------------------------------------------------------- */

export async function saveSectionAction(slug: string, data: unknown): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  const parsed = sectionSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const name = d.name.trim().replace(/\s+/g, " ");
  if (!name) return { error: "invalid" };

  return inClinic(access, async (c) => {
    // One spelling per clinic. Two sections called "Dentistry" are a filing
    // system nobody can use — and on the booking page they are two cards with
    // the same words on them.
    const taken = await c.query(
      `select 1 from service_sections
        where clinic_id = $1 and lower(name) = lower($2) and ($3::uuid is null or id <> $3)`,
      [access.clinicId, name, d.id ?? null]
    );
    if (taken.rowCount) return { error: "duplicate" };

    let sectionId = d.id;
    if (sectionId) {
      const r = await c.query(
        `update service_sections set name = $3, name_ar = $4, color = $5
          where id = $1 and clinic_id = $2`,
        [sectionId, access.clinicId, name, d.nameAr.trim() || null, d.color]
      );
      if (!r.rowCount) return { error: "not_found" };
    } else {
      const r = await c.query(
        `insert into service_sections (clinic_id, name, name_ar, color, sort)
         values ($1, $2, $3, $4,
           (select coalesce(max(sort), 0) + 1 from service_sections where clinic_id = $1))
         returning id`,
        [access.clinicId, name, d.nameAr.trim() || null, d.color]
      );
      sectionId = r.rows[0].id;
    }

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "service_section.update" : "service_section.create",
      entity: "service_section",
      entityId: sectionId!,
      detail: { name },
    });
    revalidatePath(`/c/${slug}/settings/services`);
    return {};
  });
}

export async function deleteSectionAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const row = (
      await c.query(`select name from service_sections where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
      ])
    ).rows[0] as { name: string } | undefined;
    if (!row) return { error: "not_found" };

    /*
      The services survive. `section_id` is `on delete set null`, so they drop
      into the unfiled group rather than leaving with the section — deleting a
      filing decision must never delete the things being filed, and every
      appointment and invoice line behind them still points at the service.
    */
    await c.query(`delete from service_sections where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
    ]);

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "service_section.delete",
      entity: "service_section",
      entityId: id,
      detail: { name: row.name },
    });
    revalidatePath(`/c/${slug}/settings/services`);
    revalidatePath(`/c/${slug}/settings/booking`);
    return {};
  });
}

export async function moveSectionAction(
  slug: string,
  id: string,
  direction: "up" | "down"
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const me = (
      await c.query(`select id, sort from service_sections where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
      ])
    ).rows[0];
    if (!me) return { error: "not_found" };

    const neighbour = (
      await c.query(
        `select id, sort from service_sections
          where clinic_id = $1 and sort ${direction === "up" ? "<" : ">"} $2
          order by sort ${direction === "up" ? "desc" : "asc"}
          limit 1`,
        [access.clinicId, me.sort]
      )
    ).rows[0];
    if (!neighbour) return {};

    await c.query(
      `update service_sections set sort = case id when $1 then $4::int else $3::int end
        where id in ($1, $2)`,
      [me.id, neighbour.id, me.sort, neighbour.sort]
    );
    revalidatePath(`/c/${slug}/settings/services`);
    return {};
  });
}
