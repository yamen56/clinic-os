"use server";

import { revalidatePath } from "next/cache";
import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";

/**
 * The waitlist: who would take an earlier appointment if one came free.
 *
 * Entries are matched against cancelled slots by worker/waitlist.ts. Nothing
 * here sends anything — adding somebody to the list is a note about what they
 * want, not a message to them.
 */

export type WaitlistInput = {
  patientId: string;
  doctorMemberId?: string | null;
  serviceId?: string | null;
  earliestDate?: string | null;
  latestDate?: string | null;
  note?: string;
};

export async function addToWaitlistAction(
  slug: string,
  data: WaitlistInput
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  if (!data.patientId) return { error: "patient_required" };

  return inClinic(access, async (c) => {
    const p = await c.query(
      `select id from patients where id = $1 and clinic_id = $2 and merged_into is null`,
      [data.patientId, access.clinicId]
    );
    if (!p.rowCount) return { error: "not_found" };

    /*
      A second live entry for the same patient and doctor is a mistake rather
      than a preference — it would double every offer they receive — so the
      unique index in 0024 refuses it and this reports it plainly instead of
      surfacing a constraint violation.
    */
    const dup = await c.query(
      `select id from waitlist_entries
        where clinic_id = $1 and patient_id = $2
          and doctor_member_id is not distinct from $3
          and status in ('waiting', 'offered')`,
      [access.clinicId, data.patientId, data.doctorMemberId ?? null]
    );
    if (dup.rowCount) return { error: "already_waiting" };

    const r = await c.query(
      `insert into waitlist_entries
         (clinic_id, patient_id, doctor_member_id, service_id, earliest_date, latest_date, note, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        access.clinicId,
        data.patientId,
        data.doctorMemberId || null,
        data.serviceId || null,
        data.earliestDate || null,
        data.latestDate || null,
        (data.note ?? "").slice(0, 300),
        access.session.user.id,
      ]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "waitlist.add",
      entity: "patient",
      entityId: data.patientId,
    });
    revalidatePath(`/c/${slug}/waitlist`);
    return { id: r.rows[0].id as string };
  });
}

export async function setWaitlistStatusAction(
  slug: string,
  id: string,
  status: "waiting" | "cancelled" | "booked"
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };

  await inClinic(access, async (c) => {
    await c.query(
      `update waitlist_entries set status = $3 where id = $1 and clinic_id = $2`,
      [id, access.clinicId, status]
    );
  });
  revalidatePath(`/c/${slug}/waitlist`);
  return {};
}
