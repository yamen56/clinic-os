"use server";

import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { emitTrigger } from "@/lib/triggers";
import { findOrCreatePatient } from "@/lib/patients";
import { applyAppointmentStatus } from "@/lib/appointments";
import { tellPatientBookingApproved } from "@/lib/booking-approved";
import { scheduleCheck } from "@/lib/schedule-check";
import { cleanServiceIds, setExtraServices } from "@/lib/appointment-services";
import { revalidatePath } from "next/cache";
import { isUuid } from "@/lib/uuid";
import { appointmentAttachedSql } from "@/lib/appointment-history";

export type ApptInput = {
  patientId?: string;
  newPatient?: { fullName: string; phone: string };
  doctorMemberId: string | null;
  serviceId: string | null;
  /**
   * Every service the visit is for, first one first (migration 0106). When
   * given it is the whole answer — an empty list means no service at all — and
   * `serviceId` is ignored. The callers that only know one service (Finish's
   * next visit, a drag) leave it out and behave as they always did.
   */
  serviceIds?: string[];
  startsAt: string; // UTC ISO
  endsAt: string;
  notes: string;
  /** The patient's planned treatments this visit is for, from "Book next visit" on their plan. */
  markIds?: string[];
  /** A room, null to pick one, absent to keep the current one when it still works. See scheduleCheck. */
  roomId?: string | null;
  /**
   * Members of the patient's family to book too (0127), one straight after
   * another — the mother's three children at the dentist. Each takes the same
   * doctor, services and length, starting when the one before ends.
   */
  alsoPatientIds?: string[];
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
  /** Family members booked after the first, and whose time was taken when one could not be. */
  alsoBooked?: number;
  alsoStopped?: string;
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

    /*
      The first service is the visit's own — its colour, its room, its reports.
      The rest are written after the appointment exists.
    */
    const services = input.serviceIds ? cleanServiceIds(input.serviceIds) : input.serviceId ? [input.serviceId] : [];
    const serviceId = services[0] ?? null;

    const check = await scheduleCheck(c, access.clinicId, {
      doctorMemberId: input.doctorMemberId,
      serviceId,
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
        serviceId,
        input.startsAt,
        input.endsAt,
        input.notes.slice(0, 2000),
        access.session.user.id,
        check.roomId,
      ]
    );
    const id = r.rows[0].id as string;
    if (services.length > 1) await setExtraServices(c, access.clinicId, id, serviceId, services.slice(1));
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

    /*
      The rest of the family, back to back. Only members of this patient's own
      family; each is an ordinary visit of its own (its own confirmation, to
      the family's number). The first time that is taken stops the run and is
      named — the desk books that one by hand rather than have it land later.
    */
    const also = [...new Set((input.alsoPatientIds ?? []).filter((x) => isUuid(x) && x !== patientId))].slice(0, 8);
    let alsoBooked = 0;
    let alsoStopped: string | undefined;
    if (also.length) {
      const members = (
        await c.query(
          `select m.id, m.full_name from patients m join patients p on p.family_id = m.family_id
            where p.id = $1 and m.id = any($2::uuid[]) and m.clinic_id = $3 and m.merged_into is null`,
          [patientId, also, access.clinicId]
        )
      ).rows as { id: string; full_name: string }[];
      const length = Date.parse(input.endsAt) - Date.parse(input.startsAt);
      let at = Date.parse(input.endsAt);
      for (const pid of also) {
        const m = members.find((x) => x.id === pid);
        if (!m) continue;
        const startsAt = new Date(at).toISOString();
        const endsAt = new Date(at + length).toISOString();
        const ok = await scheduleCheck(c, access.clinicId, { doctorMemberId: input.doctorMemberId, serviceId, startsAt, endsAt, roomId: input.roomId ?? null });
        if (ok.error) {
          alsoStopped = m.full_name;
          break;
        }
        const next = (
          await c.query(
            `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, notes, source, created_by, room_id)
             values ($1, $2, $3, $4, $5, $6, $7, 'staff', $8, $9) returning id`,
            [access.clinicId, m.id, input.doctorMemberId, serviceId, startsAt, endsAt, input.notes.slice(0, 2000), access.session.user.id, ok.roomId]
          )
        ).rows[0].id as string;
        if (services.length > 1) await setExtraServices(c, access.clinicId, next, serviceId, services.slice(1));
        await audit(c, {
          clinicId: access.clinicId,
          userId: access.session.user.id,
          impersonatedBy: access.session.impersonatedBy,
          action: "appointment.create",
          entity: "appointment",
          entityId: next,
          detail: { patientId: m.id, startsAt, roomId: ok.roomId, withFamilyOf: patientId },
        });
        await emitTrigger(c, access.clinicId, "appointment_created", {
          appointmentId: next,
          patientId: m.id,
          source: "staff",
          actorUserId: access.session.user.id,
        });
        alsoBooked++;
        at += length;
      }
    }
    return { id, roomName: check.roomName, ...(also.length ? { alsoBooked, ...(alsoStopped ? { alsoStopped } : {}) } : {}) };
  });
}

