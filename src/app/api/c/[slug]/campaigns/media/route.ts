import path from "node:path";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { apiClinic } from "@/lib/clinic-api";
import { saveFile } from "@/lib/storage";
import {
  MAX_MEDIA_BYTES,
  MEDIA_IMAGE_TYPES,
  MEDIA_VIDEO_TYPES,
  type UploadedMedia,
} from "@/app/c/[slug]/campaigns/constants";

/**
 * The photo or video a campaign will carry, uploaded before the campaign is
 * created.
 *
 * A route rather than part of createCampaignAction because server actions stop
 * at a 1 MB body and a video is up to sixteen. Membership and the campaigns
 * capability are checked before the body is read, so nobody without the right
 * to send a campaign can make this server buffer one.
 *
 * What comes back is a storage path for the create action to attach. That
 * action re-checks the path is this clinic's and in this folder, and reads the
 * kind off the extension written here — the browser never gets to say what the
 * file is.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "campaigns");
  if (!g.ok) return g.res;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "badMedia" }, { status: 400 });
  if (file.size > MAX_MEDIA_BYTES) return NextResponse.json({ error: "mediaTooLarge" }, { status: 413 });

  const type = (file.type || "").toLowerCase();
  const base = path.parse(file.name).name.slice(0, 80) || "media";
  const buf = Buffer.from(await file.arrayBuffer());

  let out: Buffer;
  let name: string;
  let kind: UploadedMedia["kind"];

  if (MEDIA_IMAGE_TYPES.includes(type)) {
    /*
      Every photo leaves as a JPEG of at most 2048px, which is what WhatsApp's
      own app does to anything it sends. Three things follow from that: one
      format every phone renders, a file sized for a chat rather than a print
      shop — it is downloaded once per recipient — and no metadata. A photo
      taken in the clinic carries the phone's GPS position, and this is about
      to be sent to several hundred people.
    */
    try {
      const img = sharp(buf);
      const { format } = await img.metadata();
      // The declared type is the browser's guess; the decoder decides.
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
    name = `${base}.jpg`;
    kind = "image";
  } else if (MEDIA_VIDEO_TYPES.includes(type)) {
    /*
      Sent as the bytes it arrived as, so it has to be what it says. An MP4
      opens with an `ftyp` box; a QuickTime file opens with one too but names
      the `qt  ` brand, and that is the renamed-.mov case the picker is there
      to keep out.
    */
    const box = buf.subarray(4, 8).toString("latin1");
    const brand = buf.subarray(8, 12).toString("latin1");
    if (box !== "ftyp" || brand === "qt  ") {
      return NextResponse.json({ error: "mediaType" }, { status: 415 });
    }
    out = buf;
    name = `${base}.mp4`;
    kind = "video";
  } else {
    return NextResponse.json({ error: "mediaType" }, { status: 415 });
  }

  const saved = await saveFile(g.access.clinicId, "campaign-media", name, out);
  return NextResponse.json({ path: saved.storagePath, name, kind } satisfies UploadedMedia);
}
