import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * File storage adapter. Local disk today; the API mirrors an object store
 * (save → key, open by key) so swapping to S3/Supabase Storage stays contained here.
 */

const ROOT = path.resolve(process.cwd(), process.env.STORAGE_DIR || "./storage");

function safeName(name: string): string {
  return name.replace(/[^\w.\-؀-ۿ ]+/g, "_").slice(0, 120) || "file";
}

export async function saveFile(
  clinicId: string,
  folder: string,
  fileName: string,
  data: Buffer
): Promise<{ storagePath: string; sizeBytes: number }> {
  const rel = path.posix.join(clinicId, folder, `${randomUUID().slice(0, 8)}-${safeName(fileName)}`);
  const abs = path.join(ROOT, rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, data);
  return { storagePath: rel, sizeBytes: data.length };
}

export function openFile(storagePath: string): { stream: fs.ReadStream; size: number } | null {
  const abs = path.join(ROOT, storagePath);
  // Guard against traversal outside the storage root
  if (!abs.startsWith(ROOT)) return null;
  if (!fs.existsSync(abs)) return null;
  const size = fs.statSync(abs).size;
  return { stream: fs.createReadStream(abs), size };
}

export async function readFileBuffer(storagePath: string): Promise<Buffer | null> {
  const abs = path.join(ROOT, storagePath);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs)) return null;
  return fs.promises.readFile(abs);
}

export async function deleteFile(storagePath: string): Promise<void> {
  const abs = path.join(ROOT, storagePath);
  if (!abs.startsWith(ROOT)) return;
  await fs.promises.rm(abs, { force: true });
}

export function storageUsageBytes(clinicId?: string): number {
  const dir = clinicId ? path.join(ROOT, clinicId) : ROOT;
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total;
}
