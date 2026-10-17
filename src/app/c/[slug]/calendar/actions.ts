"use server";

import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { emitTrigger } from "@/lib/triggers";
import { findOrCreatePatient } from "@/lib/patients";
import { applyAppointmentStatus } from "@/lib/appointments";
import { scheduleCheck } from "@/lib/schedule-check";

export type ApptInput = {
  patientId?: string;
  newPatient?: { fullName: string; phone: string };
  doctorMemberId: string | null;
  serviceId: string | null;
  startsAt: string; // UTC ISO
  endsAt: string;
  notes: string;
  /** The patient's planned treatments this visit is for, from "Book next visit" on their plan. */
  markIds?: string[];
  /** A room, null to pick one, absent to keep the current one when it still works. See scheduleCheck. */
  roomId?: string | null;
};

export type ApptResult = {
  id?: string;
  ok?: boolean;
  error?: string;
  conflictWith?: string;
  /** The room it ended up in, when rooms apply. */
  roomName?: string;
  /** Kept the time but moved rooms — the toast says where. */
  roomChanged?: boolean;
};

export async function createAppointmentAction(slug: string, input: ApptInput): Promise<ApptResult> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    let patientId = input.patientId;
    if (!patientId && input.newPatient) {
      if (!input.newPatient.fullName.trim()) return { error: "patient_required" };
      const r = await findOrCreatePatient(c, access.clinicId, {
        phone: input.newPatient.phone,
        fullName: input.newPatient.fullName,
        source: "staff",
        createdBy: access.session.user.id,
      });
      patientId = r.id;
    }
    if (!patientId) return { error: "patient_required" };

    const check = await scheduleCheck(c, access.clinicId, {
      doctorMemberId: input.doctorMemberId,
      serviceId: input.serviceId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      roomId: input.roomId ?? null,
    });
    if (check.error) return { error: check.error, conflictWith: check.conflictWith };

    const r = await c.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, notes, source, created_by, room_id)
       values ($1, $2, $3, $4, $5, $6, $7, 'staff', $8, $9) returning id`,
      [
        access.clinicId,
        patientId,
        input.doctorMemberId,
        input.serviceId,
        input.startsAt,
        input.endsAt,
        input.notes.slice(0, 2000),
        access.session.user.id,
        check.roomId,
      ]
    );
    const id = r.rows[0].id as string;
    /*
      What the visit is for, when it was booked from the plan. Only this
      patient's own entries, still standing — an id from anywhere else is
      dropped, not trusted.
    */
    const marks = (input.markIds ?? []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20);
    if (marks.length) {
      await c.query(
        `insert into appointment_items (clinic_id, appointment_id, mark_id, patient_id, added_by)
         select $1, $2, m.id, m.patient_id, $4
           from chart_marks m
          where m.id = any($3::uuid[]) and m.clinic_id = $1 and m.patient_id = $5 and m.voided_at is null
         on conflict do nothing`,
        [access.clinicId, id, marks, access.session.user.id, patientId]
      );
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.create",
      entity: "appointment",
      entityId: id,
      detail: { patientId, startsAt: input.startsAt, roomId: check.roomId },
    });
    // Who booked it travels with the event, so the doctor's "new appointment"
    // alert is not also sent to the person who just made it.
    await emitTrigger(c, access.clinicId, "appointment_created", {
      appointmentId: id,
      patientId,
      source: "staff",
      actorUserId: access.session.user.id,
    });
    return { id, roomName: check.roomName };
  });
}

export async function updateAppointmentAction(
  slug: string,
  id: string,
  input: Partial<Pick<ApptInput, "doctorMemberId" | "serviceId" | "startsAt" | "endsAt" | "notes" | "roomId">>
): Promise<ApptResult> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    const cur = (
      await c.query(`select * from appointments where id = $1 and clinic_id = $2 for update`, [
        id,
        access.clinicId,
      ])
    ).rows[0];
    if (!cur) return { error: "not_found" };

    const startsAt = input.startsAt ?? new Date(cur.starts_at).toISOString();
    const endsAt = input.endsAt ?? new Date(cur.ends_at).toISOString();
    const doctor =
      input.doctorMemberId !== undefined ? input.doctorMemberId : cur.doctor_member_id;
    const serviceId = input.serviceId === undefined ? cur.service_id : input.serviceId ?? cur.service_id;

    const check = await scheduleCheck(c, access.clinicId, {
      doctorMemberId: doctor,
      serviceId,
      startsAt,
      endsAt,
      excludeId: id,
      roomId: input.roomId,
      currentRoomId: cur.room_id,
    });
    if (check.error) return { error: check.error, conflictWith: check.conflictWith };

    await c.query(
      `update appointments set starts_at = $3, ends_at = $4, doctor_member_id = $5,
         service_id = coalesce($6, service_id), notes = coalesce($7, notes), room_id = $8
       where id = $1 and clinic_id = $2`,
      [
        id,
        access.clinicId,
        startsAt,
        endsAt,
        doctor,
        input.serviceId === undefined ? null : input.serviceId,
        input.notes === undefined ? null : input.notes.slice(0, 2000),
        check.roomId,
      ]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.update",
      entity: "appointment",
      entityId: id,
      detail: { startsAt, endsAt, roomId: check.roomId },
    });

    /*
      Moved in time or to another doctor: the doctors involved hear about it.

      Held for a minute and keyed per appointment, because a move is rarely one
      save — dragging a block across the calendar and nudging it into place is
      several. The first save of a burst enqueues the event carrying where the
      appointment *was*; the rest find it already queued. When it runs it reads
      where the appointment is *now*, so the doctor is told once, about the
      final place, and not at all if it ended up back where it started. The
      worker frees the key as it runs, so the next move is its own event.

      A room change alone is not a reschedule: the patient comes at the same
      time to the same doctor, and rooms are never in what the patient is told.
    */
    const moved =
      new Date(cur.starts_at).getTime() !== new Date(startsAt).getTime() ||
      (cur.doctor_member_id ?? null) !== (doctor ?? null);
    if (moved) {
      await emitTrigger(
        c,
        access.clinicId,
        "appointment_rescheduled",
        {
          appointmentId: id,
          patientId: cur.patient_id,
          actorUserId: access.session.user.id,
          previousStartsAt: new Date(cur.starts_at).toISOString(),
          previousDoctorMemberId: cur.doctor_member_id ?? null,
        },
        `appointment_rescheduled:${id}`,
        60
      );
    }
    return { ok: true, roomName: check.roomName, roomChanged: check.roomChanged };
  });
}

export async function setAppointmentStatusAction(
  slug: string,
  id: string,
  status: "pending_approval" | "scheduled" | "confirmed" | "completed" | "no_show" | "cancelled"
): Promise<{ ok?: boolean; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    /*
      The status it had before is read under the same row lock, so cancelling
      an appointment that was already cancelled is not a second cancellation.
      `finished_at` follows `completed` both ways, so the board never shows a
      "finished" visit whose status says otherwise. Both live in
      applyAppointmentStatus, which an automation confirming from a patient's
      reply goes through too.
    */
    const r = await applyAppointmentStatus(c, {
      clinicId: access.clinicId,
      appointmentId: id,
      status,
      actorUserId: access.session.user.id,
    });
    if (!r.ok) return { error: "not_found" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.status",
      entity: "appointment",
      entityId: id,
      detail: { status },
    });
    return { ok: true };
  });
}
