import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { withSystem } from "./db";
import { lockClinicSchedule, applyAppointmentStatus } from "./appointments";
import { computeDayCounts, computeSlots, type AvailabilityOpts } from "./slots";
import { loadActiveRooms, pickRoom, suitableRoomsForAll, HOLDS_SLOT } from "./rooms";
import { queueWhatsAppMessage } from "./outbound";
import { systemMessage } from "./system-messages";
import { emitTrigger } from "./triggers";
import { audit } from "./audit";
import { appUrl } from "./urls";
import { patientChangesSql } from "./features";
import { whiteLabelSql } from "./white-label";
import {
  VISIT_BOOKABLE_SQL,
  verifyVisitToken,
  visitRights,
  visitTokenAppointment,
  visitUrl,
  type PatientChangesMode,
  type VisitRights,
} from "./visit-link";

/**
 * What a patient can do with their own appointment from its link (0115).
 *
 * Every write here is the desk's own path with the patient as the actor:
 * cancelling goes through `applyAppointmentStatus`, so the waitlist offer, the
 * doctor's alert and the clinic's automations follow exactly as they do when
 * reception presses Cancel; moving fires `appointment_rescheduled`, which
 * re-arms the reminders and tells the doctor. Reception is not in the loop,
 * which was the point.
 */

export type VisitRow = {
  id: string;
  clinic_id: string;
  patient_id: string;
  doctor_member_id: string | null;
  service_id: string | null;
  service_ids: string[];
  starts_at: Date;
  ends_at: Date;
  status: string;
  patient_moves: number;
  booking_link_id: string | null;
  room_id: string | null;
  meeting_url: string | null;
  bookable: boolean;
  service_name: string | null;
  service_name_ar: string | null;
  doctor_name: string | null;
  patient_name: string;
  patient_phone: string | null;
  clinic: {
    name: string;
    name_ar: string | null;
    slug: string;
    logo_path: string | null;
    brand_color: string;
    address: string | null;
    address_ar: string | null;
    phone_e164: string | null;
    wa_number: string | null;
    google_maps_url: string | null;
    timezone: string;
    default_locale: "ar" | "en";
    working_hours: Record<string, [string, string][]>;
    blocked_dates: string[];
    patient_changes: PatientChangesMode;
    patient_changes_cutoff_hours: number;
    /** Clinic Pro's own branding (lib/white-label). */
    white_label: boolean;
    wa_connected: boolean;
    suspended: boolean;
  };
};

/** The booking rules a move follows: the visit's own link, else the clinic's first one. */
export type VisitRules = {
  slug: string | null;
  min_notice_min: number;
  max_days_ahead: number;
  slot_granularity_min: number;
};

const DEFAULT_RULES: VisitRules = { slug: null, min_notice_min: 120, max_days_ahead: 30, slot_granularity_min: 30 };

