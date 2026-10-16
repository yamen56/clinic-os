"use server";

import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/uuid";

/**
 * The waitlist: who would take an earlier appointment if one came free.
 *
 * Entries are matched against cancelled slots by worker/waitlist.ts. Nothing
 * here sends anything — adding somebody to the list is a note about what they
 * want, not a message to them.
 *
 * No revalidatePath: the list lives in a tab of the Appointments page, which
 * re-reads it when realtime says `waitlist_entries` changed. Revalidating would
 * re-render the whole calendar page on the server for every click.
 */

export type WaitlistInput = {
  patientId: string;
  doctorMemberId?: string | null;
  serviceId?: string | null;
  earliestDate?: string | null;
  latestDate?: string | null;
  note?: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function addToWaitlistAction(
  slug: string,
  data: WaitlistInput
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  if (!isUuid(data.patientId)) return { error: "patient_required" };
  if (data.doctorMemberId && !isUuid(data.doctorMemberId)) return { error: "bad_doctor" };
  if (data.serviceId && !isUuid(data.serviceId)) return { error: "bad_service" };
  const earliest = data.earliestDate && DAY.test(data.earliestDate) ? data.earliestDate : null;
  const latest = data.latestDate && DAY.test(data.latestDate) ? data.latestDate : null;
  if (earliest && latest && earliest > latest) return { error: "bad_window" };

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
        earliest,
        latest,
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
  if (!isUuid(id) || !["waiting", "cancelled", "booked"].includes(status)) return { error: "bad_request" };

  await inClinic(access, async (c) => {
    await c.query(
      `update waitlist_entries set status = $3 where id = $1 and clinic_id = $2`,
      [id, access.clinicId, status]
    );
  });
  return {};
}
