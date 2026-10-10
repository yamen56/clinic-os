import { NextResponse } from "next/server";
import { deviceAuth, inDeviceClinic } from "@/lib/imaging/devices";
import { ingestImage } from "@/lib/imaging/ingest";
import { parseDicomFile } from "@/lib/imaging/dicom";

/*
  DICOMweb STOW-RS: Clinicti as a place a DICOM sender can store to.

  Most OPG and CBCT units speak classic DICOM (C-STORE) on the clinic's own
  network, which nothing on the internet can listen to. A relay on the
  imaging PC — Orthanc is free and the usual choice — receives from the
  machine and forwards here over HTTPS with this device's key, and so does
  any PACS or imaging program that can send to a DICOMweb server. The URL to
  give it is …/api/devices/v1/dicomweb (it appends /studies).

  Every instance goes through the same ingest as a direct upload: the series
  becomes one entry in the patient's Files, matched by the machine's Patient
  ID if the clinic trusts it, else by the doctor waiting on an image, else
  into the imaging inbox.
*/

/** One request; a relay sends a large series in several. */
const MAX_BODY = 400 * 1024 * 1024;

type Part = { headers: Record<string, string>; data: Buffer };

function splitMultipart(body: Buffer, boundary: string): Part[] {
  const delim = Buffer.from(`--${boundary}`);
  const between = Buffer.from(`\r\n--${boundary}`);
  const parts: Part[] = [];
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    let start = pos + delim.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // "--": the closing delimiter
    while (body[start] === 0x20 || body[start] === 0x09) start++; // transport padding
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    const next = body.indexOf(between, start);
    if (next === -1) break;
    const part = body.subarray(start, next);
    const sep = part.indexOf("\r\n\r\n");
    const head = sep === -1 ? "" : part.subarray(0, sep).toString("latin1");
    const headers: Record<string, string> = {};
    for (const line of head.split("\r\n")) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    parts.push({ headers, data: sep === -1 ? part : part.subarray(sep + 4) });
    pos = next + 2;
  }
  return parts;
}

const uiList = (items: { cls: string; sop: string; reason?: number }[]) =>
  items.map((i) => ({
    "00081150": { vr: "UI", Value: [i.cls || "1.2.840.10008.5.1.4.1.1.7"] },
    "00081155": { vr: "UI", Value: [i.sop] },
    ...(i.reason !== undefined ? { "00081197": { vr: "US", Value: [i.reason] } } : {}),
  }));

export async function POST(req: Request, ctx: { params: Promise<{ study?: string[] }> }) {
  const g = await deviceAuth(req);
  if (!g.ok) return g.res;
  const device = g.device;
  const { study } = await ctx.params;
  const studyUid = study?.[0] ?? null;

  const ct = req.headers.get("content-type") ?? "";
  if (!/^multipart\/related/i.test(ct)) {
    return NextResponse.json({ error: "expected multipart/related; type=application/dicom" }, { status: 415 });
  }
  const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
  if (!boundary) return NextResponse.json({ error: "no_boundary" }, { status: 400 });
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return NextResponse.json({ error: "too_large", max: MAX_BODY }, { status: 413 });
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length > MAX_BODY) return NextResponse.json({ error: "too_large", max: MAX_BODY }, { status: 413 });

  const stored: { cls: string; sop: string }[] = [];
  const failed: { cls: string; sop: string; reason: number }[] = [];
  for (const part of splitMultipart(body, boundary)) {
    const type = (part.headers["content-type"] ?? "application/dicom").toLowerCase();
    if (!type.startsWith("application/dicom")) continue;
    const parsed = parseDicomFile(part.data);
    if (!parsed) {
      // 0xC000: cannot understand.
      failed.push({ cls: "", sop: "", reason: 0xc000 });
      continue;
    }
    const { meta } = parsed;
    if (studyUid && meta.studyUid !== studyUid) {
      // 0xA900: does not match the SOP class / the study the request was for.
      failed.push({ cls: meta.sopClassUid, sop: meta.sopUid, reason: 0xa900 });
      continue;
    }
    try {
      const r = await ingestImage(
        {
          clinicId: device.clinicId,
          from: { device: { id: device.id, name: device.name, matchBy: device.matchBy, kind: device.kind } },
          fileName: `${meta.sopUid}.dcm`,
          mime: "application/dicom",
          data: part.data,
          useOpenRequest: true,
        },
        (fn) => inDeviceClinic(device, fn)
      );
      if (r.placed === "nowhere") failed.push({ cls: meta.sopClassUid, sop: meta.sopUid, reason: 0xc000 });
      else stored.push({ cls: meta.sopClassUid, sop: meta.sopUid });
    } catch {
      // 0xA700: out of resources — worth the sender trying again.
      failed.push({ cls: meta.sopClassUid, sop: meta.sopUid, reason: 0xa700 });
    }
  }

  if (!stored.length && !failed.length) return NextResponse.json({ error: "no_instances" }, { status: 400 });
  const status = !failed.length ? 200 : stored.length ? 202 : 409;
  return new NextResponse(
    JSON.stringify({
      ...(stored.length ? { "00081199": { vr: "SQ", Value: uiList(stored) } } : {}),
      ...(failed.length ? { "00081198": { vr: "SQ", Value: uiList(failed) } } : {}),
    }),
    { status, headers: { "Content-Type": "application/dicom+json", "Cache-Control": "no-store" } }
  );
}
