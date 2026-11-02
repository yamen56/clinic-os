"use server";

import { DateTime } from "luxon";
import { can, requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/uuid";
import { systemMessage } from "@/lib/system-messages";
import { queueWhatsAppMessage } from "@/lib/outbound";

/**
 * A patient running late (Yamen, 2026-11-02): "when they are late the
 * receptionist adds how many minutes, then a message gets sent to the
 * upcoming patients … no need to change the timing, and sending the message
 * is optional."
 *
 * The minutes go on the late patient's visit, so the board says it. The
 * patients after them with the same doctor today can be told there may be a
 * wait — only those the desk ticked, only once each, only those not in the
 * clinic yet. Nobody's booking moves.
 */

export type LateResult = {
  error?: "forbidden" | "not_found" | "invalid" | "bad_state" | "not_today" | "whatsapp_not_connected" | "message_off";
  row?: { id: string; late_min: number; late_noted_at: string };
  /** Who was told, and when. */
  told?: { id: string; delay_notice_at: string }[];
};

const ACTIVE = ["pending_approval", "scheduled", "confirmed"];

export async function markLateAction(slug: string, id: string, minutes: number, tellIds: string[]): Promise<LateResult> {
  const access = await requireClinic(slug);
  if (!can(access, "calendar")) return { error: "forbidden" };
  if (!isUuid(id)) return { error: "not_found" };
  const min = Math.round(Number(minutes));
  const tell = [...new Set(tellIds)];
  if (!Number.isFinite(min) || min < 1 || min > 240 || tell.length > 40 || !tell.every(isUuid)) return { error: "invalid" };

  return inClinic(access, async (c) => {
    const cur = (
      await c.query(
        `select a.id, a.status, a.starts_at, a.doctor_member_id, a.finished_at, cl.timezone, cl.default_locale,
                cl.name as clinic_name, cl.name_ar as clinic_name_ar,
                (a.starts_at at time zone cl.timezone)::date = (now() at time zone cl.timezone)::date as today
           from appointments a join clinics cl on cl.id = a.clinic_id
          where a.id = $1 and a.clinic_id = $2
          for update of a`,
        [id, access.clinicId]
      )
    ).rows[0];
    if (!cur) return { error: "not_found" };
    if (!cur.today) return { error: "not_today" };
    if (!ACTIVE.includes(cur.status) || cur.finished_at) return { error: "bad_state" };

    const row = (
      await c.query(
        `update appointments set late_min = $2, late_noted_at = now(), late_noted_by = $3 where id = $1
         returning id, late_min, late_noted_at`,
        [id, min, access.session.user.id]
      )
    ).rows[0];

    const told: { id: string; delay_notice_at: string }[] = [];
    let error: LateResult["error"];
    if (tell.length) {
      const wa = (await c.query(`select status from whatsapp_sessions where clinic_id = $1`, [access.clinicId])).rows[0];
      // Only the doctor's later patients today who are not here yet — whatever the browser sent.
      const next = (
        await c.query(
          `select a.id, a.starts_at, a.patient_id, p.full_name, p.phone_e164, du.full_name as doctor_name
             from appointments a
             join patients p on p.id = a.patient_id
             left join clinic_members dm on dm.id = a.doctor_member_id
             left join users du on du.id = dm.user_id
            where a.id = any($1::uuid[]) and a.clinic_id = $2
              and a.doctor_member_id is not distinct from $3
              and a.starts_at > $4
              and (a.starts_at at time zone $5)::date = ($4::timestamptz at time zone $5)::date
              and a.status = any($6::text[]) and a.arrived_at is null
              and p.phone_e164 is not null
            order by a.starts_at`,
          [tell, access.clinicId, cur.doctor_member_id, cur.starts_at, cur.timezone, ACTIVE]
        )
      ).rows;
      if (wa?.status !== "connected") error = "whatsapp_not_connected";
      else {
        const lang = cur.default_locale === "en" ? "en" : "ar";
        for (const n of next) {
          const at = DateTime.fromJSDate(new Date(n.starts_at))
            .setZone(cur.timezone)
            .setLocale(lang === "en" ? "en-GB" : "ar-JO-u-nu-latn")
            .toFormat("h:mm a");
          const msg = await systemMessage(c, {
            clinicId: access.clinicId,
            key: "running_late",
            lang,
            vars: {
              "patient.first_name": String(n.full_name).trim().split(/\s+/)[0] || n.full_name,
              "patient.name": n.full_name,
              "clinic.name": lang === "en" ? cur.clinic_name : cur.clinic_name_ar || cur.clinic_name,
              "appointment.time": at,
              "appointment.doctor": n.doctor_name ?? "",
              "delay.minutes": String(min),
            },
          });
          if (!msg.enabled) {
            error = "message_off";
            break;
          }
          await queueWhatsAppMessage(c, {
            clinicId: access.clinicId,
            phoneE164: n.phone_e164,
            senderKind: "system",
            body: msg.body,
            patientId: n.patient_id,
          });
          const r = (await c.query(`update appointments set delay_notice_at = now() where id = $1 returning delay_notice_at`, [n.id])).rows[0];
          told.push({ id: n.id, delay_notice_at: new Date(r.delay_notice_at).toISOString() });
        }
      }
    }

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "appointment.late",
      entity: "appointment",
      entityId: id,
      detail: { minutes: min, told: told.map((x) => x.id) },
    });
    // Strings, as the board's rows are: a Date would not survive the trip to the browser as one.
    return {
      row: { id: row.id, late_min: row.late_min, late_noted_at: new Date(row.late_noted_at).toISOString() },
      told,
      ...(error ? { error } : {}),
    };
  });
}
