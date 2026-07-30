import { NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { withSystem } from "@/lib/db";
import { loadPublicLink, rateLimit, clientIp } from "@/lib/booking-public";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { finalizeBooking, type BookingPayload } from "../finalize";

/** Step 2: check the WhatsApp OTP, then finalize the booking. */
export async function POST(req: Request, ctx: { params: Promise<{ bslug: string }> }) {
  const { bslug } = await ctx.params;
  const ip = clientIp(req);
  if (!rateLimit(`verify:${bslug}:${ip}`, 20, 10 * 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const data = await loadPublicLink(bslug);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { verificationId?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!body.verificationId || !body.code) {
    return NextResponse.json({ error: "missing" }, { status: 400 });
  }

  const check = await withSystem(async (c) => {
    const v = (
      await c.query(
        `select * from booking_verifications where id = $1 and clinic_id = $2 for update`,
        [body.verificationId, data.clinic.id]
      )
    ).rows[0];
    if (!v || v.verified_at) return { error: "not_found" as const };
    if (new Date(v.expires_at) < new Date()) {
      // Expired: issue a fresh code so the patient isn't stranded
      const code = String(randomInt(100000, 999999));
      const nv = await c.query(
        `insert into booking_verifications (clinic_id, phone_e164, code, payload, expires_at)
         values ($1, $2, $3, $4, now() + interval '10 minutes') returning id`,
        [data.clinic.id, v.phone_e164, code, JSON.stringify(v.payload)]
      );
      await queueWhatsAppMessage(c, {
        clinicId: data.clinic.id,
        phoneE164: v.phone_e164,
        senderKind: "system",
        body:
          (v.payload as BookingPayload).locale === "en"
            ? `${code} is your ${data.clinic.name} verification code.`
            : `${code} هو رمز التحقق الخاص بك من ${data.clinic.name_ar || data.clinic.name}.`,
      });
      return { error: "expired" as const, newVerificationId: nv.rows[0].id as string };
    }
    if (v.attempts >= 5) return { error: "too_many" as const };
    if (v.code !== body.code!.trim()) {
      await c.query(`update booking_verifications set attempts = attempts + 1 where id = $1`, [v.id]);
      return { error: "wrong_code" as const };
    }
    await c.query(`update booking_verifications set verified_at = now() where id = $1`, [v.id]);
    return { phone: v.phone_e164 as string, payload: v.payload as BookingPayload };
  });

  if ("error" in check) {
    const status = check.error === "wrong_code" ? 422 : check.error === "expired" ? 410 : 400;
    return NextResponse.json(check, { status });
  }

  const result = await finalizeBooking(data, check.phone, check.payload, true);
  if ("error" in result) return NextResponse.json(result, { status: 409 });
  return NextResponse.json(result);
}
