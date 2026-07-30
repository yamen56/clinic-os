import { DateTime } from "luxon";
import { withSystem } from "@/lib/db";
import { findOrCreatePatient } from "@/lib/patients";
import { lockClinicSchedule } from "@/lib/appointments";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { notifyClinicStaff } from "@/lib/notify";
import { emitTrigger } from "@/lib/triggers";
import type { PublicLink } from "@/lib/booking-public";

export type BookingPayload = {
  serviceId: string;
  doctorId: string | null;
  startISO: string;
  fullName: string;
  locale: "ar" | "en";
};

/**
 * Creates the patient (identity rule) + appointment, queues the WhatsApp
 * confirmation, and notifies staff. Used by both the OTP and offline paths.
 */
export async function finalizeBooking(
  data: PublicLink,
  phone: string,
  p: BookingPayload,
  verified: boolean
): Promise<{ error?: string } | { appointmentId: string; startISO: string; status: string }> {
  return withSystem(async (c) => {
    // Before the free/busy scan, so the slot this booking picks cannot be taken
    // by a simultaneous one between the check and the insert.
    await lockClinicSchedule(c, data.clinic.id);

    const service = (
      await c.query(
        `select id, name, name_ar, duration_min from services where id = $1 and clinic_id = $2 and active`,
        [p.serviceId, data.clinic.id]
      )
    ).rows[0];
    if (!service) return { error: "bad_service" };

    const start = DateTime.fromISO(p.startISO);
    if (!start.isValid || start < DateTime.now()) return { error: "slot_taken" };
    const end = start.plus({ minutes: service.duration_min });

    // Resolve doctor: requested, link-locked, or first free among candidates
    let doctorId = p.doctorId ?? data.link.doctor_member_id;
    const candidates: (string | null)[] = doctorId
      ? [doctorId]
      : data.doctors.length
        ? data.doctors.map((d) => d.id)
        : [null];
    let chosen: string | null | undefined;
    for (const cand of candidates) {
      if (cand === null) {
        chosen = null;
        break;
      }
      const busy = await c.query(
        `select 1 from appointments where clinic_id = $1 and doctor_member_id = $2
           and status in ('pending_approval', 'scheduled', 'confirmed')
           and starts_at < $4 and ends_at > $3 limit 1`,
        [data.clinic.id, cand, start.toUTC().toISO(), end.toUTC().toISO()]
      );
      if (!busy.rowCount) {
        chosen = cand;
        break;
      }
    }
    if (chosen === undefined) return { error: "slot_taken" };

    const patient = await findOrCreatePatient(c, data.clinic.id, {
      phone,
      fullName: p.fullName,
      source: "booking_link",
      status: "active",
    });
    if (patient.created) {
      await emitTrigger(c, data.clinic.id, "patient_created", {
        patientId: patient.id,
        source: "booking_link",
      });
    }

    const status = data.link.approval_mode === "approval" ? "pending_approval" : "confirmed";
    const appt = await c.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source, notes)
       values ($1, $2, $3, $4, $5, $6, $7, 'booking_link', $8) returning id`,
      [
        data.clinic.id,
        patient.id,
        chosen,
        service.id,
        start.toUTC().toISO(),
        end.toUTC().toISO(),
        status,
        verified ? "" : "Booked while WhatsApp was offline — number not verified.",
      ]
    );
    const appointmentId = appt.rows[0].id as string;

    const tz = data.clinic.timezone;
    const local = start.setZone(tz).setLocale(p.locale === "en" ? "en-GB" : "ar-JO-u-nu-latn");
    const when = `${local.toFormat("cccc d LLLL")} · ${local.toFormat("h:mm a")}`;
    const clinicName = p.locale === "en" ? data.clinic.name : data.clinic.name_ar || data.clinic.name;
    const serviceName = p.locale === "en" ? service.name : service.name_ar || service.name;
    const doctorName = data.doctors.find((d) => d.id === chosen)?.name;

    const confirmBody =
      status === "confirmed"
        ? p.locale === "en"
          ? `Hi ${p.fullName} 👋\nYour appointment at ${clinicName} is confirmed:\n${serviceName}${doctorName ? ` — ${doctorName}` : ""}\n🗓 ${when}\n${data.clinic.address ?? ""}`.trim()
          : `مرحباً ${p.fullName} 👋\nتم تأكيد موعدك في ${clinicName}:\n${serviceName}${doctorName ? ` — ${doctorName}` : ""}\n🗓 ${when}\n${data.clinic.address_ar ?? data.clinic.address ?? ""}`.trim()
        : p.locale === "en"
          ? `Hi ${p.fullName}, we received your booking request at ${clinicName} for ${when}. We'll confirm it shortly.`
          : `مرحباً ${p.fullName}، استلمنا طلب حجزك في ${clinicName} ليوم ${when}. سنؤكده لك قريباً.`;

    if (data.clinic.wa_connected) {
      await queueWhatsAppMessage(c, {
        clinicId: data.clinic.id,
        phoneE164: phone,
        senderKind: "system",
        body: confirmBody,
        patientId: patient.id,
      });
    }

    await notifyClinicStaff(c, data.clinic.id, {
      kind: "booking",
      title:
        status === "confirmed"
          ? `حجز جديد: ${p.fullName}`
          : `طلب حجز بانتظار الموافقة: ${p.fullName}`,
      body: `${serviceName} · ${when}`,
      url: `/c/${data.clinic.slug}/calendar`,
    });
    await emitTrigger(c, data.clinic.id, "booking_submitted", {
      appointmentId,
      patientId: patient.id,
      status,
    });
    await emitTrigger(c, data.clinic.id, "appointment_created", {
      appointmentId,
      patientId: patient.id,
      source: "booking_link",
    });

    return { appointmentId, startISO: start.toUTC().toISO()!, status };
  });
}
