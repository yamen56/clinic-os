import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { saveSigningSession } from "@/lib/esign/public";

/**
 * Resume state for a signature taken on a clinic device.
 *
 * Same purpose as the public progress endpoint, different authorisation: the
 * tablet has a staff session, so there is no token to resolve. A patient who
 * puts the device down halfway through picks up where they left off.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const auth = await apiClinic(slug, "documents");
  if (!auth.ok) return auth.res;
  const { access } = auth;

  const body = await req.json().catch(
    () =>
      ({}) as {
        signerId?: string;
        step?: number;
        scrolledToEnd?: boolean;
        consent?: boolean;
        strokes?: unknown;
        fieldAnswers?: Record<string, unknown>;
      }
  );
  if (!body.signerId) return NextResponse.json({ ok: false }, { status: 400 });

  await inClinic(access, async (c) => {
    const owned = await c.query(
      `select 1 from document_signers where id = $1 and document_id = $2 and clinic_id = $3`,
      [body.signerId, id, access.clinicId]
    );
    if (!owned.rowCount) return;

    const strokes = Array.isArray(body.strokes) ? body.strokes.slice(0, 400) : null;
    await saveSigningSession(c, {
      clinicId: access.clinicId,
      documentId: id,
      signerId: body.signerId!,
      lastStep: Number(body.step ?? 1),
      scrolledToEnd: !!body.scrolledToEnd,
      consentConfirmed: !!body.consent,
      partialSignature: strokes?.length ? { strokes } : undefined,
      fieldAnswers: body.fieldAnswers ?? {},
    });
  });

  return NextResponse.json({ ok: true });
}
