"use server";

import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { emitTrigger } from "@/lib/triggers";
import { findOrCreatePatient } from "@/lib/patients";
import { lockClinicSchedule } from "@/lib/appointments";
import { loadActiveRooms, roomOccupant, suitableRooms } from "@/lib/rooms";
import { isUuid } from "@/lib/uuid";
import type { PoolClient } from "pg";
import { notifyUser, staffMembersInRoles } from "@/lib/notify";
import { NT, asLocale } from "@/lib/notification-text";
import { resolveCapabilities, type MemberRole } from "@/lib/permissions";

/**
 * The patient's way through the clinic today: arrived → in a room → finished,
 * or didn't come. See migration 0078 for why this lives in timestamps and not
 * in `status`.
 *
 * Every step answers with the row as it now is, so the board shows the result
 * of the click without a second fetch.
 */

export type FlowStep = "arrived" | "seated" | "finished" | "no_show" | "undo";

export type FlowRow = {
  id: string;
  status: string;
  arrived_at: string | null;
  seated_at: string | null;
  finished_at: string | null;
  room_id: string | null;
  flow_prev_status: string | null;
  next_visit_days: number | null;
  next_visit_min: number | null;
  next_visit_member_id: string | null;
  desk_note: string;
  handed_off_at: string | null;
};

/**
 * What the doctor tells the desk on finishing — all of it optional (migration
 * 0088). When the next visit should be, how long and with whom, and a line for
 * reception. Finish without it is Skip: the visit ends exactly as it used to.
 */
export type Handoff = {
  nextDays: number | null;
  nextMin: number | null;
  nextMemberId: string | null;
  note: string;
};

export type FlowResult = {
  ok?: true;
  error?: "forbidden" | "not_found" | "bad_state" | "room_occupied" | "bad_room" | "not_today";
  /** Who is in the room already. */
  occupiedBy?: string;
  row?: FlowRow;
};

const RETURNING = `returning id, status, arrived_at, seated_at, finished_at, room_id, flow_prev_status,
  next_visit_days, next_visit_min, next_visit_member_id, desk_note, handed_off_at`;

