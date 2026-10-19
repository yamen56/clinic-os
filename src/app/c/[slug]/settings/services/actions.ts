"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { z } from "zod";
import { resolveTreatment } from "@/lib/charts/dental/db";
import { PRICE_BY, pickPrice, variantOf, withVariant, type PriceRow } from "@/lib/charts/dental/pricing";
import { loadPrices } from "@/lib/charts/dental/billing-server";

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
  /*
    The code an insurer knows this service by — a CPT code, or the line in the
    doctors' syndicate fee schedule. Free text until Hakeem Claim says which set
    it wants; blank is the default and changes nothing.
  */
  feeCode: z.string().trim().max(30).optional().default(""),
});

const sectionSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(60),
  nameAr: z.string().max(60).optional().default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /*
    Hidden rather than deleted. Deleting a section drops its services into the
    unfiled group, which is right for one the clinic has genuinely stopped
    running; hiding is for the one it wants off the pickers for a month with its
    filing intact. The column shipped with 0047 and nothing read or wrote it
    until now, which made it a switch that looked like it worked.
  */
  active: z.boolean().optional().default(true),
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
  if (!can(access, "settings.services")) return { error: "forbidden" };
  const parsed = serviceSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    if (!(await sectionBelongs(c, access.clinicId, d.sectionId))) return { error: "invalid" };
    let serviceId = d.id;
    if (serviceId) {
      const r = await c.query(
        `update services set name = $3, name_ar = $4, duration_min = $5, price = $6, color = $7,
           buffer_after_min = $8, bookable_online = $9, location_kind = $10, section_id = $11,
           fee_code = $12
         where id = $1 and clinic_id = $2`,
        [serviceId, access.clinicId, d.name, d.nameAr || null, d.durationMin, d.price, d.color, d.bufferAfterMin, d.bookableOnline, d.locationKind, d.sectionId, d.feeCode || null]
      );
      if (!r.rowCount) return { error: "not_found" };
      await c.query(`delete from service_doctors where service_id = $1 and clinic_id = $2`, [
        serviceId,
        access.clinicId,
      ]);
    } else {
      const r = await c.query(
        `insert into services (clinic_id, name, name_ar, duration_min, price, color, buffer_after_min, bookable_online, location_kind, section_id, fee_code, sort)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           (select coalesce(max(sort), 0) + 1 from services where clinic_id = $1))
         returning id`,
        [access.clinicId, d.name, d.nameAr || null, d.durationMin, d.price, d.color, d.bufferAfterMin, d.bookableOnline, d.locationKind, d.sectionId, d.feeCode || null]
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
  if (!can(access, "settings.services")) return;
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
  if (!can(access, "settings.services")) return;
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
  if (!can(access, "settings.services")) return { error: "forbidden" };
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
        `update service_sections set name = $3, name_ar = $4, color = $5, active = $6
          where id = $1 and clinic_id = $2`,
        [sectionId, access.clinicId, name, d.nameAr.trim() || null, d.color, d.active]
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
  if (!can(access, "settings.services")) return { error: "forbidden" };

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
  if (!can(access, "settings.services")) return { error: "forbidden" };

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

const dentalPriceSchema = z.object({
  key: z.string().min(1).max(64),
  variant: z.string().max(24).nullable(),
  price: z.number().min(0).max(1_000_000).nullable(),
  /** Price it as one of the clinic's own services instead of making a new one. */
  linkServiceId: z.string().uuid().nullable().default(null),
});

/**
 * A dental treatment's price, as a service: what the whole treatment costs,
 * however many visits it takes. (The per-visit prices of 0076 were retired by
 * 0080; `price_unit` stays 'item' for every price written here.)
 *
 * Typing a price makes the treatment's service — named from the catalog, in
 * both languages, not offered on the booking page — or updates it. Linking
 * one of the clinic's own services makes that service the price instead, so
 * a cleaning the clinic already sells is not priced twice. Clearing the box
 * lets the price go: a service the price list made is retired with it (its
 * past invoices keep it); one the clinic had before is only let go, and is
 * free to be linked again.
 */
export async function saveDentalPriceAction(
  slug: string,
  data: unknown
): Promise<{ row?: PriceRow | null; released?: { id: string; name: string; name_ar: string | null; price: string }; priced?: number; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  if (!access.clinic.features.dental) return { error: "forbidden" };
  const parsed = dentalPriceSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    const tr = await resolveTreatment(c, access.clinicId, d.key);
    if (!tr || tr.kind !== "procedure") return { error: "invalid" };
    const field = PRICE_BY[tr.key] ? tr.details?.find((f) => f.key === PRICE_BY[tr.key]) : undefined;
    const option = d.variant ? field?.options.find((o) => o.key === d.variant) : undefined;
    if (d.variant && !option) return { error: "invalid" };

    const cur = (
      await c.query(
        `select id, chart_owned, name, name_ar, price from services
          where clinic_id = $1 and chart_key = $2 and coalesce(chart_variant, '') = coalesce($3, '') and price_unit = 'item'`,
        [access.clinicId, d.key, d.variant]
      )
    ).rows[0];
    const release = async () => {
      if (!cur) return undefined;
      if (cur.chart_owned) {
        await c.query(`update services set active = false, chart_key = null, chart_variant = null where id = $1`, [cur.id]);
        return undefined;
      }
      await c.query(`update services set chart_key = null, chart_variant = null where id = $1`, [cur.id]);
      return { id: cur.id as string, name: cur.name as string, name_ar: (cur.name_ar as string) ?? null, price: String(cur.price) };
    };

    let row: PriceRow | null = null;
    let released: Awaited<ReturnType<typeof release>>;
    if (d.linkServiceId) {
      const s = (await c.query(`select id, price, name, name_ar from services where id = $1 and clinic_id = $2 and chart_key is null`, [d.linkServiceId, access.clinicId])).rows[0];
      if (!s) return { error: "invalid" };
      released = await release();
      await c.query(`update services set chart_key = $2, chart_variant = $3, price_unit = 'item', chart_owned = false, active = true where id = $1`, [
        s.id,
        d.key,
        d.variant,
      ]);
      row = { serviceId: s.id, chartKey: d.key, variant: d.variant, price: Number(s.price), name: s.name, nameAr: s.name_ar ?? null };
    } else if (d.price === null) {
      released = await release();
    } else if (cur) {
      await c.query(`update services set price = $2, active = true where id = $1`, [cur.id, d.price]);
      row = { serviceId: cur.id, chartKey: d.key, variant: d.variant, price: d.price, name: cur.name, nameAr: cur.name_ar ?? null };
    } else {
      // Filed with the clinic's dental section when it keeps one; otherwise unfiled, like any new service.
      const section =
        (
          await c.query(
            `select id from service_sections
              where clinic_id = $1 and active and (name ilike '%dent%' or coalesce(name_ar, '') like '%أسنان%')
              order by sort limit 1`,
            [access.clinicId]
          )
        ).rows[0]?.id ?? null;
      const names = {
        en: withVariant(tr.en, option?.en ?? null).slice(0, 80),
        ar: withVariant(tr.ar, option?.ar ?? null).slice(0, 80),
      };
      const ins = await c.query(
        `insert into services (clinic_id, name, name_ar, duration_min, price, bookable_online, section_id,
                               chart_key, chart_variant, price_unit, chart_owned, sort)
         values ($1, $2, $3, 30, $4, false, $5, $6, $7, 'item', true,
                 (select coalesce(max(sort), 0) + 1 from services where clinic_id = $1))
         returning id`,
        [
          access.clinicId,
          names.en,
          names.ar,
          d.price,
          section,
          d.key,
          d.variant,
        ]
      );
      row = { serviceId: ins.rows[0].id, chartKey: d.key, variant: d.variant, price: d.price, name: names.en, nameAr: names.ar };
    }
    /*
      The treatments already charted with no price take one now: priced once,
      the ones waiting are priced too — each the way a new one would be (its
      own kind's price before the treatment's). Only what is still the clinic's
      to bill — planned, or done
      since billing from the chart began, on no invoice, its price never set
      by hand — and never a part of a full arch, which is priced as the whole.
    */
    let priced = 0;
    if (row) {
      const list = await loadPrices(c, access.clinicId, d.key);
      const waiting = (
        await c.query(
          `select m.id, m.detail from chart_marks m join clinics cl on cl.id = m.clinic_id
            where m.clinic_id = $1 and m.treatment_key = $2
              and m.fee is null and not m.fee_manual and m.voided_at is null
              and m.kind = 'procedure' and m.status <> 'existing'
              and (m.status = 'planned' or m.done_at >= cl.dental_billing_since)
              and not (m.group_id is not null and m.site ~ '^[1-8][1-8]$'
                       and exists (select 1 from chart_marks p where p.group_id = m.group_id and p.site !~ '^[1-8][1-8]$'))
              and not exists (select 1 from invoice_item_marks iim where iim.mark_id = m.id)`,
          [access.clinicId, d.key]
        )
      ).rows as { id: string; detail: Record<string, string> | null }[];
      const byPrice = new Map<string, { price: number; ids: string[] }>();
      for (const m of waiting) {
        const p = pickPrice(list, d.key, variantOf(d.key, m.detail ?? {}));
        if (!p) continue;
        const g = byPrice.get(p.serviceId) ?? { price: p.price, ids: [] };
        g.ids.push(m.id);
        byPrice.set(p.serviceId, g);
      }
      for (const [serviceId, g] of byPrice) {
        await c.query(
          `with upd as (
             update chart_marks set fee = $1, service_id = $2 where id = any($3::uuid[]) and clinic_id = $4 returning id, clinic_id
           )
           insert into chart_mark_events (clinic_id, mark_id, action, by_user, reason)
           select clinic_id, id, 'fee', $5, $6 from upd`,
          [g.price, serviceId, g.ids, access.clinicId, access.session.user.id, String(g.price)]
        );
        priced += g.ids.length;
      }
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "service.dental_price",
      entity: "service",
      entityId: row?.serviceId ?? cur?.id ?? "",
      detail: { key: d.key, variant: d.variant, price: d.price, linked: !!d.linkServiceId, priced },
    });
    revalidatePath(`/c/${slug}/settings/prices`);
    return { row, released, priced };
  });
}