async function loadRow(c: PoolClient, appointmentId: string, lock = false): Promise<VisitRow | null> {
  const r = (
    await c.query(
      `select a.id, a.clinic_id, a.patient_id, a.doctor_member_id, a.service_id, a.starts_at, a.ends_at, a.status,
              a.patient_moves, a.booking_link_id, a.room_id, a.meeting_url,
              array_remove(array[a.service_id] || coalesce((select array_agg(e.service_id order by e.sort)
                                                             from appointment_extra_services e
                                                            where e.appointment_id = a.id), '{}'), null)::text[] as service_ids,
              ${VISIT_BOOKABLE_SQL("a")} as bookable,
              appointment_service_names(a.id, false) as service_name,
              appointment_service_names(a.id, true) as service_name_ar,
              du.full_name as doctor_name,
              -- Their own number, or their family contact's for a child with none (0127).
              p.full_name as patient_name, patient_reach_phone(p.id) as patient_phone,
              json_build_object(
                'name', cl.name, 'name_ar', cl.name_ar, 'slug', cl.slug, 'logo_path', cl.logo_path,
                'brand_color', cl.brand_color, 'address', cl.address, 'address_ar', cl.address_ar,
                'phone_e164', cl.phone_e164, 'wa_number', ws.phone_number, 'google_maps_url', cl.google_maps_url,
                'timezone', cl.timezone, 'default_locale', cl.default_locale,
                'working_hours', cl.working_hours, 'blocked_dates', cl.blocked_dates,
                'patient_changes', ${patientChangesSql()}, 'white_label', ${whiteLabelSql()}, 'patient_changes_cutoff_hours', cl.patient_changes_cutoff_hours,
                'wa_connected', coalesce(ws.status = 'connected', false),
                'suspended', cl.subscription_status = 'suspended' or cl.deleted_at is not null
              ) as clinic
         from appointments a
         join patients p on p.id = a.patient_id
         join clinics cl on cl.id = a.clinic_id
         left join whatsapp_sessions ws on ws.clinic_id = a.clinic_id
         left join clinic_members dm on dm.id = a.doctor_member_id
         left join users du on du.id = dm.user_id
        where a.id = $1
        ${lock ? "for update of a" : ""}`,
      [appointmentId]
    )
  ).rows[0];
  return (r as VisitRow) ?? null;
}

/** The appointment a link names, once the link is proven to be its own. */
export async function visitFromToken(c: PoolClient, token: string, lock = false): Promise<VisitRow | null> {
  const id = visitTokenAppointment(token);
  if (!id) return null;
  const row = await loadRow(c, id, lock);
  if (!row || row.clinic.suspended) return null;
  if (!verifyVisitToken(token, row.id, row.patient_id)) return null;
  return row;
}

export function rightsOf(v: VisitRow, now = Date.now()): VisitRights {
  return visitRights({
    mode: v.clinic.patient_changes,
    cutoffHours: v.clinic.patient_changes_cutoff_hours,
    status: v.status,
    startsAt: v.starts_at,
    moves: v.patient_moves,
    bookable: v.bookable,
    now,
  });
}

export async function rulesOf(c: PoolClient, v: Pick<VisitRow, "clinic_id" | "booking_link_id">): Promise<VisitRules> {
  const r = (
    await c.query(
      `select slug, min_notice_min, max_days_ahead, slot_granularity_min from booking_links
        where clinic_id = $1 and active
        order by (id = $2::uuid) desc nulls last, created_at
        limit 1`,
      [v.clinic_id, v.booking_link_id]
    )
  ).rows[0];
  return r ? (r as VisitRules) : DEFAULT_RULES;
}

/**
 * The slot engine's question for this visit: the same services, the same
 * doctor (or any, when nobody was assigned), and the visit itself left out of
 * the busy scan so it does not stand in its own way.
 */
function slotOpts(v: VisitRow, rules: VisitRules, minNoticeMin: number): AvailabilityOpts {
  return {
    clinicId: v.clinic_id,
    tz: v.clinic.timezone,
    clinicHours: v.clinic.working_hours,
    blockedDates: v.clinic.blocked_dates ?? [],
    serviceId: v.service_ids[0],
    extraServiceIds: v.service_ids.slice(1),
    doctorMemberId: v.doctor_member_id,
    minNoticeMin,
    granularityMin: rules.slot_granularity_min,
    linkDoctorIds: [],
    excludeAppointmentId: v.id,
  };
}

export async function visitDayCounts(c: PoolClient, v: VisitRow): Promise<Record<string, number>> {
  const rules = await rulesOf(c, v);
  const today = DateTime.now().setZone(v.clinic.timezone).startOf("day");
  return computeDayCounts(c, {
    ...slotOpts(v, rules, rules.min_notice_min),
    fromISO: today.toISODate()!,
    days: Math.min(rules.max_days_ahead, 60),
  });
}

