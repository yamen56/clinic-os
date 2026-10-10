import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { openFile } from "@/lib/storage";
import sharp from "sharp";
import { fileResponseHeaders } from "@/lib/download";
import { auditView } from "@/lib/audit";
import { can } from "@/lib/auth";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string; fileId: string }> }) {
  const { slug, fileId } = await ctx.params;

  if (!isUuid(fileId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;

  const meta = await inClinic(g.access, async (c) => {
    const r = await c.query(
      `select storage_path, file_name, mime_type, patient_id, kind from patient_files where id = $1 and clinic_id = $2`,
      [fileId, g.access.clinicId]
    );
    /*
      A card photo is answered as missing for somebody without Insurance — the
      page never lists it for them, so an id they hold came from somewhere else,
      and "not found" says no more than that.
    */
    const row = r.rows[0] && (r.rows[0].kind !== "insurance_card" || can(g.access, "insurance")) ? r.rows[0] : null;
    /*
      An x-ray or a lab result leaving the server is a read of the record like
      opening the file is. Deduplicated per person and file an hour, because the
      same route draws the thumbnails on the patient's Files tab.
    */
    if (row) {
      await auditView(c, {
        clinicId: g.access.clinicId,
        userId: g.access.session.user.id,
        impersonatedBy: g.access.session.impersonatedBy,
        action: "patient.file.view",
        entity: "patient_file",
        entityId: fileId,
        detail: { patientId: row.patient_id },
      });
    }
    return row;
  });
  if (!meta) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const f = await openFile(meta.storage_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });

  /*
    A tile for the Files gallery: 360 pixels, as JPEG. A panoramic x-ray is
    several megabytes, and a patient's Files can hold dozens of them; the
    full picture is fetched only when it is opened.
  */
  if (new URL(req.url).searchParams.has("thumb") && /^image\/(png|jpe?g|webp|gif|bmp|tiff)$/.test(meta.mime_type)) {
    try {
      const thumb = await sharp(f.data).rotate().resize({ width: 360, height: 360, fit: "inside", withoutEnlargement: true }).flatten({ background: "#0b0d12" }).jpeg({ quality: 80 }).toBuffer();
      return new NextResponse(new Uint8Array(thumb), {
        headers: { "Content-Type": "image/jpeg", "Content-Length": String(thumb.length), "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
      });
    } catch {
      // Not a picture sharp can read: the file itself, as before.
    }
  }

  // The stored mime came from the uploader's browser, so it decides nothing on
  // its own — see lib/download.
  return new NextResponse(new Uint8Array(f.data), {
    headers: fileResponseHeaders({
      declaredType: meta.mime_type,
      fileName: meta.file_name,
      size: f.size,
      wantsDownload: new URL(req.url).searchParams.has("download"),
    }),
  });
}
