import { NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { withSystem } from "@/lib/db";
import { loadPublicLink, rateLimit, clientIp } from "@/lib/booking-public";
import { normalizePhone } from "@/lib/phone";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { systemMessage } from "@/lib/system-messages";
import { finalizeBooking } from "../finalize";

/**
 * Step 1 of public booking: validate details, then either send a WhatsApp OTP
 * (clinic connected) or book directly (clinic offline — flagged for staff).
 */
export async function POST(req: Request, ctx: { params: Promise<{ bslug: string }> }) {
  const { bslug } = await ctx.params;
  const ip = clientIp(req);
  if (!rateLimit(`start:${bslug}:${ip}`, 8, 10 * 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const data = await loadPublicLink(bslug);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: {
    serviceId?: string;
    doctorId?: string | null;
    startISO?: string;
    fullName?: string;
    phone?: string;
    locale?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const { serviceId, doctorId, startISO, fullName } = body;
  if (!serviceId || !startISO || !fullName?.trim() || !body.phone) {
    return NextResponse.json({ error: "missing" }, { status: 400 });
  }
  if (!data.services.some((s) => s.id === serviceId)) {
    return NextResponse.json({ error: "bad_service" }, { status: 400 });
  }
  const phone = normalizePhone(body.phone);
  if (!phone) return NextResponse.json({ error: "invalid_phone" }, { status: 422 });

  /*
    Also limit per number, not just per caller. Every call here sends a WhatsApp
    message to whatever number was typed, so an IP limit alone still allows one
    visitor to send a stranger a burst of codes — from the clinic's own number,
    against the clinic's daily cap. Three codes in ten minutes is more than a
    real booking needs.
  */
  if (!rateLimit(`start-phone:${phone}`, 3, 10 * 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const payload = {
    serviceId,
    doctorId: doctorId ?? null,
    startISO,
    fullName: fullName.trim().slice(0, 80),
    locale: (body.locale === "en" ? "en" : "ar") as "ar" | "en",
  };

  // Clinic WhatsApp offline → book unverified rather than losing the patient
  if (!data.clinic.wa_connected) {
    const result = await finalizeBooking(data, phone, payload, false);
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
