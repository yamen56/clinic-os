import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/booking-public";
import { resolveIn } from "@/lib/esign/public";
import { notifyClinicStaff } from "@/lib/notify";
import { logDocEvent } from "@/lib/esign/events";

/**
 * "Ask for a new link", from an expired or revoked one.
 *
 * It notifies staff rather than minting a link itself. A dead link should not be
 * able to resurrect itself — that would make expiry meaningless — but a patient
 * holding one must still have a way forward, and telling the clinic is it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ip = clientIp(req);
  if (!rateLimit(`sign-request:${ip}`, 6, 30 * 60_000)) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }

  await withSystem(async (c) => {
    // Resolves even for a dead token — that is the whole point here.
    const view = await resolveIn(c, token, { countAttempt: false });
    if (!view.document || !view.signer) return;

    const row = (
      await c.query(`select clinic_id from documents where id = $1`, [view.document.id])
    ).rows[0];
    if (!row) return;
    const clinicId = row.clinic_id as string;
    const slug = (await c.query(`select slug from clinics where id = $1`, [clinicId])).rows[0]?.slug;

    await notifyClinicStaff(c, clinicId, {
      kind: "document_new_link",
      title: `${view.signer.displayName} asked for a new signing link`,
      body: view.document.title,
      url: `/c/${slug}/documents/${view.document.id}`,
      roles: ["owner", "receptionist"],
    });
    await logDocEvent(c, {
      clinicId,
      documentId: view.document.id,
      signerId: view.signer.id,
      type: "reminder_sent",
      actorKind: "signer",
      ip,
      metadata: { requestedNewLink: true },
    });
  });

  // Always the same answer: whether a token exists is not something an unknown
  // caller gets to learn.
  return NextResponse.json({ ok: true });
}
