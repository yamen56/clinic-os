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
  data: {
    id?: string;
    name: string;
    code?: string;
    notes?: string;
    active?: boolean;
    /** The share of a bill this company pays; null for no standing rule. */
    coveragePercent?: number | null;
    /** The most it pays on one invoice; null for no ceiling. */
    coverageCap?: number | null;
  }
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "insurance.companies")) return { error: "forbidden" };
  const name = data.name.trim();
  if (!name) return { error: "name_required" };
  const pct = data.coveragePercent ?? null;
  const cap = data.coverageCap ?? null;
  if (pct !== null && !(Number.isFinite(pct) && pct >= 0 && pct <= 100)) return { error: "invalid_coverage" };
  if (cap !== null && !(Number.isFinite(cap) && cap >= 0)) return { error: "invalid_coverage" };

  return inClinic(access, async (c) => {
    if (data.id) {
      /*
        Notes are only written when sent: the edit form has no notes field, and
        the old `notes = ''` default quietly wiped them on every rename.
      */
      await c.query(
        `update insurers set name = $3, code = $4, notes = coalesce($5, notes), active = $6,
                             coverage_percent = $7, coverage_cap = $8
          where id = $1 and clinic_id = $2`,
        [data.id, access.clinicId, name, data.code ?? "", data.notes ?? null, data.active ?? true, pct, cap]
      );
      revalidatePath(`/c/${slug}/settings/insurers`);
      return { id: data.id };
    }
    // Re-adding a name that already exists is almost always someone not seeing
    // it in the list, so revive the existing row rather than refusing.
    const r = await c.query(
      `insert into insurers (clinic_id, name, code, notes, coverage_percent, coverage_cap)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (clinic_id, name) do update set active = true, code = excluded.code,
         coverage_percent = excluded.coverage_percent, coverage_cap = excluded.coverage_cap
       returning id`,
      [access.clinicId, name, data.code ?? "", data.notes ?? "", pct, cap]
    );
    revalidatePath(`/c/${slug}/settings/insurers`);
    return { id: r.rows[0].id as string };
  });
}

export async function deleteInsurerAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "insurance.companies")) return { error: "forbidden" };

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
