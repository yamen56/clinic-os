import { DateTime } from "luxon";
import { withSystem } from "./db";
import { appUrl } from "../src/lib/urls";
import { notifyClinicStaff } from "../src/lib/notify";
import { systemMessageTemplate, renderSystemMessage } from "../src/lib/system-messages";

/**
 * Turning a cancelled appointment back into a booked one.
 *
 * A slot that frees up is money that evaporates quietly: nobody is told, the
 * hour passes empty, and the patients who would gladly have taken it are the
 * ones already asking reception to call if anything opens. This is that call,
 * made automatically and within seconds rather than whenever somebody remembers.
 *
 * The offer is a booking link, not a reservation. That matters:
 *
 *   - Whoever books first gets it, and the booking race safety already proven in
 *     `qa-booking-race` guarantees exactly one of them can. The others meet the
 *     wizard's ordinary "that slot has gone" path, which is a sentence they
 *     understand rather than an error.
 *   - Nothing is held for anybody, so a patient who never replies costs the
 *     clinic nothing and blocks nobody.
 *   - We never have to parse "yes" out of a WhatsApp reply in Arabic, English,
 *     or the mixture of the two people actually write.
 */

/** How many people are told about one freed slot. */
const OFFER_FANOUT = Number(process.env.WAITLIST_FANOUT || 5);

/**
 * How long before the same person may be offered another slot.
 *
 * Several appointments can be cancelled in one sitting — reception working
 * through a day that a doctor has called in sick for — and without this the top
 * of the waitlist would get a message for every one of them within a minute.
 * That is indistinguishable from spam to the patient and to WhatsApp.
 */
const OFFER_COOLDOWN_MINUTES = Number(process.env.WAITLIST_COOLDOWN_MIN || 180);

type FreedSlot = {
  clinicId: string;
  appointmentId: string;
  doctorMemberId: string | null;
  serviceId: string | null;
  startsAt: string;
};

/**
 * Offers a freed slot to the people waiting for it.
 *
 * Matching is deliberately generous on the entry's side and strict on the
 * slot's: an entry naming no doctor will take any doctor, but an entry naming
 * this doctor is preferred, and an entry whose date window excludes the slot is
 * not a match at all. Returns how many were told.
 */
export async function offerFreedSlot(slot: FreedSlot): Promise<number> {
  return withSystem(async (c) => {
    const clinic = (
      await c.query(
        `select id, name, name_ar, slug, timezone, default_locale from clinics where id = $1`,
        [slot.clinicId]
      )
    ).rows[0];
    if (!clinic) return 0;

    /*
      A link to book with. Prefer one tied to this doctor, so the patient lands
      on the right person's calendar rather than choosing from all of them; fall
      back to any active link. With no link at all there is nothing to offer —
      the clinic has not published online booking, and inventing a URL would send
      people to a 404.
    */
    const link = (
      await c.query(
        `select slug from booking_links
          where clinic_id = $1 and active
          order by (doctor_member_id is not distinct from $2) desc, created_at
          limit 1`,
        [slot.clinicId, slot.doctorMemberId]
      )
    ).rows[0];
    if (!link) {
      console.log(`[waitlist ${clinic.slug}] slot freed but the clinic has no booking link`);
      return 0;
    }

    const local = DateTime.fromISO(slot.startsAt, { zone: "utc" }).setZone(clinic.timezone);
    const slotDate = local.toISODate();

    /*
      Who to tell. Ordered by how well they match before how long they have
      waited: somebody waiting for this exact doctor should hear before somebody
      who said "anyone", and among equals the person who has waited longest goes
      first. The cooldown and the status filter are what stop this being a blast.
    */
    const candidates = await c.query(
      `select w.id, w.patient_id, p.full_name, p.phone_e164
         from waitlist_entries w
         join patients p on p.id = w.patient_id
        where w.clinic_id = $1
          and w.status = 'waiting'
          and p.phone_e164 is not null and p.phone_e164 <> ''
          and p.merged_into is null
          and (w.doctor_member_id is null or w.doctor_member_id = $2)
          and (w.service_id is null or $3::uuid is null or w.service_id = $3)
          and (w.earliest_date is null or w.earliest_date <= $4::date)
          and (w.latest_date is null or w.latest_date >= $4::date)
          and (w.last_offered_at is null
               or w.last_offered_at < now() - ($5::text || ' minutes')::interval)
        order by (w.doctor_member_id is not null) desc, w.created_at
        limit $6`,
      [
        slot.clinicId,
        slot.doctorMemberId,
        slot.serviceId,
        slotDate,
        String(OFFER_COOLDOWN_MINUTES),
        OFFER_FANOUT,
      ]
    );
    if (!candidates.rowCount) return 0;

    const ar = clinic.default_locale !== "en";
    const clinicName = (ar ? clinic.name_ar || clinic.name : clinic.name) as string;
    const when = local.setLocale(ar ? "ar" : "en").toFormat("cccc d LLLL, h:mm a");
    const url = `${appUrl()}/book/${link.slug}`;

    /*
      The clinic's wording, fetched once for the whole fan-out rather than once
      per candidate — only the patient's name differs between them.

      A clinic that has switched the offer message off has switched offering off:
      there is no other way a waitlist entry reaches a patient. Checked before
      the loop so nothing is marked as offered — the entries keep their place,
      and no cooldown starts running against a message never sent.
    */
    const lang = ar ? "ar" : "en";
    const offer = await systemMessageTemplate(c, slot.clinicId, "waitlist_offer", lang);
    if (!offer.enabled) return 0;

    for (const cand of candidates.rows) {
      const first = String(cand.full_name ?? "").trim().split(/\s+/)[0] || "";
      const body = renderSystemMessage(offer.template, {
        "patient.first_name": first,
        "clinic.name": clinicName,
        "appointment.when": when,
        link: url,
      });

      /*
        Straight into `messages` as queued, exactly as an automation does, so the
        send goes through the same rails: the daily cap, the quiet-hours window,
        the blast guard and the delivery receipt. A waitlist offer is precisely
        the kind of message that must not bypass those.
      */
      const conv = await c.query(
        `insert into conversations (clinic_id, phone_e164, patient_id)
         values ($1, $2, $3)
         on conflict (clinic_id, phone_e164)
         do update set patient_id = coalesce(conversations.patient_id, excluded.patient_id)
         returning id`,
        [slot.clinicId, cand.phone_e164, cand.patient_id]
      );
      await c.query(
        `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body, status)
         values ($1, $2, 'out', 'system', 'text', $3, 'queued')`,
        [slot.clinicId, conv.rows[0].id, body]
      );
      await c.query(
        `update conversations set last_message_at = now(), last_message_preview = $2,
                last_message_direction = 'out' where id = $1`,
        [conv.rows[0].id, body.slice(0, 120)]
      );
      await c.query(
        `update waitlist_entries
            set status = 'offered', last_offered_at = now(), offers_sent = offers_sent + 1
          where id = $1`,
        [cand.id]
      );
    }

    console.log(
      `[waitlist ${clinic.slug}] offered ${local.toISO()} to ${candidates.rowCount} patient(s)`
    );
    return candidates.rowCount;
  });
}

