"use server";

import { revalidatePath } from "next/cache";
import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";

/**
 * The insurance companies a clinic actually deals with.
 *
 * A short list the clinic maintains itself rather than a global directory: one
 * clinic's spelling of a company name, and the code it is told to quote on a
 * claim, are not another clinic's problem.
 */

export async function saveInsurerAction(
  slug: string,
  data: { id?: string; name: string; code?: string; notes?: string; active?: boolean }
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  const name = data.name.trim();
  if (!name) return { error: "name_required" };

  return inClinic(access, async (c) => {
    if (data.id) {
      await c.query(
        `update insurers set name = $3, code = $4, notes = $5, active = $6
          where id = $1 and clinic_id = $2`,
        [data.id, access.clinicId, name, data.code ?? "", data.notes ?? "", data.active ?? true]
      );
      revalidatePath(`/c/${slug}/settings/insurers`);
      return { id: data.id };
    }
    // Re-adding a name that already exists is almost always someone not seeing
    // it in the list, so revive the existing row rather than refusing.
    const r = await c.query(
      `insert into insurers (clinic_id, name, code, notes) values ($1, $2, $3, $4)
       on conflict (clinic_id, name) do update set active = true, code = excluded.code
       returning id`,
      [access.clinicId, name, data.code ?? "", data.notes ?? ""]
    );
    revalidatePath(`/c/${slug}/settings/insurers`);
    return { id: r.rows[0].id as string };
  });
}

export async function deleteInsurerAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };

  await inClinic(access, async (c) => {
    /*
      Deactivated, not deleted, when it is referenced. Invoices carry the insurer
      that was billed and patients carry who covers them; removing the row would
      erase the answer to "who did we claim this from" on work already done.
    */
    const used = await c.query(
      `select 1 from invoices where insurer_id = $1 and clinic_id = $2
       union all select 1 from patients where insurer_id = $1 and clinic_id = $2 limit 1`,
      [id, access.clinicId]
    );
    if (used.rowCount) {
      await c.query(`update insurers set active = false where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
      ]);
    } else {
      await c.query(`delete from insurers where id = $1 and clinic_id = $2`, [id, access.clinicId]);
    }
  });
  revalidatePath(`/c/${slug}/settings/insurers`);
  return {};
}
