import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/booking-public";
import { resolveIn, saveSigningSession } from "@/lib/esign/public";
import { markViewed } from "@/lib/esign/signing";
import { requestUserAgent } from "@/lib/esign/events";
import { emitDocumentTrigger } from "@/lib/esign/jobs";

/**
 * Saves where a signer got to, including a half-drawn signature.
 *
 * This is what makes abandoning the link harmless: reopening it lands on the same
 * step with the same strokes on the pad. Called often, so it is cheap, tolerant,
 * and never blocks the interface — a lost ping costs one scroll.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ip = clientIp(req);
  // Generous: a slow, careful signature legitimately produces a lot of these.
  if (!rateLimit(`sign-progress:${ip}`, 400, 10 * 60_000)) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }

  let body: {
    step?: number;
    scrolledToEnd?: boolean;
    consent?: boolean;
    strokes?: unknown;
    fieldAnswers?: Record<string, unknown>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const userAgent = requestUserAgent(req);

  await withSystem(async (c) => {
    const view = await resolveIn(c, token, { countAttempt: false });
    if (view.state !== "ready" || !view.document || !view.signer) return;

    const clinicId = (
      await c.query(`select clinic_id from documents where id = $1`, [view.document.id])
    ).rows[0]?.clinic_id as string;

    // The first progress ping is also the "they opened it" event.
    await markViewed(c, {
      clinicId,
      documentId: view.document.id,
      signerId: view.signer.id,
      ip,
      userAgent,
      opened: true,
    });
    if (!view.session) {
      await emitDocumentTrigger(c, clinicId, "document_viewed", { documentId: view.document.id });
    }

    // Strokes are bounded before storage: a resumable signature is worth a few
    // kilobytes, not a few megabytes.
    const strokes = Array.isArray(body.strokes) ? body.strokes.slice(0, 400) : null;

    await saveSigningSession(c, {
      clinicId,
      documentId: view.document.id,
      signerId: view.signer.id,
      lastStep: Number(body.step ?? 1),
      scrolledToEnd: !!body.scrolledToEnd,
      consentConfirmed: !!body.consent,
      partialSignature: strokes?.length ? { strokes } : undefined,
      fieldAnswers: body.fieldAnswers ?? {},
    });
  });

  return NextResponse.json({ ok: true });
}