export async function updateAppointmentAction(
  slug: string,
  id: string,
  input: Partial<Pick<ApptInput, "doctorMemberId" | "serviceId" | "serviceIds" | "startsAt" | "endsAt" | "notes" | "roomId">>
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
    /*
      The form sends the whole list, and then the list is the answer: its first
      service is the visit's, and an empty list is a visit with no service —
      which the single `serviceId` could never say, because a null there has
      always meant "leave it". A drag or a resize sends neither and changes
      nothing about what the visit is for.
    */
    const services = input.serviceIds ? cleanServiceIds(input.serviceIds) : null;
    const serviceId = services
      ? (services[0] ?? null)
      : input.serviceId === undefined
        ? cur.service_id
        : input.serviceId ?? cur.service_id;

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
         service_id = $6, notes = coalesce($7, notes), room_id = $8
       where id = $1 and clinic_id = $2`,
      [
        id,
        access.clinicId,
        startsAt,
        endsAt,
        doctor,
        serviceId,
        input.notes === undefined ? null : input.notes.slice(0, 2000),
        check.roomId,
      ]
    );
    if (services) await setExtraServices(c, access.clinicId, id, serviceId, services.slice(1));
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
    // Approved: the patient was told "we'll confirm it shortly", so now they are.
    if (r.changed && r.previousStatus === "pending_approval" && (status === "scheduled" || status === "confirmed")) {
      await tellPatientBookingApproved(c, access.clinicId, id);
    }
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

/**
 * Clear cancelled visits out of a patient's file (Yamen, 2026-11-20: cancelled
 * items "only show, without the ability of deleting what is cancelled").
 *
 * Only cancelled ones, only this clinic's and this patient's, and only those
 * nothing in the file hangs on (appointmentAttachedSql) — the rest are left
 * and counted, so the screen can say why. Their reminders' runs go with them.
 */
export async function deleteCancelledAppointmentsAction(
  slug: string,
  patientId: string,
  ids: string[]
): Promise<{ error?: string; deleted?: number; kept?: number }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  if (!isUuid(patientId) || !Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every(isUuid)) return { error: "invalid" };

  return inClinic(access, async (c) => {
    const gone = await c.query(
      `delete from appointments a
        where a.id = any($1::uuid[]) and a.clinic_id = $2 and a.patient_id = $3 and a.status = 'cancelled'
          and not ${appointmentAttachedSql("a")}
        returning a.id, a.starts_at`,
      [ids, access.clinicId, patientId]
    );
    const deleted = gone.rowCount ?? 0;
    if (deleted) {
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "appointment.delete_cancelled",
        entity: "patient",
        entityId: patientId,
        detail: { appointments: gone.rows.map((r) => ({ id: r.id, startsAt: r.starts_at })) },
      });
    }
    revalidatePath(`/c/${slug}/patients/${patientId}`);
    return { deleted, kept: ids.length - deleted };
  });
}