const renameSchema = z
  .array(
    z.object({
      serviceId: z.string().uuid(),
      name: z.string().trim().min(1).max(80),
      nameAr: z.string().trim().max(80),
    })
  )
  .min(1)
  .max(12);

/**
 * The names a treatment's prices go by on the invoice — what the patient
 * reads — in each language. Only the price list's own services: the rest are
 * renamed in Services, where they are made.
 */
export async function renameDentalPricesAction(
  slug: string,
  data: unknown
): Promise<{ rows?: { serviceId: string; name: string; nameAr: string | null }[]; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings.services")) return { error: "forbidden" };
  if (!access.clinic.features.dental) return { error: "forbidden" };
  const parsed = renameSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };

  return inClinic(access, async (c) => {
    const rows: { serviceId: string; name: string; nameAr: string | null }[] = [];
    for (const r of parsed.data) {
      const u = await c.query(
        `update services set name = $3, name_ar = $4
          where id = $1 and clinic_id = $2 and chart_key is not null
          returning id, name, name_ar`,
        [r.serviceId, access.clinicId, r.name, r.nameAr || null]
      );
      if (u.rows[0]) rows.push({ serviceId: u.rows[0].id, name: u.rows[0].name, nameAr: u.rows[0].name_ar ?? null });
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "service.dental_names",
      entity: "service",
      entityId: rows[0]?.serviceId ?? "",
      detail: { count: rows.length },
    });
    revalidatePath(`/c/${slug}/settings/prices`);
    return { rows };
  });
}