/**
 * Closes a waitlist entry when the patient actually books.
 *
 * Without this the offer worked and nothing knew. The entry stayed 'offered',
 * the cooldown expired, it returned to 'waiting', and the next cancellation
 * offered another slot to somebody who had already taken one — which reads to
 * the patient as a clinic that is not paying attention.
 *
 * Any live entry for that patient is closed, not only one matching the doctor:
 * somebody waiting for an earlier appointment has got one, and what they asked
 * for has happened.
 */
export async function closeWaitlistOnBooking(
  clinicId: string,
  appointmentId: string
): Promise<void> {
  await withSystem(async (c) => {
    const appt = (
      await c.query(
        `select patient_id, starts_at from appointments where id = $1 and clinic_id = $2`,
        [appointmentId, clinicId]
      )
    ).rows[0];
    if (!appt) return;

    const closed = await c.query(
      `update waitlist_entries
          set status = 'booked', booked_appointment_id = $3
        where clinic_id = $1 and patient_id = $2 and status in ('waiting', 'offered')
        returning id, (status = 'offered') as was_offered`,
      [clinicId, appt.patient_id, appointmentId]
    );
    if (!closed.rowCount) return;

    const info = (
      await c.query(
        `select cl.slug, cl.timezone, p.full_name
           from clinics cl, patients p where cl.id = $1 and p.id = $2`,
        [clinicId, appt.patient_id]
      )
    ).rows[0];
    if (!info) return;

    const when = DateTime.fromJSDate(new Date(appt.starts_at as string))
      .setZone(info.timezone)
      .setLocale("ar")
      .toFormat("cccc d LLLL, h:mm a");
    /*
      Worth telling reception: a slot they thought was empty is now filled, and
      the person who filled it came off the waitlist rather than by phone.
    */
    await notifyClinicStaff(c, clinicId, {
      kind: "waitlist_booked",
      title: `حجز من قائمة الانتظار — ${info.full_name}`,
      body: when,
      url: `/c/${info.slug}/calendar`,
      dedupeKey: `waitlist_booked:${appointmentId}`,
    });
    await c.query(
      `insert into jobs (clinic_id, kind, payload, dedupe_key)
       values ($1, 'trigger:waitlist_booked', $2, $3)
       on conflict (dedupe_key) do nothing`,
      [
        clinicId,
        JSON.stringify({ patientId: appt.patient_id, appointmentId }),
        `waitlist_booked:${appointmentId}`,
      ]
    );
    console.log(`[waitlist ${info.slug}] ${closed.rowCount} entr(ies) closed by a booking`);
  });
}

/**
 * Returns offered entries to the queue once their offer has gone cold.
 *
 * Without this an offer nobody acted on would park the entry in 'offered'
 * forever, and that patient would silently never be told about another slot —
 * the failure being invisible, which is the worst kind. They go back to
 * 'waiting' and are eligible again at the next cancellation.
 */
export async function requeueStaleOffers(): Promise<void> {
  await withSystem(async (c) => {
    const r = await c.query(
      `update waitlist_entries
          set status = 'waiting'
        where status = 'offered'
          and last_offered_at < now() - ($1::text || ' minutes')::interval
        returning id`,
      [String(OFFER_COOLDOWN_MINUTES)]
    );
    if (r.rowCount) console.log(`[waitlist] ${r.rowCount} offer(s) went cold, back on the list`);
  });
}

/**
 * Closes entries whose window has passed.
 *
 * A waitlist that keeps people on it after the date they were waiting for is
 * worse than none: reception reads it as live demand and the patient gets an
 * offer for a slot they no longer want.
 */
export async function expirePastWaitlist(): Promise<void> {
  await withSystem(async (c) => {
    const r = await c.query(
      `update waitlist_entries
          set status = 'expired'
        where status in ('waiting', 'offered')
          and latest_date is not null
          and latest_date < current_date
        returning id`
    );
    if (r.rowCount) console.log(`[waitlist] expired ${r.rowCount} entr(ies) past their window`);
  });
}
