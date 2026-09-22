import { NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { withSystem } from "@/lib/db";
import { loadPublicLink, clientIp } from "@/lib/booking-public";
import { rateLimitShared } from "@/lib/rate-limit-shared";
import { normalizePhone } from "@/lib/phone";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { systemMessage } from "@/lib/system-messages";
import { questionsForService, validateAnswers } from "@/lib/booking-intake";
import { finalizeBooking } from "../finalize";
import { readJsonCapped } from "@/lib/public-guard";

/**
 * Step 1 of public booking: validate details, then either send a WhatsApp OTP
 * (clinic connected) or book directly (clinic offline — flagged for staff).
 */
export async function POST(req: Request, ctx: { params: Promise<{ bslug: string }> }) {
  const { bslug } = await ctx.params;
  const ip = clientIp(req);
  if (!(await rateLimitShared(`start:${bslug}:${ip}`, 8, 10 * 60_000))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const data = await loadPublicLink(bslug);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // 64 KB: the intake answers are the only part with any size to them, and the
  // largest sensible set of them is a few hundred bytes. Unbounded, this was a
  // way to make the process buffer as much as an attacker cared to send.
  const read = await readJsonCapped<{
    serviceId?: string;
    doctorId?: string | null;
    startISO?: string;
    fullName?: string;
    phone?: string;
    locale?: string;
    answers?: Record<string, unknown>;
    consent?: boolean;
  }>(req, 64 * 1024);
  if (!read.ok) return read.res;
  const body = read.body;
  const { serviceId, doctorId, startISO, fullName } = body;
  if (!serviceId || !startISO || !fullName?.trim() || !body.phone) {
    return NextResponse.json({ error: "missing" }, { status: 400 });
  }
  if (!data.services.some((s) => s.id === serviceId)) {
    return NextResponse.json({ error: "bad_service" }, { status: 400 });
  }
  /*
    And the doctor, against the same list the page was allowed to draw.

    The service was already checked here; the doctor was not, so a link
    restricted to one doctor could be booked with any other member of the
    clinic by sending a different id — the restriction was enforced only by the
    page that renders it. Same principle as the intake answers below: the form
    is public, so what the browser sent proves nothing.
  */
  if (doctorId && !data.doctors.some((d) => d.id === doctorId)) {
    return NextResponse.json({ error: "bad_doctor" }, { status: 400 });
  }
  const phone = normalizePhone(body.phone);
  if (!phone) return NextResponse.json({ error: "invalid_phone" }, { status: 422 });

  /*
    The intake questions are re-checked here against the clinic's own rows.
    The form is public, so what the browser rendered proves nothing: a required
    question the page chose not to draw is still required, and a choice list
    still only accepts the clinic's own options.
  */
  if (data.link.require_consent && body.consent !== true) {
    return NextResponse.json({ error: "consent_required" }, { status: 422 });
  }
  const applicable = questionsForService(data.questions, serviceId);
  const checked = validateAnswers(applicable, body.answers);
  if ("error" in checked) {
    return NextResponse.json(checked, { status: 422 });
  }

  /*
    Also limit per number, not just per caller. Every call here sends a WhatsApp
    message to whatever number was typed, so an IP limit alone still allows one
    visitor to send a stranger a burst of codes — from the clinic's own number,
    against the clinic's daily cap. Three codes in ten minutes is more than a
    real booking needs.
  */
  if (!(await rateLimitShared(`start-phone:${phone}`, 3, 10 * 60_000))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const payload = {
    serviceId,
    doctorId: doctorId ?? null,
    startISO,
    fullName: fullName.trim().slice(0, 80),
    locale: (body.locale === "en" ? "en" : "ar") as "ar" | "en",
    // Carried through the OTP round trip already validated, so the code path
    // that finalises never has to trust the browser a second time.
    answers: checked.answers,
  };

  /*
    Two ways a booking skips the code, and they are not the same event.

    The clinic turned verification off for this link — a decision about a page
    they hand out at the desk or run in an ad, made knowing the number is then
    whatever was typed. Or the clinic's WhatsApp is disconnected, in which case
    no code *can* be sent and refusing the booking would lose a patient over a
    fault they did not cause.

    Which one it was is carried into the appointment's note rather than dropped,
    because only one of them is worth a member of staff looking into.

    The link setting is read here rather than trusted from the browser: the page
    labels its own button from the same setting, but a public form proves
    nothing, and a posted flag asking to skip verification is exactly the thing
    an attacker would send.
  */
  const phoneCheck = !data.clinic.wa_connected
    ? "wa_offline"
    : !data.link.require_otp
      ? "otp_off"
      : null;
  if (phoneCheck) {
    const result = await finalizeBooking(data, phone, payload, phoneCheck);
    if ("error" in result) return NextResponse.json(result, { status: 409 });
    return NextResponse.json({ skipVerify: true, ...result });
  }

  const code = String(randomInt(100000, 999999));
  const verificationId = await withSystem(async (c) => {
    const r = await c.query(
      `insert into booking_verifications (clinic_id, phone_e164, code, payload, expires_at)
       values ($1, $2, $3, $4, now() + interval '10 minutes') returning id`,
      [data.clinic.id, phone, code, JSON.stringify(payload)]
    );
    const msg = await systemMessage(c, {
      clinicId: data.clinic.id,
      key: "booking_otp",
      lang: payload.locale,
      vars: {
        code,
        "clinic.name":
          payload.locale === "en" ? data.clinic.name : data.clinic.name_ar || data.clinic.name,
      },
    });
    await queueWhatsAppMessage(c, {
      clinicId: data.clinic.id,
      phoneE164: phone,
      senderKind: "system",
      body: msg.body,
    });
    return r.rows[0].id as string;
  });

  return NextResponse.json({ verificationId });
}
