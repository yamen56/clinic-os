import * as dicomParser from "dicom-parser";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import sharp from "sharp";

/**
 * DICOM, as far as a clinic's file needs it.
 *
 * An OPG, a CBCT and most digital sensors speak DICOM, and a browser draws
 * none of it. So every DICOM image that reaches a patient is kept twice: the
 * original, byte for byte, for a real viewer or the next clinic; and a PNG or
 * JPEG preview, which is what the Files tab, the chart and the x-ray viewer
 * already know how to show. Reading here is deliberately narrow — the
 * identity of the study and series, what the machine called the patient, and
 * one frame's pixels. Anything this cannot decode is still stored; it just
 * arrives without a picture.
 */

export function isDicom(buf: Buffer): boolean {
  return buf.length > 132 && buf.toString("latin1", 128, 132) === "DICM";
}

export type DicomMeta = {
  sopUid: string;
  sopClassUid: string;
  seriesUid: string;
  studyUid: string;
  modality: string;
  studyDate: string | null;
  description: string;
  bodyPart: string;
  instanceNumber: number | null;
  transferSyntax: string;
  /** What the machine called the patient — never trusted on its own. */
  patient: { id: string; name: string; birthDate: string | null };
};

export type ParsedDicom = { meta: DicomMeta; ds: dicomParser.DataSet };

const DEFLATED = "1.2.840.10008.1.2.1.99";

