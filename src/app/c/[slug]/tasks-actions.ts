"use server";

import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/uuid";

/**
 * Ticks off one of the desk's to-dos — a patient to call back, a booking to
 * approve — that an automation left (the `create_task` step).
 *
 * Those tasks were written for years with nothing reading them: a reply of
 * "2" to a reminder asked for a call back that nobody saw. The dashboard lists
 * them now, for whoever works the calendar or the inbox, and this is Done.
 */
export async function completeTaskAction(slug: string, id: string): Promise<{ ok?: true; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar") && !can(access, "conversations")) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const r = await c.query(`update tasks set done = true where id = $1 and clinic_id = $2 and not done returning title`, [id, access.clinicId]);
    if (!r.rowCount) return { error: "not_found" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "task.done",
      entity: "task",
      entityId: id,
      detail: { title: r.rows[0].title },
    });
    return { ok: true };
  });
}
