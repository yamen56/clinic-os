"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";

/**
 * The clinic's tag vocabulary.
 *
 * Every write here keeps two things in step: this catalogue, and the
 * `patients.tags` array that actually carries the assignments. Renaming a tag
 * that is on forty patients has to reach all forty, or the filter stops
 * matching and the rename looks like data loss.
 */

const clean = (s: string) => s.trim().replace(/\s+/g, " ").slice(0, 40);

export async function createTagAction(
  slug: string,
  name: string,
  color: string
): Promise<{ error?: string; id?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  const n = clean(name);
  if (!n) return { error: "invalid" };
  const c6 = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#0b1220";

  return inClinic(access, async (c) => {
    const r = await c.query(
      `insert into clinic_tags (clinic_id, name, color) values ($1, $2, $3)
       on conflict (clinic_id, name) do nothing
       returning id`,
      [access.clinicId, n, c6]
    );
    if (!r.rowCount) return { error: "duplicate" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "tag.create",
      entity: "clinic_tag",
      entityId: r.rows[0].id,
      detail: { name: n },
    });
    revalidatePath(`/c/${slug}/settings/tags`);
    return { id: r.rows[0].id as string };
  });
}

export async function updateTagAction(
  slug: string,
  id: string,
  patch: { name?: string; color?: string }
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const before = (
      await c.query(`select name from clinic_tags where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
      ])
    ).rows[0] as { name: string } | undefined;
    if (!before) return { error: "not_found" };

    const name = patch.name === undefined ? before.name : clean(patch.name);
    if (!name) return { error: "invalid" };
    const color =
      patch.color && /^#[0-9a-fA-F]{6}$/.test(patch.color) ? patch.color : undefined;

    if (name !== before.name) {
      const taken = await c.query(
        `select 1 from clinic_tags where clinic_id = $1 and name = $2 and id <> $3`,
        [access.clinicId, name, id]
      );
      if (taken.rowCount) return { error: "duplicate" };
    }

    await c.query(
      `update clinic_tags set name = $3, color = coalesce($4, color), updated_at = now()
        where id = $1 and clinic_id = $2`,
      [id, access.clinicId, name, color ?? null]
    );

    /*
      Carry the rename onto the patients holding it. Without this the catalogue
      would say one thing and forty patient files another, and the filter — which
      matches on the array, not on this table — would stop finding them.
    */
    if (name !== before.name) {
      await c.query(
        `update patients
            set tags = array_replace(tags, $2, $3)
          where clinic_id = $1 and $2 = any(tags)`,
        [access.clinicId, before.name, name]
      );
    }

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "tag.update",
      entity: "clinic_tag",
      entityId: id,
      detail: { from: before.name, to: name },
    });
    revalidatePath(`/c/${slug}/settings/tags`);
    revalidatePath(`/c/${slug}/patients`);
    return {};
  });
}

export async function deleteTagAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const row = (
      await c.query(`select name from clinic_tags where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
      ])
    ).rows[0] as { name: string } | undefined;
    if (!row) return { error: "not_found" };

    // Off the patients first: a tag removed from the catalogue but left on
    // forty files is a label nobody can find, rename or clear.
    await c.query(
      `update patients set tags = array_remove(tags, $2) where clinic_id = $1 and $2 = any(tags)`,
      [access.clinicId, row.name]
    );
    await c.query(`delete from clinic_tags where id = $1 and clinic_id = $2`, [id, access.clinicId]);

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "tag.delete",
      entity: "clinic_tag",
      entityId: id,
      detail: { name: row.name },
    });
    revalidatePath(`/c/${slug}/settings/tags`);
    revalidatePath(`/c/${slug}/patients`);
    return {};
  });
}
