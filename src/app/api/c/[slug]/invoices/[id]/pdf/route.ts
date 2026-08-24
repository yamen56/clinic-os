import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { renderUrlToPdf } from "@/lib/pdf";
import { saveFile, readFileBuffer } from "@/lib/storage";
import { enqueueEinvoiceSubmit } from "@/lib/einvoice/jobs";

/** On-demand branded PDF for an invoice (cached in storage after first render). */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug, "invoices");
  if (!g.ok) return g.res;

  const inv = await inClinic(g.access, async (c) => {
    const r = await c.query(
      `select id, number, public_token, pdf_path, updated_at, einvoice_status, einvoice_qr
         from invoices where id = $1 and clinic_id = $2`,
      [id, g.access.clinicId]
    );
    const row = r.rows[0];
    if (!row) return null;
    /*
      Downloading is handing the invoice over, so it is one of the moments that
      obliges the clinic to have filed it. Queued here as well as on the WhatsApp
      path, because a clinic that prints rather than messages would otherwise
      never trigger a submission at all.
    */
    if (row.einvoice_status === "not_required") {
      await enqueueEinvoiceSubmit(c, g.access.clinicId, id, "delivered");
      row.einvoice_status = (
        await c.query(`select einvoice_status from invoices where id = $1`, [id])
      ).rows[0].einvoice_status;
    }
    return row;
  });
  if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // An unstamped PDF is the document that is not compliant. Better a clear wait
  // than a file the clinic has to take back off the patient.
  if (inv.einvoice_status === "pending") {
    return NextResponse.json({ error: "einvoice_pending" }, { status: 409 });
  }

  let pdf: Buffer | null = null;
  // A cached PDF rendered before the stamp arrived would have no QR on it. The
  // submission clears `pdf_path` on success, so there is nothing to detect here.
  if (inv.pdf_path) pdf = await readFileBuffer(inv.pdf_path);
  if (!pdf) {
    const base = process.env.APP_URL || "http://localhost:3000";
    pdf = await renderUrlToPdf(`${base}/inv/${inv.public_token}?print=1`);
    const saved = await saveFile(g.access.clinicId, "invoices", `${inv.number}.pdf`, pdf);
    await inClinic(g.access, (c) =>
      c.query(`update invoices set pdf_path = $2 where id = $1`, [id, saved.storagePath])
    );
  }
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${inv.number}.pdf"`,
    },
  });
}
