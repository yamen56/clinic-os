import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { openFile } from "@/lib/storage";
import { fileResponseHeaders } from "@/lib/download";
import { renderPrescriptionPdf } from "@/lib/prescription-pdf";
import { rxNumber } from "@/lib/prescriptions";

/**
 * A prescription's PDF, for printing or keeping.
 *
 * Gated on `patients`, not on writing prescriptions: a prescription already in
 * the file is part of the record, like an x-ray in Files, and the desk that
 * reprints one for a patient at the counter is doing its ordinary job.
 *
 * Served inline so Print opens it in the browser's viewer, ready for the print
 * dialog; `?download` saves it instead. A prescription whose render failed at
 * the time is rendered now — the record exists, and the PDF is only its copy.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const { access } = g;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const rx = await inClinic(access, async (c) => {
    const r = await c.query(`select number, pdf_path from prescriptions where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
    ]);
    return r.rows[0] as { number: number; pdf_path: string | null } | undefined;
  });
  if (!rx) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let path = rx.pdf_path;
  if (!path) {
    path = await renderPrescriptionPdf(access.clinicId, id, rx.number);
    if (!path) return NextResponse.json({ error: "render_failed" }, { status: 502 });
    await inClinic(access, (c) =>
      c.query(`update prescriptions set pdf_path = $3 where id = $1 and clinic_id = $2 and pdf_path is null`, [
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
      fileName: `${rxNumber(rx.number)}.pdf`,
      size: f.size,
      wantsDownload: new URL(req.url).searchParams.has("download"),
    }),
  });
}