export async function setFlowAction(
  slug: string,
  id: string,
  step: FlowStep,
  opts: { roomId?: string | null; handoff?: Handoff } = {}
): Promise<FlowResult> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  return inClinic(access, async (c) => {
    // Seating asks who is in the room right now; the lock keeps two people
    // from putting two patients in the same chair at the same moment.
    if (step === "seated") await lockClinicSchedule(c, access.clinicId);
    const cur = (
      await c.query(
        `select a.*, (a.starts_at at time zone cl.timezone)::date = (now() at time zone cl.timezone)::date as today
           from appointments a join clinics cl on cl.id = a.clinic_id
          where a.id = $1 and a.clinic_id = $2
          for update of a`,
        [id, access.clinicId]
      )
    ).rows[0];
    if (!cur) return { error: "not_found" };
    // The board is about today. Yesterday's visit is finished or not from the
    // appointment panel, where its status already lives.
    if (!cur.today) return { error: "not_today" };
    const active = ["pending_approval", "scheduled", "confirmed"].includes(cur.status);

    let row: FlowRow | undefined;
    let statusEvent: { status: string; previousStatus: string } | null = null;

    if (step === "arrived") {
      if (!active || cur.arrived_at) return { error: "bad_state" };
      row = (await c.query(`update appointments set arrived_at = now() where id = $1 ${RETURNING}`, [id])).rows[0];
      /*
        For the flows that start at the desk: the doctor told their patient is
        here, the forms sent to the phone in the waiting room. Once per
        appointment — keyed, so an arrival undone and marked again does not
        greet the patient twice.
      */
      await emitTrigger(
        c,
        access.clinicId,
        "patient_arrived",
        { appointmentId: id, patientId: cur.patient_id, actorUserId: access.session.user.id },
        `patient_arrived:${id}`
      );
    } else if (step === "seated") {
      if (!active || cur.seated_at) return { error: "bad_state" };
      let roomId: string | null = opts.roomId === undefined ? cur.room_id : opts.roomId;
      const rooms = await loadActiveRooms(c, access.clinicId);
      if (roomId && !rooms.some((r) => r.id === roomId)) return { error: "bad_room" };
      if (roomId) {
        const in_ = await roomOccupant(c, access.clinicId, roomId, id);
        if (in_) return { error: "room_occupied", occupiedBy: in_.patient };
      } else if (rooms.length) {
        // No room named and none booked: the first suitable one nobody is in.
        const svc = cur.service_id
          ? (await c.query(`select location_kind from services where id = $1`, [cur.service_id])).rows[0]
          : null;
        for (const r of suitableRooms(rooms, cur.service_id, svc?.location_kind ?? null)) {
          if (!(await roomOccupant(c, access.clinicId, r.id, id))) {
            roomId = r.id;
            break;
          }
        }
      }
      row = (
        await c.query(
          `update appointments set seated_at = now(), arrived_at = coalesce(arrived_at, now()), room_id = $2
            where id = $1 ${RETURNING}`,
          [id, roomId]
        )
      ).rows[0];
    } else if (step === "finished") {
      if (!active) return { error: "bad_state" };
      row = (
        await c.query(
          `update appointments set status = 'completed', finished_at = now(), flow_prev_status = status
            where id = $1 ${RETURNING}`,
          [id]
        )
      ).rows[0];
      await c.query(
        `update patients set last_visit_at = greatest(coalesce(last_visit_at, 'epoch'::timestamptz), $2::timestamptz), status = 'active'
          where id = $1`,
        [cur.patient_id, cur.starts_at]
      );
      statusEvent = { status: "completed", previousStatus: cur.status };

      /*
        The hand-off, when the doctor gave one. Checked here, not trusted: the
        member must be this clinic's and active (a foreign key is checked as
        the table's owner, past RLS), the numbers inside what the columns allow.
      */
      const h = opts.handoff;
      if (h) {
        const days = Number.isInteger(h.nextDays) && h.nextDays! >= 1 && h.nextDays! <= 730 ? h.nextDays : null;
        const mins = Number.isInteger(h.nextMin) && h.nextMin! >= 5 && h.nextMin! <= 480 ? h.nextMin : null;
        let member: string | null = null;
        if (h.nextMemberId && isUuid(h.nextMemberId)) {
          const m = await c.query(`select id from clinic_members where id = $1 and clinic_id = $2 and active`, [h.nextMemberId, access.clinicId]);
          member = m.rowCount ? h.nextMemberId : null;
        }
        const note = String(h.note ?? "").trim().slice(0, 500);
        row = (
          await c.query(
            `update appointments set next_visit_days = $2, next_visit_min = $3, next_visit_member_id = $4, desk_note = $5,
                    handed_off_at = now(), handed_off_by = $6
              where id = $1 ${RETURNING}`,
            [id, days, mins, member, note, access.session.user.id]
          )
        ).rows[0];
        if (days || note) await tellTheDesk(c, access.clinicId, access.clinicSlug, id, access.session.user.id);
      }
    } else if (step === "no_show") {
      // Somebody already in a room plainly came.
      if (!active || cur.seated_at) return { error: "bad_state" };
      row = (
        await c.query(
          `update appointments set status = 'no_show', flow_prev_status = status, arrived_at = null
            where id = $1 ${RETURNING}`,
          [id]
        )
      ).rows[0];
      statusEvent = { status: "no_show", previousStatus: cur.status };
    } else if (step === "undo") {
      /*
        One stage back, and nothing fired. Re-raising the status event would
        re-send what the original step already sent — putting Finish back to
        `confirmed` would re-send the consent forms. What the original step
        started (an automation run, last_visit_at) stays; that is the price of
        an undo that cannot message anybody.
      */
      if ((cur.status === "completed" || cur.status === "no_show") && cur.flow_prev_status) {
        // Unfinished, the visit's hand-off goes with it: it was about a visit that has not ended.
        row = (
          await c.query(
            `update appointments set status = flow_prev_status, flow_prev_status = null, finished_at = null,
                    next_visit_days = null, next_visit_min = null, next_visit_member_id = null, desk_note = '',
                    handed_off_at = null, handed_off_by = null
              where id = $1 ${RETURNING}`,
            [id]
          )
        ).rows[0];
      } else if (active && cur.seated_at) {
        row = (await c.query(`update appointments set seated_at = null where id = $1 ${RETURNING}`, [id])).rows[0];
      } else if (active && cur.arrived_at) {
        row = (await c.query(`update appointments set arrived_at = null where id = $1 ${RETURNING}`, [id])).rows[0];
      } else {
        return { error: "bad_state" };
      }
    }
    if (!row) return { error: "bad_state" };

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.flow",
      entity: "appointment",
      entityId: id,
      detail: { step, roomId: row.room_id },
    });
    if (statusEvent) {
      await emitTrigger(c, access.clinicId, "appointment_status_changed", {
        appointmentId: id,
        patientId: cur.patient_id,
        status: statusEvent.status,
        previousStatus: statusEvent.previousStatus,
        actorUserId: access.session.user.id,
      });
    }
    return { ok: true, row: serialize(row) };
  });
}

/**
 * The desk is told the doctor has finished, and what they asked for.
 *
 * To whoever takes the patient out of the clinic — the front desk and the
 * owners who may see the calendar — in their own language, onto the visit on
 * the board. Not to the doctor who finished it: they know.
 */
