/**
 * Which files in a machine's folder are results — the same rule the Bridge
 * keeps (bridge/src/folders.ts), for the browser: the Devices page watching
 * or uploading a folder, and a folder uploaded into one patient's Files.
 *
 * An x-ray program's folder, or a CD it burned, holds more than pictures: its
 * own index (DICOMDIR), Windows' thumbnails, half-written files, and on a CD
 * the whole viewer program. None of that belongs in a patient's file.
 */

/** Pictures, DICOM, and the other things machines make: scans, reports, video. */
const KNOWN = /\.(jpe?g|png|bmp|gif|webp|tiff?|dcm|dicom|pdf|stl|ply|obj|mp4)$/i;
/** DICOM exports are often named IM0001 or 1.2.840…, with no extension. */
const BARE = /^[^.]+$|^[\d.]+$/;
const SKIP = /^(~\$|\.)|\.(tmp|part|partial|crdownload|lock|db|ini|lnk)$|^thumbs\.db$|^desktop\.ini$|^dicomdir$/i;

/** Worth opening, by its name alone. A name with no extension still has to prove it is DICOM. */
export function mayBeResult(name: string): boolean {
  return !SKIP.test(name) && (KNOWN.test(name) || BARE.test(name));
}

/** A result by its name — no need to read it. */
export function isKnownResult(name: string): boolean {
  return !SKIP.test(name) && KNOWN.test(name);
}

/** "DICM" at byte 128 — a DICOM file, whatever it is called. */
export async function isDicomFile(f: File): Promise<boolean> {
  if (f.size < 132) return false;
  try {
    return (await f.slice(128, 132).text()) === "DICM";
  } catch {
    return false;
  }
}

/** The results among the files of a chosen folder. */
export async function resultsIn<T extends { file: File }>(items: T[]): Promise<T[]> {
  const out: T[] = [];
  for (const it of items) {
    if (!mayBeResult(it.file.name)) continue;
    if (isKnownResult(it.file.name) || (await isDicomFile(it.file))) out.push(it);
  }
  return out;
}

/** The folder a file sat in: "Images/Ababneh Rakan/PAN.jpg" → "Ababneh Rakan". */
export function parentFolder(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : null;
}

/** A folder's files, with the path inside it the browser reports. */
export function folderItems(list: FileList | null): { file: File; path: string }[] {
  return Array.from(list ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}
