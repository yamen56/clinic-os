import { DateTime } from "luxon";
import { withSystem } from "@/lib/db";
import { findOrCreatePatient } from "@/lib/patients";
import { lockClinicSchedule } from "@/lib/appointments";
import { loadActiveRooms, pickRoom, suitableRoomsForAll } from "@/lib/rooms";
import { computeSlots } from "@/lib/slots";
import { setExtraServices } from "@/lib/appointment-services";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { systemMessage } from "@/lib/system-messages";
import { notifyClinicStaff } from "@/lib/notify";
import { emitTrigger } from "@/lib/triggers";
import { applyAnswersToPatient, answersSummary, type IntakeAnswer } from "@/lib/booking-intake";
import type { PublicLink } from "@/lib/booking-public";
import { dictFor } from "@/lib/i18n/client-dict";
import { applyVocabulary } from "@/lib/i18n/vocab";

export type BookingPayload = {
  serviceId: string;
  /** The services after the first, on a link that lets a patient choose several (0106). */
  extraServiceIds?: string[];
  doctorId: string | null;
  startISO: string;
  fullName: string;
  locale: "ar" | "en";
  /** Already validated against the clinic's questions before it got here. */
  answers?: IntakeAnswer[];
  /** The consent the link asked for: when it was given, and the words shown. */
  consent?: { at: string; text: string } | null;
};

/**
 * How the number on this booking came to be trusted, or not.
 *
 * Two different things now produce an unverified number, and collapsing them
 * into one boolean would put the wrong explanation in front of staff. Turning
 * the code off is a decision the clinic made about this link; WhatsApp being
 * disconnected is a fault that happened to this booking. Whoever opens the
 * appointment needs to know which, because only one of them is worth chasing.
 */
export type PhoneCheck = "verified" | "otp_off" | "wa_offline";

/** What an unverified booking says on its file, in the clinic's own diary. */
const UNVERIFIED_NOTE: Record<Exclude<PhoneCheck, "verified">, string> = {
  wa_offline: "Booked while WhatsApp was offline — number not verified.",
  otp_off: "Booked without a code — this link does not ask for WhatsApp verification.",
};

/**
 * Creates the patient (identity rule) + appointment, queues the WhatsApp
 * confirmation, and notifies staff. Used by both the OTP and offline paths.
 */
export async function finalizeBooking(
  data: PublicLink,
  phone: string,
  p: BookingPayload,
  phoneCheck: PhoneCheck
): Promise<
  | { error?: string }
  | { appointmentId: string; startISO: string; status: string; meetingUrl: string | null }
