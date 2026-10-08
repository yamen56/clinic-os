import { NextResponse } from "next/server";
import { deviceAuth, inDeviceClinic } from "@/lib/imaging/devices";
import { ingestImage } from "@/lib/imaging/ingest";
import { isUuid } from "@/lib/uuid";
import { isDicom } from "@/lib/imaging/dicom";

/*
  A machine sends an image.

  multipart/form-data, one `file` (any picture or DICOM — or any other file a
  machine makes: an STL scan, a PDF report) and, all
  optional:
    patient    a Clinicti patient id, or the file number ("1042", "#1042", "CLN-1042")
    requestId  the "Take x-ray" this answers (from /requests)
    teeth      "36,37", or upper / lower / mouth
    kind       xray | photo | other (defaults from the device and the file)

  With no patient and no request, a DICOM's own Patient ID is tried if the
  clinic said this machine uses Clinicti numbers, then the oldest doctor still
  waiting on an image; with none of those, the image waits in the clinic's
  imaging inbox. It is never dropped and never guessed into a stranger's file.
*/

/** A single image or DICOM instance. A CBCT goes as a series, one file a slice. */
const MAX_SIZE = 100 * 1024 * 1024;

export async function POST(req: Request) {
  const g = await deviceAuth(req);
  if (!g.ok) return g.res;
  const device = g.device;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_SIZE) return NextResponse.json({ error: "too_large", max: MAX_SIZE }, { status: 413 });
  if (!file.size) return NextResponse.json({ error: "empty" }, { status: 400 });

  const requestId = String(form!.get("requestId") ?? "").trim();
  const data = Buffer.from(await file.arrayBuffer());
  const name = file.name || "image";
  const mime = file.type || mimeFor(name);
  /*
    A picture or a DICOM is the device's kind of image; anything else — an
    intraoral scanner's STL, an ultrasound's PDF — is kept as a file, and never
    answers a doctor waiting on an x-ray: it waits to be filed unless the
    sender named the patient.
  */
  const picture = isDicom(data) || mime.startsWith("image/");
  const kindRaw = String(form!.get("kind") ?? "").trim();
  const kind =
    kindRaw === "photo" || kindRaw === "xray" || kindRaw === "other"
      ? kindRaw
      : !picture
        ? "other"
        : device.kind === "camera" || device.kind === "scanner"
          ? "photo"
          : "xray";
  const result = await ingestImage(
    {
      clinicId: device.clinicId,
      from: { device: { id: device.id, name: device.name, matchBy: device.matchBy } },
      fileName: name,
      mime,
      data,
      kind,
      teeth: String(form!.get("teeth") ?? "")
        .split(/[\s,]+/)
        .filter(Boolean),
      requestId: isUuid(requestId) ? requestId : null,
      patientRef: String(form!.get("patient") ?? "").trim() || null,
      useOpenRequest: kind !== "other",
    },
    (fn) => inDeviceClinic(device, fn)
  );

  if (result.placed === "nowhere") {
    return NextResponse.json({ error: result.error }, { status: result.error === "series_elsewhere" ? 409 : 404 });
  }
  return NextResponse.json(
    result.placed === "patient"
      ? { ok: true, placed: "patient", added: result.added, patientId: result.patientId, fileId: result.fileId, matchedBy: result.matchedBy, requestId: result.requestId }
      : { ok: true, placed: "inbox", added: result.added, inboxId: result.inboxId },
    { status: result.added === "new" ? 201 : 200 }
  );
}

/** A type for a file whose sender gave none — machines' software rarely does. */
function mimeFor(name: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    bmp: "image/bmp",
    gif: "image/gif",
    webp: "image/webp",
    tif: "image/tiff",
    tiff: "image/tiff",
    dcm: "application/dicom",
    pdf: "application/pdf",
    stl: "model/stl",
    ply: "application/octet-stream",
    obj: "model/obj",
    mp4: "video/mp4",
  };
  return map[ext] ?? "application/octet-stream";
}
