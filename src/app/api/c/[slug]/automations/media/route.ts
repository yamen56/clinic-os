import path from "node:path";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { apiClinic } from "@/lib/clinic-api";
import { saveFile } from "@/lib/storage";

/**
 * A photo or PDF an automation's message will carry — the aftercare sheet
 * after an extraction, the clinic's map, a price list.
 *
 * A route rather than part of the save action because server actions stop at
 * a 1 MB body. The automations capability is checked before the body is read.
 * What comes back is a storage path; the save action re-checks it is this
 * clinic's and in this folder, and reads the kind off the extension written
 * here — the browser never gets to say what the file is.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "automations");
  if (!g.ok) return g.res;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "badMedia" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "mediaTooLarge" }, { status: 413 });

  const type = (file.type || "").toLowerCase();
  const base = path.parse(file.name).name.replace(/[/\\]/g, "").slice(0, 80) || "file";
  const buf = Buffer.from(await file.arrayBuffer());

  if (IMAGE_TYPES.includes(type)) {
    /*
      Every photo leaves as a JPEG of at most 2048px with its metadata gone, as
      campaign photos do: a picture taken in the clinic carries the phone's GPS
      position, and this one goes to every patient the flow reaches.
    */
    let out: Buffer;
    try {
      const img = sharp(buf);
      const { format } = await img.metadata();
      if (!format || !["jpeg", "png", "webp"].includes(format)) {
        return NextResponse.json({ error: "mediaType" }, { status: 415 });
      }
      out = await img
        .rotate()
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
    } catch {
      return NextResponse.json({ error: "badMedia" }, { status: 400 });
    }
    const name = `${base}.jpg`;
    const saved = await saveFile(g.access.clinicId, "automation-media", name, out);
    return NextResponse.json({ path: saved.storagePath, name, kind: "image", mime: "image/jpeg" });
  }

  if (type === "application/pdf") {
    // Sent as it arrived, so it has to be what it says it is.
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return NextResponse.json({ error: "mediaType" }, { status: 415 });
    }
    const name = `${base}.pdf`;
    const saved = await saveFile(g.access.clinicId, "automation-media", name, buf);
    return NextResponse.json({ path: saved.storagePath, name, kind: "document", mime: "application/pdf" });
  }

  return NextResponse.json({ error: "mediaType" }, { status: 415 });
}
