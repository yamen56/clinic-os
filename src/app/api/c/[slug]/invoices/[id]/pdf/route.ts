import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { renderUrlToPdf } from "@/lib/pdf";
import { saveFile, readFileBuffer } from "@/lib/storage";

/** On-demand branded PDF for an invoice (cached in storage after first render). */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;

  const inv = await inClinic(g.access, async (c) => {
    const r = await c.query(
      `select id, number, public_token, pdf_path, updated_at from invoices where id = $1 and clinic_id = $2`,
      [id, g.access.clinicId]
    );
    return r.rows[0] ?? null;
  });
  if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let pdf: Buffer | null = null;
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
