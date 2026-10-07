/**
 * Small, real DICOM files for QA — Part 10, explicit VR little endian — so the
 * imaging path is exercised with what an OPG actually sends rather than with
 * a PNG renamed to .dcm. Either native 12-bit greyscale pixels, or a JPEG
 * baseline frame encapsulated the way a sensor's software stores it.
 */

type Value = string | Buffer | { us: number };
type El = { tag: [number, number]; vr: string; value: Value };

const LONG_VR = new Set(["OB", "OW", "SQ", "UN", "UT", "OF"]);
const UNDEFINED = 0xffffffff;

function encodeValue(vr: string, v: Value): Buffer {
  if (Buffer.isBuffer(v)) return v.length % 2 ? Buffer.concat([v, Buffer.from([0])]) : v;
  if (typeof v === "object") {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v.us);
    return b;
  }
  const pad = vr === "UI" ? "\0" : " ";
  return Buffer.from(v.length % 2 ? v + pad : v, "latin1");
}

function element(e: El, undefinedLength = false): Buffer {
  const data = encodeValue(e.vr, e.value);
  const head = Buffer.alloc(LONG_VR.has(e.vr) ? 12 : 8);
  head.writeUInt16LE(e.tag[0], 0);
  head.writeUInt16LE(e.tag[1], 2);
  head.write(e.vr, 4, "latin1");
  if (LONG_VR.has(e.vr)) head.writeUInt32LE(undefinedLength ? UNDEFINED : data.length, 8);
  else head.writeUInt16LE(data.length, 6);
  return Buffer.concat([head, data]);
}

function item(data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt16LE(0xfffe, 0);
  h.writeUInt16LE(0xe000, 2);
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data]);
}

export type DicomFixture = {
  sopUid: string;
  seriesUid: string;
  studyUid: string;
  patientId: string;
  patientName: string;
  modality?: string;
  description?: string;
  studyDate?: string;
  instanceNumber?: number;
  rows?: number;
  cols?: number;
  /** A JPEG to encapsulate instead of native pixels. */
  jpeg?: Buffer;
};

export function makeDicom(o: DicomFixture): Buffer {
  const rows = o.rows ?? 48;
  const cols = o.cols ?? 64;
  const ts = o.jpeg ? "1.2.840.10008.1.2.4.50" : "1.2.840.10008.1.2.1";
  const sopClass = "1.2.840.10008.5.1.4.1.1.1.1"; // Digital X-Ray Image Storage – For Presentation

  const metaBody = Buffer.concat(
    [
      { tag: [0x0002, 0x0001], vr: "OB", value: Buffer.from([0, 1]) },
      { tag: [0x0002, 0x0002], vr: "UI", value: sopClass },
      { tag: [0x0002, 0x0003], vr: "UI", value: o.sopUid },
      { tag: [0x0002, 0x0010], vr: "UI", value: ts },
      { tag: [0x0002, 0x0012], vr: "UI", value: "1.2.826.0.1.3680043.10.999" },
    ].map((e) => element(e as El))
  );
  const groupLength = Buffer.alloc(4);
  groupLength.writeUInt32LE(metaBody.length);
  const meta = Buffer.concat([element({ tag: [0x0002, 0x0000], vr: "UL", value: groupLength }), metaBody]);

  const els: El[] = [
    { tag: [0x0008, 0x0016], vr: "UI", value: sopClass },
    { tag: [0x0008, 0x0018], vr: "UI", value: o.sopUid },
    { tag: [0x0008, 0x0020], vr: "DA", value: o.studyDate ?? "20261007" },
    { tag: [0x0008, 0x0060], vr: "CS", value: o.modality ?? "PX" },
    { tag: [0x0008, 0x103e], vr: "LO", value: o.description ?? "" },
    { tag: [0x0010, 0x0010], vr: "PN", value: o.patientName },
    { tag: [0x0010, 0x0020], vr: "LO", value: o.patientId },
    { tag: [0x0020, 0x000d], vr: "UI", value: o.studyUid },
    { tag: [0x0020, 0x000e], vr: "UI", value: o.seriesUid },
    { tag: [0x0020, 0x0013], vr: "IS", value: String(o.instanceNumber ?? 1) },
    { tag: [0x0028, 0x0002], vr: "US", value: { us: 1 } },
    { tag: [0x0028, 0x0004], vr: "CS", value: "MONOCHROME2" },
    { tag: [0x0028, 0x0010], vr: "US", value: { us: rows } },
    { tag: [0x0028, 0x0011], vr: "US", value: { us: cols } },
    { tag: [0x0028, 0x0100], vr: "US", value: { us: o.jpeg ? 8 : 16 } },
    { tag: [0x0028, 0x0101], vr: "US", value: { us: o.jpeg ? 8 : 12 } },
    { tag: [0x0028, 0x0102], vr: "US", value: { us: o.jpeg ? 7 : 11 } },
    { tag: [0x0028, 0x0103], vr: "US", value: { us: 0 } },
  ];
  const body = els.filter((e) => e.value !== "").map((e) => element(e));

  if (o.jpeg) {
    const delim = Buffer.alloc(8);
    delim.writeUInt16LE(0xfffe, 0);
    delim.writeUInt16LE(0xe0dd, 2);
    body.push(
      element({ tag: [0x7fe0, 0x0010], vr: "OB", value: Buffer.alloc(0) }, true),
      item(Buffer.alloc(0)), // empty basic offset table
      item(o.jpeg.length % 2 ? Buffer.concat([o.jpeg, Buffer.from([0])]) : o.jpeg),
      delim
    );
  } else {
    // A diagonal ramp across the 12 bits: something with contrast to window.
    const px = Buffer.alloc(rows * cols * 2);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) px.writeUInt16LE(Math.round(((x + y) / (rows + cols - 2)) * 4095), 2 * (y * cols + x));
    body.push(element({ tag: [0x7fe0, 0x0010], vr: "OW", value: px }));
  }

  return Buffer.concat([Buffer.alloc(128), Buffer.from("DICM", "latin1"), meta, ...body]);
}

/** A fresh DICOM UID under the test root. */
let uidSeq = 0;
export function uid(): string {
  return `1.2.826.0.1.3680043.10.999.${Date.now()}.${process.pid}.${++uidSeq}`;
}

/** multipart/related; type="application/dicom" — what a STOW-RS sender posts. */
export function stowBody(parts: Buffer[], boundary = `clinicti-${Date.now()}`): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`, "latin1"), p, Buffer.from("\r\n", "latin1"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "latin1"));
  return { body: Buffer.concat(chunks), contentType: `multipart/related; type="application/dicom"; boundary=${boundary}` };
}
