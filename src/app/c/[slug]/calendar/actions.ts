"use server";

import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { emitTrigger } from "@/lib/triggers";
import { findOrCreatePatient } from "@/lib/patients";
import { lockClinicSchedule } from "@/lib/appointments";
import type { PoolClient } from "pg";

const ACTIVE = `('pending_approval', 'scheduled', 'confirmed')`;

async function conflictFor(
  c: PoolClient,
  clinicId: string,
  doctorMemberId: string | null,
  startsAt: string,
  endsAt: string,
  excludeId?: string
): Promise<{ id: string; patient: string } | null> {
  // Held until this transaction commits, so the answer is still true when the
  // caller acts on it. See lockClinicSchedule.
  await lockClinicSchedule(c, clinicId);
  if (!doctorMemberId) return null;
  const r = await c.query(
    `select a.id, p.full_name as patient from appointments a
     join patients p on p.id = a.patient_id
     where a.clinic_id = $1 and a.doctor_member_id = $2
       and a.status in ${ACTIVE}
       and a.starts_at < $4 and a.ends_at > $3
       and ($5::uuid is null or a.id <> $5)
     limit 1`,
    [clinicId, doctorMemberId, startsAt, endsAt, excludeId ?? null]
  );
  return r.rows[0] ?? null;
}

export type ApptInput = {
  patientId?: string;
  newPatient?: { fullName: string; phone: string };
  doctorMemberId: string | null;
  serviceId: string | null;
  startsAt: string; // UTC ISO
  endsAt: string;
  notes: string;
};

export async function createAppointmentAction(
  slug: string,
  input: ApptInput
): Promise<{ id?: string; error?: string; conflictWith?: string }> {
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
      });
      patientId = r.id;
    }
    if (!patientId) return { error: "patient_required" };

    const conflict = await conflictFor(
      c,
      access.clinicId,
      input.doctorMemberId,
      input.startsAt,
      input.endsAt
    );
    if (conflict) return { error: "conflict", conflictWith: conflict.patient };

    const r = await c.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, notes, source, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'staff', $8) returning id`,
      [
        access.clinicId,
        patientId,
        input.doctorMemberId,
        input.serviceId,
        input.startsAt,
        input.endsAt,
        input.notes.slice(0, 2000),
        access.session.user.id,
      ]
    );
    const id = r.rows[0].id as string;
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.create",
      entity: "appointment",
      entityId: id,
      detail: { patientId, startsAt: input.startsAt },
    });
    await emitTrigger(c, access.clinicId, "appointment_created", { appointmentId: id, patientId });
    return { id };
  });
}

export async function updateAppointmentAction(
  slug: string,
  id: string,
  input: Partial<Pick<ApptInput, "doctorMemberId" | "serviceId" | "startsAt" | "endsAt" | "notes">>
): Promise<{ ok?: boolean; error?: string; conflictWith?: string }> {
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

    const conflict = await conflictFor(c, access.clinicId, doctor, startsAt, endsAt, id);
    if (conflict) return { error: "conflict", conflictWith: conflict.patient };

    await c.query(
      `update appointments set starts_at = $3, ends_at = $4, doctor_member_id = $5,
         service_id = coalesce($6, service_id), notes = coalesce($7, notes)
       where id = $1 and clinic_id = $2`,
      [
        id,
        access.clinicId,
        startsAt,
        endsAt,
        doctor,
        input.serviceId === undefined ? null : input.serviceId,
        input.notes === undefined ? null : input.notes.slice(0, 2000),
      ]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.update",
      entity: "appointment",
      entityId: id,
      detail: { startsAt, endsAt },
    });
    return { ok: true };
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
    const r = await c.query(
      `update appointments set status = $3 where id = $1 and clinic_id = $2
       returning patient_id, starts_at`,
      [id, access.clinicId, status]
    );
    if (!r.rowCount) return { error: "not_found" };
    const { patient_id } = r.rows[0];
    if (status === "completed") {
      await c.query(
        `update patients set last_visit_at = greatest(coalesce(last_visit_at, 'epoch'::timestamptz), $2::timestamptz), status = 'active'
         where id = $1`,
        [patient_id, r.rows[0].starts_at]
      );
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
    await emitTrigger(c, access.clinicId, "appointment_status_changed", {
      appointmentId: id,
      patientId: patient_id,
      status,
    });
    return { ok: true };
  });
}
