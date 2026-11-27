import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { openFile } from "@/lib/storage";
import { fileResponseHeaders } from "@/lib/download";
import { renderLetterPdf } from "@/lib/letter-pdf";
import { letterNumber } from "@/lib/medical-letters";
import { auditView } from "@/lib/audit";

/**
 * A medical letter's PDF, for printing or keeping.
 *
 * Gated on `patients`, as a prescription's is: a letter already in the file is
 * part of the record, and the desk reprinting a sick leave at the counter is
 * doing its ordinary job. A letter whose render failed is rendered now.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const { access } = g;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const l = await inClinic(access, async (c) => {
    const r = await c.query(`select number, pdf_path, patient_id from medical_letters where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
    ]);
    const row = r.rows[0] as { number: number; pdf_path: string | null; patient_id: string } | undefined;
    if (row) {
      await auditView(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "letter.view",
        entity: "medical_letter",
        entityId: id,
        detail: { patientId: row.patient_id },
      });
    }
    return row;
  });
  if (!l) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let path = l.pdf_path;
  if (!path) {
    path = await renderLetterPdf(access.clinicId, id, l.number);
    if (!path) return NextResponse.json({ error: "render_failed" }, { status: 502 });
    await inClinic(access, (c) =>
      c.query(`update medical_letters set pdf_path = $3 where id = $1 and clinic_id = $2 and pdf_path is null`, [
        id,
        access.clinicId,
        path,
      ])
    );
  }

  const f = await openFile(path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });

  return new NextResponse(new Uint8Array(f.data), {
    headers: fileResponseHeaders({
      declaredType: "application/pdf",
      fileName: `${letterNumber(l.number)}.pdf`,
      size: f.size,
      wantsDownload: new URL(req.url).searchParams.has("download"),
    }),
  });
}
