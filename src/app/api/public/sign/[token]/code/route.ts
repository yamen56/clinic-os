import { NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { withSystem } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/booking-public";
import { resolveIn } from "@/lib/esign/public";
import { queueWhatsAppMessage } from "@/lib/outbound";
import { logDocEvent } from "@/lib/esign/events";

/**
 * The optional WhatsApp code.
 *
 * Off for every clinic unless one turns it on. It exists because some clinics
 * will eventually be told by a lawyer or an insurer that they need a second
 * factor, and building it later would mean revisiting the whole signing flow.
 * Nothing surfaces it in the UI until the setting is on.
 *
 * `POST` with no body sends a code; `POST { code }` verifies one. Verification
 * lives on the signer row, so a verified signer stays verified if they reload.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ip = clientIp(req);
  const body = await req.json().catch(() => ({}) as { code?: string });
  const isVerify = typeof body.code === "string" && body.code.trim().length > 0;

  if (!rateLimit(`sign-code:${ip}`, isVerify ? 20 : 4, 10 * 60_000)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  const result = await withSystem(async (c) => {
    const view = await resolveIn(c, token, { countAttempt: false });
    if (!view.document || !view.signer) return { ok: false, error: "not_found", status: 404 };
    if (view.state !== "needs_code" && view.state !== "ready") {
      return { ok: false, error: view.state, status: 410 };
    }

    const doc = (
      await c.query(`select clinic_id, language, title from documents where id = $1`, [
        view.document.id,
      ])
    ).rows[0];
    const signer = (
      await c.query(`select phone_e164 from document_signers where id = $1`, [view.signer.id])
    ).rows[0];
    if (!signer?.phone_e164) return { ok: false, error: "no_phone", status: 409 };

    if (!isVerify) {
      const code = String(randomInt(100000, 999999));
      await c.query(
        `insert into booking_verifications (clinic_id, phone_e164, code, payload, expires_at)
         values ($1, $2, $3, $4, now() + interval '10 minutes')`,
        [
          doc.clinic_id,
          signer.phone_e164,
          code,
          JSON.stringify({ kind: "document", signerId: view.signer.id }),
        ]
      );
      await queueWhatsAppMessage(c, {
        clinicId: doc.clinic_id,
        phoneE164: signer.phone_e164,
        senderKind: "system",
        body:
          doc.language === "ar"
            ? `${code} هو رمز تأكيد توقيعك.`
            : `${code} is your signing verification code.`,
      });
      await logDocEvent(c, {
        clinicId: doc.clinic_id,
        documentId: view.document.id,
        signerId: view.signer.id,
        type: "otp_sent",
        actorKind: "system",
        ip,
      });
      return { ok: true, status: 200 };
    }

    const v = (
      await c.query(
        `select * from booking_verifications
         where clinic_id = $1 and phone_e164 = $2 and verified_at is null
           and payload->>'signerId' = $3
         order by created_at desc limit 1 for update`,
        [doc.clinic_id, signer.phone_e164, view.signer.id]
      )
    ).rows[0];
    if (!v) return { ok: false, error: "no_code", status: 409 };
    if (new Date(v.expires_at) < new Date()) return { ok: false, error: "expired_code", status: 410 };
    if (v.attempts >= 5) return { ok: false, error: "too_many", status: 429 };
    if (v.code !== body.code!.trim()) {
      await c.query(`update booking_verifications set attempts = attempts + 1 where id = $1`, [v.id]);
      return { ok: false, error: "wrong_code", status: 422 };
    }

    await c.query(`update booking_verifications set verified_at = now() where id = $1`, [v.id]);
    await c.query(`update document_signers set otp_verified_at = now() where id = $1`, [
      view.signer.id,
    ]);
    await logDocEvent(c, {
      clinicId: doc.clinic_id,
      documentId: view.document.id,
      signerId: view.signer.id,
      type: "otp_verified",
      actorKind: "signer",
      ip,
    });
    return { ok: true, status: 200 };
  });

  return NextResponse.json(
    { ok: result.ok, error: "error" in result ? result.error : undefined },
    { status: result.status }
  );
}
