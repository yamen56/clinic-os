import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { recordSignature, declineDocument, markViewed } from "@/lib/esign/signing";
import { afterSignature } from "@/lib/esign/flow";
import { notifyStaffOfSignerAction } from "@/lib/esign/delivery";
import { emitDocumentTrigger } from "@/lib/esign/jobs";
import { requestIp, requestUserAgent } from "@/lib/esign/events";
import { isLocked } from "@/lib/esign/documents";

/**
 * A signature taken on a clinic device.
 *
 * Identity rests on the staff member's attestation plus the phone number already
 * on the patient's file, so no code is asked for — the person is standing there.
 * What the record keeps instead is who handed the device over: the signer is
 * marked `signed_in_person` and the staff member is recorded as the witness.
 *
 * This is a POST under the authenticated clinic API rather than a public route
 * because the tablet is signed in as staff. That is also what lets the lock be
 * checked: the session that claimed the document must be the one submitting.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> }
) {
  const { slug, id } = await ctx.params;
  const auth = await apiClinic(slug, "documents");
  if (!auth.ok) return auth.res;
  const { access } = auth;

  let body: {
    signerId?: string;
    png?: string;
    svg?: string | null;
    typedName?: string | null;
    consentConfirmed?: boolean;
    fieldAnswers?: Record<string, unknown>;
    /** Set instead of a signature when the patient declines on the device. */
    decline?: boolean;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body.signerId) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });

  const ip = requestIp(req);
  const userAgent = requestUserAgent(req);

  const result = await inClinic(access, async (c) => {
    const doc = (
      await c.query(`select * from documents where id = $1 and clinic_id = $2`, [id, access.clinicId])
    ).rows[0];
    if (!doc) return { ok: false, error: "not_found", status: 404 };
    // Another staff member holding the lock means another tablet has this open.
    if (isLocked(doc, access.session.user.id)) {
      return { ok: false, error: "locked", status: 409 };
    }

    if (body.decline) {
      const r = await declineDocument(c, {
        clinicId: access.clinicId,
        documentId: id,
        signerId: body.signerId!,
        reason: body.reason ?? null,
        ip,
        userAgent,
        actorUserId: access.session.user.id,
      });
      if (!r.ok) return { ok: false, error: r.error ?? "not_found", status: 409 };
      await notifyStaffOfSignerAction(c, {
        clinicId: access.clinicId,
        clinicSlug: slug,
        doc: { id, title: doc.title },
        signerName: "",
        action: "declined",
        reason: body.reason ?? null,
      });
      await emitDocumentTrigger(c, access.clinicId, "document_declined", { documentId: id });
      return { ok: true, status: 200 };
    }

    if (!body.png) return { ok: false, error: "bad_signature", status: 400 };

    const signed = await recordSignature(c, {
      clinicId: access.clinicId,
      documentId: id,
      signerId: body.signerId!,
      input: {
        pngDataUrl: body.png,
        svg: body.svg ?? null,
        typedName: body.typedName ?? null,
        consentConfirmed: !!body.consentConfirmed,
        fieldAnswers: body.fieldAnswers ?? {},
      },
      ip,
      userAgent,
      inPerson: true,
      witnessUserId: access.session.user.id,
    });
    if (!signed.ok) return { ok: false, error: signed.error, status: 409 };

    // Any live link for this signer is now meaningless.
    await c.query(
      `update signing_tokens set used_at = coalesce(used_at, now()) where signer_id = $1`,
      [body.signerId]
    );

    await notifyStaffOfSignerAction(c, {
      clinicId: access.clinicId,
      clinicSlug: slug,
      doc: { id, title: doc.title },
      signerName: "",
      action: "signed",
    });
    await emitDocumentTrigger(c, access.clinicId, "document_signed", {
      documentId: id,
      signerId: body.signerId,
    });
    await afterSignature(c, {
      clinicId: access.clinicId,
      documentId: id,
      patientId: doc.patient_id,
      completed: signed.completed,
    });

    return { ok: true, completed: signed.completed, status: 200 };
  });

  return NextResponse.json(
    {
      ok: result.ok,
      error: "error" in result ? result.error : undefined,
      completed: result.ok ? result.completed : undefined,
    },
    { status: result.status }
  );
}

/** Records that the patient has the document open on the device. */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> }
) {
  const { slug, id } = await ctx.params;
  const auth = await apiClinic(slug, "documents");
  if (!auth.ok) return auth.res;
  const { access } = auth;

  const body = await req.json().catch(() => ({}) as { signerId?: string });
  if (!body.signerId) return NextResponse.json({ ok: false }, { status: 400 });

  await inClinic(access, (c) =>
    markViewed(c, {
      clinicId: access.clinicId,
      documentId: id,
      signerId: body.signerId!,
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
      opened: false,
    })
  );
  return NextResponse.json({ ok: true });
}