export async function visitSlots(c: PoolClient, v: VisitRow, dateISO: string) {
  const rules = await rulesOf(c, v);
  const day = DateTime.fromISO(dateISO, { zone: v.clinic.timezone });
  const last = DateTime.now().setZone(v.clinic.timezone).startOf("day").plus({ days: rules.max_days_ahead });
  if (!day.isValid || day > last) return [];
  const slots = await computeSlots(c, { ...slotOpts(v, rules, rules.min_notice_min), dateISO });
  // The time it already has is not "another time".
  const own = new Date(v.starts_at).getTime();
  return slots.filter((s) => Date.parse(s.startISO) !== own).map((s) => ({ startISO: s.startISO, doctorMemberId: s.doctorMemberId }));
}

/* -------------------------------------------------------------------------
   Words for the messages
   ------------------------------------------------------------------------- */

function whenText(at: Date | string, tz: string, lang: "ar" | "en"): string {
  const local = DateTime.fromJSDate(new Date(at)).setZone(tz).setLocale(lang === "en" ? "en-GB" : "ar-JO-u-nu-latn");
  return `${local.toFormat("cccc d LLLL")} · ${local.toFormat("h:mm a")}`;
}

function messageVars(v: VisitRow, lang: "ar" | "en", at: Date | string, link: string): Record<string, string> {
  const first = v.patient_name.trim().split(/\s+/)[0] || v.patient_name;
  return {
    "patient.first_name": first,
    "patient.name": v.patient_name,
    "clinic.name": lang === "en" ? v.clinic.name : v.clinic.name_ar || v.clinic.name,
    "appointment.service": (lang === "ar" ? v.service_name_ar : null) || v.service_name || "",
    "appointment.doctor": v.doctor_name ?? "",
    "appointment.when": whenText(at, v.clinic.timezone, lang),
    link,
  };
}

/* -------------------------------------------------------------------------
   Move
   ------------------------------------------------------------------------- */

export type MoveResult =
  | { ok: true; startISO: string; endISO: string; rights: VisitRights }
  | { error: "not_found" | "not_allowed" | "slot_taken" | "bad_time"; why?: VisitRights["why"] };

