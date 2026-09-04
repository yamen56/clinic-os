import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/booking-public";
import { resolveIn } from "@/lib/esign/public";
import { recordSignature } from "@/lib/esign/signing";
import { consumeToken } from "@/lib/esign/tokens";
import { afterSignature } from "@/lib/esign/flow";
import { notifyStaffOfSignerAction } from "@/lib/esign/delivery";
import { emitDocumentTrigger } from "@/lib/esign/jobs";
import { requestUserAgent } from "@/lib/esign/events";
import { readJsonCapped } from "@/lib/public-guard";

/**
 * Records a remote signature.
 *
 * Runs in the system context because the signer has no session — the token is
 * the authorisation, and it is resolved here again rather than trusted from the
 * page that rendered. `recordSignature` re-verifies the document hash before
 * anything is written, so a document altered between the page load and the
 * submit is refused.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ip = clientIp(req);
  if (!rateLimit(`sign-submit:${ip}`, 30, 10 * 60_000)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  /*
    4 MB, which is the sum of what the parts are allowed to be once decoded: a
    signature PNG capped at 1.5 MB (`decodeSignaturePng`), an SVG path under
    400 KB, and base64's third on top of both. Those caps run *after* the body
    is in memory, so without a ceiling here they bounded what we stored and not
    what we could be made to hold.
  */
  const read = await readJsonCapped<{
    png?: string;
    svg?: string | null;
    typedName?: string | null;
    consentConfirmed?: boolean;
    fieldAnswers?: Record<string, unknown>;
  }>(req, 4 * 1024 * 1024);
  if (!read.ok) return read.res;
  const body = read.body;
  if (!body.png) return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 400 });

  const userAgent = requestUserAgent(req);

  const result = await withSystem(async (c) => {
    const view = await resolveIn(c, token, { countAttempt: false });
    if (view.state === "needs_code") return { ok: false, error: "needs_code", status: 403 };
    if (view.state !== "ready" || !view.document || !view.signer || !view.tokenId) {
      return { ok: false, error: view.state, status: 410 };
    }

    const clinicId = (
      await c.query(`select clinic_id from documents where id = $1`, [view.document.id])
    ).rows[0]?.clinic_id as string;

    const signed = await recordSignature(c, {
      clinicId,
      documentId: view.document.id,
      signerId: view.signer.id,
      input: {
        pngDataUrl: body.png!,
        svg: body.svg ?? null,
        typedName: body.typedName ?? null,
        consentConfirmed: !!body.consentConfirmed,
        fieldAnswers: body.fieldAnswers ?? {},
      },
      ip,
      userAgent,
    });
    if (!signed.ok) return { ok: false, error: signed.error, status: 409 };

    // One signature per link, always.
    await consumeToken(c, view.tokenId);

    const slug = (await c.query(`select slug from clinics where id = $1`, [clinicId])).rows[0]?.slug;
    await notifyStaffOfSignerAction(c, {
      clinicId,
      clinicSlug: slug,
      doc: { id: view.document.id, title: view.document.title },
      signerName: view.signer.displayName,
      action: "signed",
    });
    await emitDocumentTrigger(c, clinicId, "document_signed", {
      documentId: view.document.id,
      signerId: view.signer.id,
    });
    await afterSignature(c, {
      clinicId,
      documentId: view.document.id,
      patientId: null,
      completed: signed.completed,
    });

    return { ok: true, completed: signed.completed, status: 200 };
  });

  return NextResponse.json(
    { ok: result.ok, error: "error" in result ? result.error : undefined, completed: result.ok ? result.completed : undefined },
    { status: result.status }
  );
}
