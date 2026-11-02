/**
 * What a machine's file is, in the clinic's words — so a patient's Files can
 * be read as "the ECGs", "the ultrasounds", "the x-rays" rather than a pile of
 * names. Decided from the machine that sent it, then from the DICOM modality
 * inside it, then from the file itself. No database here: the patient file,
 * the device API and the setup screen all share it.
 */

export const FILE_KINDS = ["xray", "photo", "ecg", "ultrasound", "scan", "report", "lab", "other"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** Every type of machine a clinic can connect, for every specialty. */
export const DEVICE_KINDS = ["xray", "opg", "cbct", "camera", "scanner", "ultrasound", "ecg", "endoscope", "eye", "monitor", "lab", "other"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** Every machine type, and what it usually sends. */
export const DEVICE_FILE_KIND: Record<DeviceKind, FileKind> = {
  xray: "xray",
  opg: "xray",
  cbct: "xray",
  camera: "photo",
  endoscope: "photo",
  eye: "scan",
  scanner: "scan",
  ultrasound: "ultrasound",
  ecg: "ecg",
  monitor: "report",
  lab: "lab",
  other: "other",
};

/** DICOM modality codes, for an image from a relay or PACS whose machine type is not known. */
const MODALITY_KIND: Record<string, FileKind> = {
  PX: "xray",
  IO: "xray",
  DX: "xray",
  CR: "xray",
  CT: "xray",
  MG: "xray",
  RF: "xray",
  XA: "xray",
  US: "ultrasound",
  ECG: "ecg",
  HD: "ecg",
  OP: "scan",
  OPT: "scan",
  OAM: "scan",
  OPM: "scan",
  XC: "photo",
  ES: "photo",
  GM: "photo",
  SM: "photo",
  DOC: "report",
  SR: "report",
};

/**
 * The kind of one file. A picture from a camera-type machine stays a photo; a
 * PDF from an ECG is an ECG; a DICOM says what it is itself when the machine
 * type does not.
 */
export function kindFor(opts: { deviceKind?: string | null; modality?: string | null; mime?: string | null; picture?: boolean }): FileKind {
  const byDevice = opts.deviceKind ? (DEVICE_FILE_KIND as Record<string, FileKind>)[opts.deviceKind] : undefined;
  // An x-ray sensor's software that also saves a PDF report: the PDF is a report, not an x-ray.
  if (byDevice && byDevice !== "other" && (opts.picture !== false || !isPictureKind(byDevice))) return byDevice;
  const byModality = opts.modality ? MODALITY_KIND[opts.modality.toUpperCase()] : undefined;
  if (byModality) return byModality;
  const mime = opts.mime ?? "";
  if (mime === "application/pdf") return "report";
  if (mime.startsWith("image/")) return "photo";
  return "other";
}

/** Pictures a browser draws — the ones a doctor's "Take x-ray" or "Take photo" can be answered with. */
export function isPictureKind(kind: string): boolean {
  return kind === "xray" || kind === "photo";
}

/**
 * What a dental picture shows, as a dentist files it (migration 0089,
 * 2026-11-02): the x-ray views, and an intraoral photo. A view says the kind
 * too — every x-ray view is an x-ray, the intraoral one a photo.
 */
export const XRAY_VIEWS = ["panoramic", "bitewing", "periapical", "occlusal", "cbct"] as const;
export const FILE_VIEWS = [...XRAY_VIEWS, "intraoral"] as const;
export type FileView = (typeof FILE_VIEWS)[number];

export function isFileView(v: unknown): v is FileView {
  return typeof v === "string" && (FILE_VIEWS as readonly string[]).includes(v);
}

/** The kind a view makes a file. */
export function kindOfView(v: FileView): FileKind {
  return v === "intraoral" ? "photo" : "xray";
}

/**
 * An x-ray's view from where it came from: a panoramic machine sends
 * panoramics, a cone beam sends CBCT, and the names imaging software gives
 * its files say the rest ("PAN_0012", "BW left", "PA 36"). Null when nothing
 * says — the doctor picks it in the viewer.
 */
export function viewFor(opts: { deviceKind?: string | null; modality?: string | null; fileName?: string | null }): FileView | null {
  if (opts.deviceKind === "opg") return "panoramic";
  if (opts.deviceKind === "cbct") return "cbct";
  if (opts.modality?.toUpperCase() === "PX") return "panoramic";
  const n = (opts.fileName ?? "").toLowerCase().replace(/[_\-.]+/g, " ");
  if (/\b(pan|opg|opt|pano|panoramic|panorama)\b/.test(n)) return "panoramic";
  if (/\b(bw|bitewing|bite wing)\b/.test(n)) return "bitewing";
  if (/\b(pa|periapical|peri)\b/.test(n)) return "periapical";
  if (/\b(cbct|cone beam|conebeam)\b/.test(n)) return "cbct";
  if (/\b(occ|occlusal)\b/.test(n)) return "occlusal";
  return null;
}

/** Machine types, the clinic's usual ones (from its specialties) first. */
export function orderedKinds(usual: readonly DeviceKind[]): DeviceKind[] {
  return [...usual, ...DEVICE_KINDS.filter((k) => !usual.includes(k))];
}