export async function moveVisit(token: string, startISO: string, lang: "ar" | "en"): Promise<MoveResult> {
  const id = visitTokenAppointment(token);
  if (!id) return { error: "not_found" };
  return withSystem(async (c) => {
    const head = (await c.query(`select clinic_id from appointments where id = $1`, [id])).rows[0];
    if (!head) return { error: "not_found" };
    // Before the free/busy scan, as every booking path does — see lockClinicSchedule.
    await lockClinicSchedule(c, head.clinic_id);
    const v = await visitFromToken(c, token, true);
    if (!v) return { error: "not_found" };
    const rights = rightsOf(v);
    if (!rights.move) return { error: "not_allowed", why: rights.why };

    const start = DateTime.fromISO(startISO);
    if (!start.isValid || start <= DateTime.now()) return { error: "bad_time" };
    if (start.toMillis() === new Date(v.starts_at).getTime()) {
      return { ok: true, startISO: new Date(v.starts_at).toISOString(), endISO: new Date(v.ends_at).toISOString(), rights };
    }

    /*
      A time the page would offer, asked of the same engine under the lock. The
      notice is relaxed by a quarter of an hour, so a patient who looked at the
      times for a minute is not told the earliest one has gone.
    */
    const rules = await rulesOf(c, v);
    const tz = v.clinic.timezone;
    const day = start.setZone(tz).startOf("day");
    const lastDay = DateTime.now().setZone(tz).startOf("day").plus({ days: rules.max_days_ahead });
    if (day > lastDay) return { error: "slot_taken" };
    const offered = await computeSlots(c, {
      ...slotOpts(v, rules, Math.max(0, rules.min_notice_min - 15)),
      dateISO: day.toISODate()!,
    });
    const match = offered.find((s) => Date.parse(s.startISO) === start.toMillis());
    if (!match) return { error: "slot_taken" };

    /*
      The visit keeps its own length — the desk may have made it longer than
      its services — so the doctor is checked over the whole of it, not only
      the services' total the engine looked at.
    */
    const length = new Date(v.ends_at).getTime() - new Date(v.starts_at).getTime();
    const startUtc = start.toUTC().toISO()!;
    const endUtc = start.plus({ milliseconds: length }).toUTC().toISO()!;
    const doctor = match.doctorMemberId ?? v.doctor_member_id;
    if (doctor) {
      const clash = await c.query(
        `select 1 from appointments where clinic_id = $1 and doctor_member_id = $2 and status in ${HOLDS_SLOT}
            and starts_at < $4 and ends_at > $3 and id <> $5 limit 1`,
        [v.clinic_id, doctor, startUtc, endUtc, v.id]
      );
      if (clash.rowCount) return { error: "slot_taken" };
    }

    // The room: the one it had if still free, else one that suits every service.
    let roomId: string | null = null;
    const services = (
      await c.query(`select id, location_kind from services where id = any($1::uuid[])`, [v.service_ids])
    ).rows as { id: string; location_kind: string | null }[];
    const rooms = await loadActiveRooms(c, v.clinic_id);
    const suitable = suitableRoomsForAll(rooms, services);
    if (suitable.length) {
      const pick = await pickRoom(c, {
        clinicId: v.clinic_id,
        serviceId: v.service_ids[0],
        doctorMemberId: doctor,
        startsAt: startUtc,
        endsAt: endUtc,
        excludeId: v.id,
        preferRoomId: v.room_id,
        rooms,
        suitable,
      });
      if (pick.reason === "none_free") return { error: "slot_taken" };
      roomId = pick.roomId;
    }

    await c.query(
      `update appointments set starts_at = $2, ends_at = $3, doctor_member_id = $4, room_id = $5,
              patient_moves = patient_moves + 1
        where id = $1`,
      [v.id, startUtc, endUtc, doctor, roomId]
    );
    await audit(c, {
      clinicId: v.clinic_id,
      userId: null,
      action: "appointment.patient_move",
      entity: "appointment",
      entityId: v.id,
      detail: { from: new Date(v.starts_at).toISOString(), to: startUtc },
    });
    /*
      The desk's own event, with nobody as the actor and the patient named as
      the one who did it. Its key is the desk's, so a drag and a patient move in
      the same minute are one event about where the visit ended up.
    */
    await emitTrigger(
      c,
      v.clinic_id,
      "appointment_rescheduled",
      {
        appointmentId: v.id,
        patientId: v.patient_id,
        actorUserId: null,
        previousStartsAt: new Date(v.starts_at).toISOString(),
        previousDoctorMemberId: v.doctor_member_id,
        byPatient: true,
      },
      `appointment_rescheduled:${v.id}`,
      5
    );

    const after: VisitRow = { ...v, starts_at: new Date(startUtc), ends_at: new Date(endUtc), patient_moves: v.patient_moves + 1 };
    const nextRights = rightsOf(after);
    if (v.clinic.wa_connected && v.patient_phone) {
      const link = nextRights.cancel || nextRights.move ? visitUrl(v.id, v.patient_id) : "";
      const m = await systemMessage(c, {
        clinicId: v.clinic_id,
        key: "visit_moved",
        lang,
        vars: messageVars(after, lang, startUtc, link),
      });
      if (m.enabled && m.body) {
        await queueWhatsAppMessage(c, {
          clinicId: v.clinic_id,
          phoneE164: v.patient_phone,
          senderKind: "system",
          body: m.body,
          patientId: v.patient_id,
        });
      }
    }
    return { ok: true, startISO: startUtc, endISO: endUtc, rights: nextRights };
  });
}

