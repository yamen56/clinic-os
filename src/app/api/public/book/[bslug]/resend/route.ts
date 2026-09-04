import { NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { withSystem } from "@/lib/db";
import { loadPublicLink, rateLimit, clientIp } from "@/lib/booking-public";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { systemMessage } from "@/lib/system-messages";
import type { BookingPayload } from "../finalize";
import { readJsonCapped } from "@/lib/public-guard";

/**
 * Send the code again.
 *
 * The only recovery a patient had before this was to go back a step and retype
 * their number, which re-runs the whole start path — and the per-number limit
 * there then reads as "you are blocked" rather than "wait a moment". Resending
 * issues a fresh code against the details already captured, so a message that
 * arrived late, or not at all, costs one tap.
 *
 * The new code supersedes the old one: the row is replaced rather than reused,
 * so a code read off a screenshot minutes later cannot still be live.
 */
export async function POST(req: Request, ctx: { params: Promise<{ bslug: string }> }) {
  const { bslug } = await ctx.params;
  const ip = clientIp(req);
  if (!rateLimit(`resend:${bslug}:${ip}`, 6, 10 * 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const data = await loadPublicLink(bslug);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const read = await readJsonCapped<{ verificationId?: string }>(req, 4 * 1024);
  if (!read.ok) return read.res;
  const body = read.body;
  if (!body.verificationId) return NextResponse.json({ error: "missing" }, { status: 400 });
  if (!data.clinic.wa_connected) {
    return NextResponse.json({ error: "not_available" }, { status: 409 });
  }

  const out = await withSystem(async (c) => {
    const v = (
      await c.query(
        `select id, phone_e164, payload, verified_at from booking_verifications
         where id = $1 and clinic_id = $2`,
        [body.verificationId, data.clinic.id]
      )
    ).rows[0];
    if (!v || v.verified_at) return { error: "not_found" as const };

    // Per number, not per caller: every resend sends a WhatsApp message from the
    // clinic's own number and counts against its daily cap.
    if (!rateLimit(`resend-phone:${v.phone_e164}`, 3, 10 * 60_000)) {
      return { error: "rate_limited" as const };
    }

    const code = String(randomInt(100000, 999999));
    const nv = await c.query(
      `insert into booking_verifications (clinic_id, phone_e164, code, payload, expires_at)
       values ($1, $2, $3, $4, now() + interval '10 minutes') returning id`,
      [data.clinic.id, v.phone_e164, code, JSON.stringify(v.payload)]
    );
    // Retire the previous attempt so only one code is ever live per booking.
    await c.query(
      `update booking_verifications set expires_at = now() where id = $1 and verified_at is null`,
      [v.id]
    );

    const lang = (v.payload as BookingPayload).locale === "en" ? "en" : "ar";
    const msg = await systemMessage(c, {
      clinicId: data.clinic.id,
      key: "booking_otp",
      lang,
      vars: {
        code,
        "clinic.name": lang === "en" ? data.clinic.name : data.clinic.name_ar || data.clinic.name,
      },
    });
    await queueWhatsAppMessage(c, {
      clinicId: data.clinic.id,
      phoneE164: v.phone_e164,
      senderKind: "system",
      body: msg.body,
    });
    return { verificationId: nv.rows[0].id as string };
  });

  if ("error" in out) {
    return NextResponse.json(out, { status: out.error === "rate_limited" ? 429 : 400 });
  }
  return NextResponse.json(out);
}
