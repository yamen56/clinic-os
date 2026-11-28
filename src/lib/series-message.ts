import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { systemMessage } from "./system-messages";
import { queueWhatsAppMessage } from "./outbound";

/**
 * Sends the patient every date of a series they were just booked for (0126),
 * one line each, in the clinic's own words (`series_booked`, which the clinic
 * may reword or switch off).
 *
 * One message instead of one per visit: six confirmations arriving together
 * read as a mistake, and a list is what the patient wants to keep anyway.
 * In the clinic's language, as the other visit messages are.
 */
export async function tellPatientSeries(c: PoolClient, clinicId: string, seriesId: string): Promise<boolean> {
  const rows = (
    await c.query(
      `select a.id, a.starts_at, a.patient_id, p.full_name, patient_reach_phone(p.id) as phone,
              cl.timezone, cl.default_locale, cl.name as clinic_name, cl.name_ar as clinic_name_ar,
              appointment_service_names(a.id, false) as service_name, appointment_service_names(a.id, true) as service_name_ar,
              du.full_name as doctor_name,
              coalesce(ws.status = 'connected', false) as wa_connected
         from appointments a
         join patients p on p.id = a.patient_id
         join clinics cl on cl.id = a.clinic_id
         left join clinic_members dm on dm.id = a.doctor_member_id
         left join users du on du.id = dm.user_id
         left join whatsapp_sessions ws on ws.clinic_id = a.clinic_id
        where a.series_id = $1 and a.clinic_id = $2 and a.status in ('pending_approval', 'scheduled', 'confirmed')
        order by a.starts_at`,
      [seriesId, clinicId]
    )
  ).rows;
  const a = rows[0];
  if (!a || !a.phone || !a.wa_connected) return false;
  const lang = a.default_locale === "en" ? "en" : "ar";
  const fmt = (iso: Date) =>
    DateTime.fromJSDate(new Date(iso))
      .setZone(a.timezone)
      .setLocale(lang === "en" ? "en-GB" : "ar-JO-u-nu-latn")
      .toFormat("cccc d LLLL · h:mm a");
  const msg = await systemMessage(c, {
    clinicId,
    key: "series_booked",
    lang,
    vars: {
      "patient.first_name": String(a.full_name).trim().split(/\s+/)[0] || a.full_name,
      "patient.name": a.full_name,
      "clinic.name": lang === "en" ? a.clinic_name : a.clinic_name_ar || a.clinic_name,
      "appointment.service": (lang === "en" ? a.service_name : a.service_name_ar || a.service_name) ?? "",
      "appointment.doctor": a.doctor_name ?? "",
      "series.dates": rows.map((r, i) => `${i + 1}. ${fmt(r.starts_at)}`).join("\n"),
    },
  });
  if (!msg.enabled) return false;
  await queueWhatsAppMessage(c, { clinicId, phoneE164: a.phone, senderKind: "system", body: msg.body, patientId: a.patient_id });
  return true;
}