/* -------------------------------------------------------------------------
   Cancel
   ------------------------------------------------------------------------- */

export const CANCEL_REASONS = ["cant_make_it", "feel_better", "booked_elsewhere", "other"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export type CancelResult =
  | { ok: true; bookUrl: string | null }
  | { error: "not_found" | "not_allowed"; why?: VisitRights["why"] };

export async function cancelVisit(token: string, reason: string | null, lang: "ar" | "en"): Promise<CancelResult> {
  const id = visitTokenAppointment(token);
  if (!id) return { error: "not_found" };
  return withSystem(async (c) => {
    const v = await visitFromToken(c, token, true);
    if (!v) return { error: "not_found" };
    const rights = rightsOf(v);
    if (!rights.cancel) return { error: "not_allowed", why: rights.why };

    const r = await applyAppointmentStatus(c, {
      clinicId: v.clinic_id,
      appointmentId: v.id,
      status: "cancelled",
      actorUserId: null,
      onlyFrom: ["pending_approval", "scheduled", "confirmed"],
      byPatient: true,
      cancelReason: reason && (CANCEL_REASONS as readonly string[]).includes(reason) ? reason : null,
    });
    if (!r.ok) return { error: "not_allowed", why: "closed" };
    await audit(c, {
      clinicId: v.clinic_id,
      userId: null,
      action: "appointment.patient_cancel",
      entity: "appointment",
      entityId: v.id,
      detail: { reason },
    });

    const rules = await rulesOf(c, v);
    const bookUrl = rules.slug ? `${appUrl()}/book/${rules.slug}` : null;
    if (v.clinic.wa_connected && v.patient_phone) {
      const m = await systemMessage(c, {
        clinicId: v.clinic_id,
        key: "visit_cancelled",
        lang,
        vars: messageVars(v, lang, v.starts_at, bookUrl ?? ""),
      });
      if (m.enabled && m.body) {
        await queueWhatsAppMessage(c, {
          clinicId: v.clinic_id,
          phoneE164: v.patient_phone,
          senderKind: "system",
          body: m.body,
          patientId: v.patient_id,
        });
      }
    }
    return { ok: true, bookUrl };
  });
}

/* -------------------------------------------------------------------------
   Sending the link
   ------------------------------------------------------------------------- */

/**
 * Queues the patient's link to one visit on WhatsApp — reception's "Send
 * change/cancel link", and the booking page's "Already booked?". The caller
 * has already checked who may ask; this checks only that there is something a
 * link can do and somewhere to send it.
 */
export async function sendVisitLink(
  c: PoolClient,
  appointmentId: string,
  opts: { lang?: "ar" | "en"; senderUserId?: string | null }
): Promise<{ ok: true; url: string } | { error: "not_found" | "off" | "closed" | "no_phone" | "wa_offline" }> {
  const v = await loadRow(c, appointmentId);
  if (!v || v.clinic.suspended) return { error: "not_found" };
  if (v.clinic.patient_changes === "off") return { error: "off" };
  const rights = rightsOf(v);
  if (rights.why === "closed" || rights.why === "past") return { error: "closed" };
  if (!v.patient_phone) return { error: "no_phone" };
  if (!v.clinic.wa_connected) return { error: "wa_offline" };
  const lang = opts.lang ?? (v.clinic.default_locale === "en" ? "en" : "ar");
  const url = visitUrl(v.id, v.patient_id);
  const m = await systemMessage(c, {
    clinicId: v.clinic_id,
    key: "visit_link",
    lang,
    vars: messageVars(v, lang, v.starts_at, url),
  });
  await queueWhatsAppMessage(c, {
    clinicId: v.clinic_id,
    phoneE164: v.patient_phone,
    senderKind: opts.senderUserId ? "staff" : "system",
    senderUserId: opts.senderUserId ?? null,
    body: m.body,
    patientId: v.patient_id,
  });
  return { ok: true, url };
}