async function tellTheDesk(c: PoolClient, clinicId: string, slug: string, appointmentId: string, actorUserId: string) {
  const a = (
    await c.query(
      `select a.next_visit_days, a.desk_note, p.full_name as patient, coalesce(du.full_name, au.full_name) as doctor
         from appointments a
         join patients p on p.id = a.patient_id
         left join clinic_members dm on dm.id = a.doctor_member_id
         left join users du on du.id = dm.user_id
         left join users au on au.id = a.handed_off_by
        where a.id = $1`,
      [appointmentId]
    )
  ).rows[0];
  if (!a) return;
  for (const m of await staffMembersInRoles(c, clinicId, ["owner", "receptionist"])) {
    if (m.userId === actorUserId) continue;
    if (!resolveCapabilities(m.permissions, { isOwner: m.isOwner, role: m.role as MemberRole }).calendar) continue;
    const L = NT[asLocale(m.locale)];
    await notifyUser(c, m.userId, {
      clinicId,
      kind: "visit_handoff",
      title: L.handoffTitle(a.doctor ?? "", a.patient),
      body: [a.next_visit_days ? L.handoffNext(a.next_visit_days) : L.handoffDone, a.desk_note].filter(Boolean).join("\n"),
      url: `/c/${slug}/calendar?open=${appointmentId}`,
      dedupeKey: `visit_handoff:${appointmentId}`,
    });
  }
}

/**
 * Somebody at the desk with no appointment, to be seen today.
 *
 * Starts now and is already arrived. It takes no slot check: the patient is
 * here and waits for whoever is free, which is the point of a walk-in — the
 * calendar shows it alongside whatever the doctor is doing. A room is only
 * taken when they are called in.
 *
 * It does not raise `appointment_created`. Everything listening for that is
 * about a booking: the "your appointment is confirmed" WhatsApp, the doctor's
 * "new appointment" alert, and closing the patient's waitlist entries. None of
 * that is true of someone standing at the desk — the doctor hears through the
 * arrival chime instead, and a walk-in today is not the slot they were waiting
 * for.
 */
export async function walkInAction(
  slug: string,
  input: {
    patientId?: string;
    newPatient?: { fullName: string; phone: string };
    doctorMemberId: string | null;
    serviceId: string | null;
    durationMin?: number;
    notes?: string;
  }
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  return inClinic(access, async (c) => {
    let patientId = input.patientId && isUuid(input.patientId) ? input.patientId : undefined;
    if (patientId) {
      const ok = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [
        patientId,
        access.clinicId,
      ]);
      if (!ok.rowCount) return { error: "not_found" };
    } else if (input.newPatient) {
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

    if (input.doctorMemberId) {
      const d = await c.query(
        `select 1 from clinic_members where id = $1 and clinic_id = $2 and role = 'doctor' and active`,
        [input.doctorMemberId, access.clinicId]
      );
      if (!d.rowCount) return { error: "bad_doctor" };
    }
    let duration = Math.round(Number(input.durationMin) || 0);
    if (input.serviceId) {
      const s = (
        await c.query(`select duration_min from services where id = $1 and clinic_id = $2`, [input.serviceId, access.clinicId])
      ).rows[0];
      if (!s) return { error: "bad_service" };
      if (!duration) duration = s.duration_min as number;
    }
    duration = Math.min(Math.max(duration || 30, 5), 480);

    const r = await c.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at,
                                 status, source, notes, created_by, arrived_at, walk_in)
       values ($1, $2, $3, $4, date_trunc('minute', now()), date_trunc('minute', now()) + make_interval(mins => $5),
               'confirmed', 'staff', $6, $7, now(), true)
       returning id`,
      [
        access.clinicId,
        patientId,
        input.doctorMemberId,
        input.serviceId,
        duration,
        (input.notes ?? "").slice(0, 2000),
        access.session.user.id,
      ]
    );
    const id = r.rows[0].id as string;
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.walk_in",
      entity: "appointment",
      entityId: id,
      detail: { patientId },
    });
    // Not a booking (see above), but very much an arrival.
    await emitTrigger(
      c,
      access.clinicId,
      "patient_arrived",
      { appointmentId: id, patientId, actorUserId: access.session.user.id, walkIn: true },
      `patient_arrived:${id}`
    );
    return { id };
  });
}

function serialize(r: FlowRow): FlowRow {
  const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
  return {
    id: r.id,
    status: r.status,
    arrived_at: iso(r.arrived_at),
    seated_at: iso(r.seated_at),
    finished_at: iso(r.finished_at),
    room_id: r.room_id,
    flow_prev_status: r.flow_prev_status,
    next_visit_days: r.next_visit_days ?? null,
    next_visit_min: r.next_visit_min ?? null,
    next_visit_member_id: r.next_visit_member_id ?? null,
    desk_note: r.desk_note ?? "",
    handed_off_at: iso(r.handed_off_at),
  };
}