/** `YYYYMMDD` → `YYYY-MM-DD`, or null for anything else. */
function isoDate(da: string | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec((da ?? "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** `FAMILY^GIVEN^MIDDLE` → `GIVEN MIDDLE FAMILY`, which is how a person reads it. */
function personName(pn: string | undefined): string {
  const [family = "", given = "", middle = ""] = (pn ?? "").split("=")[0].split("^").map((s) => s.trim());
  return [given, middle, family].filter(Boolean).join(" ");
}

/** A UID made from the bytes, for the rare file that carries none. */
function derivedUid(buf: Buffer, salt: string): string {
  const h = createHash("sha256").update(salt).update(buf).digest();
  // 2.25 is the UUID-derived root; a 128-bit decimal fits the 64-char limit.
  return `2.25.${BigInt(`0x${h.subarray(0, 16).toString("hex")}`).toString(10)}`;
}

export function parseDicomFile(buf: Buffer): ParsedDicom | null {
  if (!isDicom(buf)) return null;
  let ds: dicomParser.DataSet;
  try {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    ds = dicomParser.parseDicom(bytes, {
      // A deflated data set inflates in place after its (plain) meta header.
      inflater: ((arr: Uint8Array, position: number) => {
        const inflated = inflateRawSync(Buffer.from(arr.buffer, arr.byteOffset + position, arr.length - position));
        const full = new Uint8Array(position + inflated.length);
        full.set(arr.subarray(0, position), 0);
        full.set(inflated, position);
        return full;
      }) as unknown as dicomParser.ParseDicomOptions["inflater"],
    });
  } catch {
    return null;
  }
  const s = (tag: string) => (ds.string(tag) ?? "").trim();
  const sopUid = s("x00080018") || s("x00020003") || derivedUid(buf, "sop");
  const studyUid = s("x0020000d") || derivedUid(buf, "study");
  const seriesUid = s("x0020000e") || `${studyUid}.1`;
  return {
    ds,
    meta: {
      sopUid,
      sopClassUid: s("x00080016") || s("x00020002"),
      seriesUid,
      studyUid,
      modality: s("x00080060").toUpperCase(),
      studyDate: isoDate(s("x00080020") || s("x00080021") || s("x00080022")),
      description: s("x0008103e") || s("x00081030"),
      bodyPart: s("x00180015"),
      instanceNumber: ds.intString("x00200013") ?? null,
      transferSyntax: s("x00020010") || "1.2.840.10008.1.2",
      patient: {
        id: s("x00100020"),
        name: personName(ds.string("x00100010")),
        birthDate: isoDate(s("x00100030")),
      },
    },
  };
}

export type Preview = { data: Buffer; mime: "image/png" | "image/jpeg"; ext: "png" | "jpg" };

/**
 * One frame, made viewable. For a multi-frame file the middle frame, which
 * for a volume is the slice most likely to show anatomy rather than air.
 * Returns null — never throws — for anything it cannot draw.
 */
export async function dicomPreview(p: ParsedDicom): Promise<Preview | null> {
  try {
    return await renderFrame(p);
  } catch {
    return null;
  }
}

async function renderFrame({ ds, meta }: ParsedDicom): Promise<Preview | null> {
  const px = ds.elements.x7fe00010;
  const rows = ds.uint16("x00280010") ?? 0;
  const cols = ds.uint16("x00280011") ?? 0;
  if (!px || !rows || !cols) return null;
  const spp = ds.uint16("x00280002") ?? 1;
  const photometric = (ds.string("x00280004") ?? "MONOCHROME2").trim().toUpperCase();
  const frames = Math.max(1, ds.intString("x00280008") ?? 1);
  const frame = Math.floor((frames - 1) / 2);
  const ts = meta.transferSyntax;

  if (px.encapsulatedPixelData) {
    // JPEG baseline/extended and JPEG 2000 frames are pictures in their own
    // right; sharp decodes what its build supports, and a failure is just
    // "no preview". JPEG-LS, lossless JPEG and RLE are stored, not drawn.
    if (!/^1\.2\.840\.10008\.1\.2\.4\.(50|51|90|91)$/.test(ts)) return null;
    const jpeg = /\.4\.5[01]$/.test(ts);
    const bot = px.basicOffsetTable?.length
      ? px.basicOffsetTable
      : frames > 1 && jpeg
        ? dicomParser.createJPEGBasicOffsetTable(ds, px)
        : undefined;
    const bytes =
      frames === 1 && !px.basicOffsetTable?.length
        ? dicomParser.readEncapsulatedPixelDataFromFragments(ds, px, 0, px.fragments?.length ?? 1)
        : dicomParser.readEncapsulatedImageFrame(ds, px, frame, bot);
    let img = sharp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    if (photometric === "MONOCHROME1") img = img.negate({ alpha: false });
    if (spp === 1) return { data: await img.toColourspace("b-w").png().toBuffer(), mime: "image/png", ext: "png" };
    return { data: await img.jpeg({ quality: 90 }).toBuffer(), mime: "image/jpeg", ext: "jpg" };
  }

  // Native pixels. Big-endian was retired from the standard in 2004.
  if (ts === "1.2.840.10008.1.2.2") return null;
  const bitsAllocated = ds.uint16("x00280100") ?? 8;
  if (bitsAllocated !== 8 && bitsAllocated !== 16) return null;
  const bytesPer = bitsAllocated / 8;
  const n = rows * cols;
  const frameLen = n * spp * bytesPer;
  const start = px.dataOffset + frame * frameLen;
  const src = ds.byteArray;
  if (start + frameLen > src.length) return null;
  const raw = Buffer.from(src.buffer, src.byteOffset + start, frameLen);

  if (spp === 3) {
    if (bytesPer !== 1) return null;
    const planar = ds.uint16("x00280006") ?? 0;
    const rgb = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) {
      let r: number, g: number, b: number;
      if (planar === 1) [r, g, b] = [raw[i], raw[n + i], raw[2 * n + i]];
      else [r, g, b] = [raw[3 * i], raw[3 * i + 1], raw[3 * i + 2]];
      if (photometric.startsWith("YBR_FULL")) {
        const y = r, cb = g - 128, cr = b - 128;
        [r, g, b] = [y + 1.402 * cr, y - 0.344136 * cb - 0.714136 * cr, y + 1.772 * cb];
      }
      rgb[3 * i] = clamp255(r);
      rgb[3 * i + 1] = clamp255(g);
      rgb[3 * i + 2] = clamp255(b);
    }
    const data = await sharp(rgb, { raw: { width: cols, height: rows, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    return { data, mime: "image/jpeg", ext: "jpg" };
  }
  if (spp !== 1) return null;

  // Grey: stored bits → modality values → the window → eight bits.
  const bitsStored = ds.uint16("x00280101") ?? bitsAllocated;
  const signed = ds.uint16("x00280103") === 1;
  const slope = ds.floatString("x00281053") || 1;
  const intercept = ds.floatString("x00281052") ?? 0;
  const values = new Float32Array(n);
  const mask = bitsStored >= 32 ? 0xffffffff : (1 << bitsStored) - 1;
  const shift = 32 - bitsStored;
  for (let i = 0; i < n; i++) {
    let v = bytesPer === 2 ? raw.readUInt16LE(2 * i) : raw[i];
    v = signed ? (v << shift) >> shift : v & mask;
    values[i] = v * slope + intercept;
  }

  let center = ds.floatString("x00281050");
  let width = ds.floatString("x00281051");
  if (center === undefined || !width || width <= 1) {
    // No window from the machine: the 0.5th to 99.5th percentile, so a burned-in
    // marker or a dead pixel does not flatten the whole picture to grey.
    const step = Math.max(1, Math.floor(n / 200_000));
    const sample: number[] = [];
    for (let i = 0; i < n; i += step) sample.push(values[i]);
    sample.sort((a, b) => a - b);
    const lo = sample[Math.floor(sample.length * 0.005)];
    const hi = sample[Math.max(0, Math.ceil(sample.length * 0.995) - 1)];
    center = (lo + hi) / 2;
    width = Math.max(2, hi - lo);
  }
  const lower = center - 0.5 - (width - 1) / 2;
  const range = width - 1;
  const invert = photometric === "MONOCHROME1";
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const v = clamp255(((values[i] - lower) / range) * 255);
    out[i] = invert ? 255 - v : v;
  }
  const data = await sharp(out, { raw: { width: cols, height: rows, channels: 1 } }).png({ compressionLevel: 6 }).toBuffer();
  return { data, mime: "image/png", ext: "png" };
}

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

/** Modality codes a dentist reads, in words. */
export function modalityLabel(m: string): string {
  const map: Record<string, string> = {
    PX: "Panoramic x-ray",
    IO: "Intraoral x-ray",
    DX: "X-ray",
    CR: "X-ray",
    CT: "CT",
    XC: "Photo",
    OP: "Eye photo",
    US: "Ultrasound",
    MR: "MRI",
  };
  return map[m] ?? (m || "DICOM image");
}
