import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { systemMessage } from "./system-messages";
import { queueWhatsAppMessage } from "./outbound";

/**
 * Tells the patient their online booking was approved.
 *
 * A clinic that approves bookings by hand sends the patient "we received
 * your request, we'll confirm it shortly" from the booking page — and then
 * never confirmed it: approving it in the calendar changed the status and told
 * nobody. The patient turned up not knowing whether they were expected.
 *
 * The words are the clinic's own "booking confirmed" message, the one the
 * booking page sends when no approval is needed, so a clinic that rewrote it
 * or switched it off gets exactly what it chose. In the clinic's language —
 * the visitor's own was not kept with the booking.
 */
export async function tellPatientBookingApproved(c: PoolClient, clinicId: string, appointmentId: string): Promise<void> {
  const a = (
    await c.query(
      `select a.starts_at, a.patient_id, p.full_name, p.phone_e164, cl.timezone, cl.default_locale,
              cl.name as clinic_name, cl.name_ar as clinic_name_ar, cl.address, cl.address_ar,
              s.name as service_name, s.name_ar as service_name_ar, du.full_name as doctor_name,
              coalesce(ws.status = 'connected', false) as wa_connected
         from appointments a
         join patients p on p.id = a.patient_id
         join clinics cl on cl.id = a.clinic_id
         left join services s on s.id = a.service_id
         left join clinic_members dm on dm.id = a.doctor_member_id
         left join users du on du.id = dm.user_id
         left join whatsapp_sessions ws on ws.clinic_id = a.clinic_id
        where a.id = $1 and a.clinic_id = $2`,
      [appointmentId, clinicId]
    )
  ).rows[0];
  if (!a || !a.phone_e164 || !a.wa_connected) return;
  const lang = a.default_locale === "en" ? "en" : "ar";
  const local = DateTime.fromJSDate(new Date(a.starts_at)).setZone(a.timezone).setLocale(lang === "en" ? "en-GB" : "ar-JO-u-nu-latn");
  const msg = await systemMessage(c, {
    clinicId,
    key: "booking_confirmed",
    lang,
    vars: {
      "patient.first_name": String(a.full_name).trim().split(/\s+/)[0] || a.full_name,
      "patient.name": a.full_name,
      "clinic.name": lang === "en" ? a.clinic_name : a.clinic_name_ar || a.clinic_name,
      "clinic.address": (lang === "en" ? a.address : a.address_ar || a.address) ?? "",
      "appointment.service": (lang === "en" ? a.service_name : a.service_name_ar || a.service_name) ?? "",
      "appointment.doctor": a.doctor_name ?? "",
      "appointment.when": `${local.toFormat("cccc d LLLL")} · ${local.toFormat("h:mm a")}`,
      "appointment.join_url": "",
    },
  });
  if (!msg.enabled) return;
  await queueWhatsAppMessage(c, { clinicId, phoneE164: a.phone_e164, senderKind: "system", body: msg.body, patientId: a.patient_id });
}
