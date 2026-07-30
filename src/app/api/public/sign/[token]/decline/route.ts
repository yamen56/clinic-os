import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/booking-public";
import { resolveIn } from "@/lib/esign/public";
import { declineDocument } from "@/lib/esign/signing";
import { consumeToken } from "@/lib/esign/tokens";
import { notifyStaffOfSignerAction } from "@/lib/esign/delivery";
import { emitDocumentTrigger } from "@/lib/esign/jobs";
import { requestUserAgent } from "@/lib/esign/events";

/**
 * Declining is a first-class outcome, not an error path.
 *
 * A patient who does not agree has to be able to say so without phoning the
 * clinic, and staff have to hear about it immediately — a form that silently
 * never comes back is indistinguishable from one the patient never opened.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ip = clientIp(req);
  if (!rateLimit(`sign-decline:${ip}`, 20, 10 * 60_000)) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}) as { reason?: string });
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "";
  const userAgent = requestUserAgent(req);

  const result = await withSystem(async (c) => {
    const view = await resolveIn(c, token, { countAttempt: false });
    if (!view.document || !view.signer || !view.tokenId) return { ok: false, status: 410 };
    if (view.state !== "ready" && view.state !== "needs_code") return { ok: false, status: 410 };

    const clinicRow = (
      await c.query(`select clinic_id from documents where id = $1`, [view.document.id])
    ).rows[0];
    const clinicId = clinicRow?.clinic_id as string;

    const r = await declineDocument(c, {
      clinicId,
      documentId: view.document.id,
      signerId: view.signer.id,
      reason,
      ip,
      userAgent,
    });
    if (!r.ok) return { ok: false, status: 409 };

    await consumeToken(c, view.tokenId);

    const slug = (await c.query(`select slug from clinics where id = $1`, [clinicId])).rows[0]?.slug;
    await notifyStaffOfSignerAction(c, {
      clinicId,
      clinicSlug: slug,
      doc: { id: view.document.id, title: view.document.title },
      signerName: view.signer.displayName,
      action: "declined",
      reason,
    });
    await emitDocumentTrigger(c, clinicId, "document_declined", { documentId: view.document.id });
    return { ok: true, status: 200 };
  });

  return NextResponse.json({ ok: result.ok }, { status: result.status });
}