> {
  return withSystem(async (c) => {
    // Before the free/busy scan, so the slot this booking picks cannot be taken
    // by a simultaneous one between the check and the insert.
    await lockClinicSchedule(c, data.clinic.id);

    /*
      Every service the visit is for, the first one first. One the clinic has
      switched off since the page was drawn takes the whole booking with it:
      a visit is not booked for half of what was asked.
    */
    const serviceIds = [...new Set([p.serviceId, ...(p.extraServiceIds ?? [])])];
    const found = (
      await c.query(
        `select id, name, name_ar, duration_min, location_kind from services
          where id = any($1::uuid[]) and clinic_id = $2 and active`,
        [serviceIds, data.clinic.id]
      )
    ).rows as { id: string; name: string; name_ar: string | null; duration_min: number; location_kind: string | null }[];
    const services = serviceIds.map((id) => found.find((s) => s.id === id));
    if (services.some((s) => !s)) return { error: "bad_service" };
    const all = services as NonNullable<(typeof services)[number]>[];
    const service = all[0];

    const start = DateTime.fromISO(p.startISO);
    if (!start.isValid || start < DateTime.now()) return { error: "slot_taken" };
    const end = start.plus({ minutes: all.reduce((n, s) => n + Number(s.duration_min), 0) });

    /*
      Is this a time the page would offer?

      Asked of the same engine that drew the page, under the lock, on the day
      in question — so the answer covers everything the page's times already
      respect and this insert never checked: the clinic's hours and the
      doctor's, closed dates, how far ahead the link books, the buffer after a
      visit, a doctor who does the service, and a room for it. Until now a
      request that named any future instant was booked if the doctor happened
      to be free then: three in the morning, or a day the clinic is shut.

      The notice period is not re-applied. A patient who picked the earliest
      time and then spent four minutes finding a WhatsApp code would be told
      their time had gone.

      The doctor: the patient's own, the one a single-doctor link names, or
      whoever the engine finds free among those the link offers.
    */
    const tz = data.clinic.timezone;
    const day = start.setZone(tz).startOf("day");
    const lastDay = DateTime.now().setZone(tz).startOf("day").plus({ days: data.link.max_days_ahead });
    if (day > lastDay) return { error: "slot_taken" };
    const offered = await computeSlots(c, {
      clinicId: data.clinic.id,
      tz,
      clinicHours: data.clinic.working_hours,
      blockedDates: data.clinic.blocked_dates,
      serviceId: service.id,
      extraServiceIds: serviceIds.slice(1),
      doctorMemberId:
        p.doctorId ?? (data.link.doctor_member_ids.length === 1 ? data.link.doctor_member_ids[0] : null),
      dateISO: day.toISODate()!,
      minNoticeMin: 0,
      granularityMin: data.link.slot_granularity_min,
      linkDoctorIds: data.link.doctor_member_ids,
    });
    const match = offered.find((s) => Date.parse(s.startISO) === start.toMillis());
    if (!match) return { error: "slot_taken" };
    const chosen = match.doctorMemberId;

    /*
      The room (migration 0078): the doctor's usual one, or the one they are
      already working in that day, before the clinic's own order — pickRoom's
      preferences, which the scan above does not apply. `suitable` is empty
      when rooms do not limit these services, and then there is no room.
    */
    const startUtc = start.toUTC().toISO()!;
    const endUtc = end.toUTC().toISO()!;
    const rooms = await loadActiveRooms(c, data.clinic.id);
    const suitable = suitableRoomsForAll(rooms, all);
    let roomId: string | null = null;
    if (suitable.length) {
      const pick = await pickRoom(c, {
        clinicId: data.clinic.id,
        serviceId: service.id,
        doctorMemberId: chosen,
        startsAt: startUtc,
        endsAt: endUtc,
        rooms,
        suitable,
      });
      roomId = pick.roomId ?? match.roomId;
    }

    /*
      A demo booking is a prospect, not a customer.

      Everywhere else on the platform somebody who books online is a patient the
      clinic now has, and 'active' is right. In the workspace that sells the
      product they are a clinic that has agreed to look at it — filing them as
      Subscribed on the strength of a calendar invite would make the only
      pipeline signal there is permanently wrong, and wrong in the flattering
      direction, which is the worst kind.
    */
    const patient = await findOrCreatePatient(c, data.clinic.id, {
      phone,
      fullName: p.fullName,
      source: "booking_link",
      status: data.clinic.vocabulary === "agency" ? "lead" : "active",
    });
    if (patient.created) {
      await emitTrigger(c, data.clinic.id, "patient_created", {
        patientId: patient.id,
        source: "booking_link",
      });
    }

    const answers = p.answers ?? [];
    const status = data.link.approval_mode === "approval" ? "pending_approval" : "confirmed";

    /*
      The room this meeting happens in, copied off the host rather than pointed
      at them. A host who changes their standing room next year must not
      silently rewrite where last month's meeting was — the confirmation we sent
      on WhatsApp and the calendar invite the customer saved both already name a
      URL, and the record has to keep agreeing with the two artefacts that have
      already left the building.
    */
    // Online only when every service is: one of them in person and the patient comes in.
    const meetingUrl =
      all.every((s) => s.location_kind === "online") && chosen
        ? ((
            await c.query(`select meeting_url from clinic_members where id = $1`, [chosen])
          ).rows[0]?.meeting_url as string | null) ?? null
        : null;

    const appt = await c.query(
      // Which link it came through is kept (0106), so the visit can say so.
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source, notes, intake_answers, meeting_url, booking_consent, room_id, booking_link_id)
       values ($1, $2, $3, $4, $5, $6, $7, 'booking_link', $8, $9::jsonb, $10, $11::jsonb, $12, $13) returning id`,
      [
        data.clinic.id,
        patient.id,
        chosen,
        service.id,
        startUtc,
        endUtc,
        status,
        phoneCheck === "verified" ? "" : UNVERIFIED_NOTE[phoneCheck],
        // Stringified, or a JS array reaches jsonb as a Postgres array literal.
        JSON.stringify(answers),
        meetingUrl,
        p.consent ? JSON.stringify(p.consent) : null,
        roomId,
        data.link.id,
      ]
    );
    const appointmentId = appt.rows[0].id as string;
    if (all.length > 1) {
      await setExtraServices(c, data.clinic.id, appointmentId, service.id, all.slice(1).map((s) => s.id));
    }

    /*
      The patient file is updated after the appointment exists, and only where
      it is blank — see `applyAnswersToPatient`. A booking form is a good source
      of a birth date nobody had, and a bad source of one staff already checked
      against an ID card.
    */
    if (answers.length) {
      await applyAnswersToPatient(c, data.clinic.id, patient.id, data.rawQuestions, answers);
    }

    const local = start.setZone(tz).setLocale(p.locale === "en" ? "en-GB" : "ar-JO-u-nu-latn");
    const when = `${local.toFormat("cccc d LLLL")} · ${local.toFormat("h:mm a")}`;
    const clinicName = p.locale === "en" ? data.clinic.name : data.clinic.name_ar || data.clinic.name;
    // Every service, as the patient chose them: "Cleaning + Whitening".
    const namesIn = (lang: "ar" | "en") => all.map((s) => (lang === "en" ? s.name : s.name_ar || s.name)).join(" + ");
    const serviceName = namesIn(p.locale);
    const doctorName = data.doctors.find((d) => d.id === chosen)?.name;


    const confirm = await systemMessage(c, {
      clinicId: data.clinic.id,
      key: status === "confirmed" ? "booking_confirmed" : "booking_pending",
      lang: p.locale,
      vars: {
        "patient.first_name": p.fullName.trim().split(/\s+/)[0] || p.fullName,
        "patient.name": p.fullName,
        "clinic.name": clinicName,
        "clinic.address":
          (p.locale === "en" ? data.clinic.address : data.clinic.address_ar || data.clinic.address) ??
          "",
        "appointment.service": serviceName,
        "appointment.doctor": doctorName ?? "",
        "appointment.when": when,
        /*
          Empty for an in-person booking, and `renderSystemMessage` drops any
          line whose tokens all resolve empty — so a clinic that never holds a
          meeting online sees no change to its confirmation at all.
        */
        "appointment.join_url": meetingUrl ?? "",
      },
    });

    // `enabled` is the clinic's own switch on the automations page. A clinic
    // that greets every booking by hand, or from a flow of its own, turns this
    // off — and then nothing should go out at all, rather than a blank message.
    if (data.clinic.wa_connected && confirm.enabled) {
      await queueWhatsAppMessage(c, {
        clinicId: data.clinic.id,
        phoneE164: phone,
        senderKind: "system",
        body: confirm.body,
        patientId: patient.id,
      });
    }

    // What the patient told us goes into the notification itself. A reception
    // desk that has to open the appointment to find out it is an emergency has
    // already lost the minute the question was asked to save.
    /*
      In the clinic's own language, not always Arabic.

      This notification is stored and read by staff, so the honest language is
      the workspace's rather than the visitor's — but it was pinned to Arabic
      outright, which made every booking notification unreadable for a clinic
      running the product in English.
    */
    const staffLocale = data.clinic.default_locale === "en" ? "en" : "ar";
    const t = applyVocabulary(dictFor(staffLocale), data.clinic.vocabulary, staffLocale);
    const summary = answers.length ? answersSummary(answers, staffLocale) : "";
    await notifyClinicStaff(c, data.clinic.id, {
      kind: "booking",
      title:
        (status === "confirmed"
          ? t.notifications.bookingNew
          : t.notifications.bookingPending
        ).replace(
          "{name}",
          p.fullName
        ),
      // The services in the staff's language, like the rest of the notice — not the visitor's.
      body: `${namesIn(staffLocale)} · ${when}${summary ? `\n${summary}` : ""}`,
      // Onto the booking itself: one waiting for approval is approved from its panel.
      url: `/c/${data.clinic.slug}/calendar?open=${appointmentId}`,
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

    return { appointmentId, startISO: start.toUTC().toISO()!, status, meetingUrl };
  });
}
