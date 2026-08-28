import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { renderUrlToPdf } from "@/lib/pdf";
import { printKeyFor } from "@/lib/print-token";
import { appUrl } from "@/lib/urls";
import { fileResponseHeaders } from "@/lib/download";

/**
 * The patient's record, as a PDF.
 *
 * A clinic is asked for this by the patient who wants their file, by the doctor
 * they are being referred to, and occasionally by a lawyer. Until now the answer
 * was to photograph the screen.
 *
 * Rendered by the worker's Chromium from `/patient-print/<id>`, the same route
 * every other PDF in this product takes, because it is the only one that gets
 * Arabic right. The print page is reachable for five minutes with an HMAC over
 * the patient id and nothing else — no session travels to the renderer, and the
 * URL is useless by the time the download lands.
 *
 * Audited, deliberately and always. This is a medical record leaving the
 * building; who took it and when is part of the record itself.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const { access } = g;

  /*
    Confirm the patient is this clinic's before minting a key for them. The key
    names a patient id and the print page trusts it, so this is the check that
    stops one clinic exporting another's file by guessing an id.
  */
  const patient = await inClinic(access, async (c) => {
    const r = await c.query(
      `select id, full_name from patients
        where id = $1 and clinic_id = $2 and merged_into is null`,
      [id, access.clinicId]
    );
    return r.rows[0] as { id: string; full_name: string } | undefined;
  });
  if (!patient) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { exp, sig } = printKeyFor(id, "patient");
  let pdf: Buffer;
  try {
    pdf = await renderUrlToPdf(`${appUrl()}/patient-print/${id}?kind=patient&exp=${exp}&sig=${sig}`);
  } catch (e) {
    console.error("[patient export]", (e as Error).message);
    return NextResponse.json({ error: "render_failed" }, { status: 502 });
  }

  await inClinic(access, (c) =>
    audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.export",
      entity: "patient",
      entityId: id,
      detail: { bytes: pdf.length },
    })
  );

  /*
    The name is the patient's, so a folder of these is navigable. Anything that
    is not a letter, a digit or a space goes — a name with a slash in it would
    otherwise write a path, and the quotes in a filename header are the sort of
    thing that ends up being a header injection.
  */
  const safeName =
    patient.full_name.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) || "patient";

  return new NextResponse(new Uint8Array(pdf), {
    headers: fileResponseHeaders({
      declaredType: "application/pdf",
      fileName: `${safeName}.pdf`,
      size: pdf.length,
      wantsDownload: true,
    }),
  });
}
