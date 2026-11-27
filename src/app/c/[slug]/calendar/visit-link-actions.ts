"use server";

import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/uuid";
import { sendVisitLink } from "@/lib/patient-visit";
import { visitUrl } from "@/lib/visit-link";
import { patientChangesSql } from "@/lib/features";

/**
 * Reception hands the patient their own link to change or cancel the visit
 * (0115) — so the next change is the patient's to make, not the desk's.
 */
export async function sendVisitLinkAction(
  slug: string,
  appointmentId: string
): Promise<{ ok?: boolean; error?: "forbidden" | "not_found" | "off" | "closed" | "no_phone" | "wa_offline" }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  if (!isUuid(appointmentId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    // This clinic's visit, read through the member's own row-level view first.
    const own = await c.query(`select 1 from appointments where id = $1 and clinic_id = $2`, [appointmentId, access.clinicId]);
    if (!own.rowCount) return { error: "not_found" as const };
    const r = await sendVisitLink(c, appointmentId, { senderUserId: access.session.user.id });
    if ("error" in r) return { error: r.error };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.send_visit_link",
      entity: "appointment",
      entityId: appointmentId,
    });
    return { ok: true };
  });
}

/** The same link, to copy into a message of reception's own. */
export async function visitLinkAction(
  slug: string,
  appointmentId: string
): Promise<{ url?: string; error?: "forbidden" | "not_found" | "off" }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  if (!isUuid(appointmentId)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    const r = (
      await c.query(
        `select a.id, a.patient_id, ${patientChangesSql()} as patient_changes from appointments a join clinics cl on cl.id = a.clinic_id
          where a.id = $1 and a.clinic_id = $2`,
        [appointmentId, access.clinicId]
      )
    ).rows[0];
    if (!r) return { error: "not_found" as const };
    if (r.patient_changes === "off") return { error: "off" as const };
    return { url: visitUrl(r.id, r.patient_id) };
  });
}
