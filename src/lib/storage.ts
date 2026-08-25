import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * File storage: patient documents, clinic logos, WhatsApp media, invoice PDFs.
 *
 * Two drivers behind one API:
 *  - local disk for development
 *  - S3-compatible object storage for production (Cloudflare R2)
 *
 * A container filesystem does not survive a redeploy, so production MUST run
 * the S3 driver or every upload is lost on the next release. The driver is
 * chosen by whether S3_BUCKET is configured.
 */

const ROOT = path.resolve(process.cwd(), process.env.STORAGE_DIR || "./storage");

export type StoredFile = { data: Buffer; size: number };

function safeName(name: string): string {
  return name.replace(/[^\w.\-؀-ۿ ]+/g, "_").slice(0, 120) || "file";
}

function keyFor(clinicId: string, folder: string, fileName: string): string {
  return path.posix.join(clinicId, folder, `${randomUUID().slice(0, 8)}-${safeName(fileName)}`);
}

/** True when object storage is configured; otherwise the local driver is used. */
export function usingObjectStore(): boolean {
  return Boolean(process.env.S3_BUCKET);
}

// ---------------------------------------------------------------- S3 driver

type S3Module = typeof import("@aws-sdk/client-s3");
let s3Client: InstanceType<S3Module["S3Client"]> | null = null;
let s3Mod: S3Module | null = null;

async function s3(): Promise<{ mod: S3Module; client: InstanceType<S3Module["S3Client"]>; bucket: string }> {
  if (!s3Mod) s3Mod = await import("@aws-sdk/client-s3");
  if (!s3Client) {
    s3Client = new s3Mod.S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT,
      // R2 requires path-style addressing.
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
      },
    });
  }
  return { mod: s3Mod, client: s3Client, bucket: process.env.S3_BUCKET! };
}

// -------------------------------------------------------------- public API

/**
 * Writes a file that belongs to the deployment rather than to a clinic — a
 * database backup, not a patient's scan.
 *
 * Separate from `saveFile` because that one namespaces everything under a
 * clinic id, which is right for tenant data and wrong for this: a backup spans
 * every clinic, and filing it under one of them would make it look like theirs.
 * The name is used verbatim so a backup can be found by its date instead of
 * behind a random prefix.
 */
export async function saveSystemFile(
  folder: string,
  fileName: string,
  data: Buffer
): Promise<{ storagePath: string; sizeBytes: number }> {
  const key = path.posix.join("_system", folder, safeName(fileName));
  if (usingObjectStore()) {
    const { mod, client, bucket } = await s3();
    await client.send(new mod.PutObjectCommand({ Bucket: bucket, Key: key, Body: data }));
    return { storagePath: key, sizeBytes: data.length };
  }
  const abs = path.join(ROOT, key);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, data);
  return { storagePath: key, sizeBytes: data.length };
}

/** Lists system files under a folder, newest name last. */
export async function listSystemFiles(folder: string): Promise<string[]> {
  const prefix = path.posix.join("_system", folder) + "/";
  if (usingObjectStore()) {
    const { mod, client, bucket } = await s3();
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await client.send(
        new mod.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
      );
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out.sort();
  }
  const abs = path.join(ROOT, prefix);
  const names = await fs.promises.readdir(abs).catch(() => [] as string[]);
  return names.sort().map((n) => prefix + n);
}

export async function saveFile(
  clinicId: string,
  folder: string,
  fileName: string,
  data: Buffer
): Promise<{ storagePath: string; sizeBytes: number }> {
  const key = keyFor(clinicId, folder, fileName);

  if (usingObjectStore()) {
    const { mod, client, bucket } = await s3();
    await client.send(new mod.PutObjectCommand({ Bucket: bucket, Key: key, Body: data }));
    return { storagePath: key, sizeBytes: data.length };
  }

  const abs = path.join(ROOT, key);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, data);
  return { storagePath: key, sizeBytes: data.length };
}

export async function openFile(storagePath: string): Promise<StoredFile | null> {
  if (usingObjectStore()) {
    const { mod, client, bucket } = await s3();
    try {
      const r = await client.send(new mod.GetObjectCommand({ Bucket: bucket, Key: storagePath }));
      const bytes = await r.Body?.transformToByteArray();
      if (!bytes) return null;
      const data = Buffer.from(bytes);
      return { data, size: data.length };
    } catch {
      return null;
    }
  }

  const abs = path.join(ROOT, storagePath);
  // Guard against traversal outside the storage root
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs)) return null;
  const data = await fs.promises.readFile(abs);
  return { data, size: data.length };
}

export async function readFileBuffer(storagePath: string): Promise<Buffer | null> {
  return (await openFile(storagePath))?.data ?? null;
}

export async function deleteFile(storagePath: string): Promise<void> {
  if (usingObjectStore()) {
    const { mod, client, bucket } = await s3();
    await client
      .send(new mod.DeleteObjectCommand({ Bucket: bucket, Key: storagePath }))
      .catch(() => {});
    return;
  }
  const abs = path.join(ROOT, storagePath);
  if (!abs.startsWith(ROOT)) return;
  await fs.promises.rm(abs, { force: true });
}

export async function storageUsageBytes(clinicId?: string): Promise<number> {
  if (usingObjectStore()) {
    const { mod, client, bucket } = await s3();
    let total = 0;
    let token: string | undefined;
    do {
      const r = await client.send(
        new mod.ListObjectsV2Command({
          Bucket: bucket,
          Prefix: clinicId ? `${clinicId}/` : undefined,
          ContinuationToken: token,
        })
      );
      for (const o of r.Contents ?? []) total += o.Size ?? 0;
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return total;
  }

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

/**
 * Removes everything filed under a clinic.
 *
 * The counterpart to the purge in the worker: `delete from clinics` cascades
 * through 49 tables and leaves not one row behind, but the rows only ever held
 * *paths*. Without this the scans, the signed PDFs and the WhatsApp media of a
 * clinic that no longer exists sit in the bucket forever, unreferenced and
 * unfindable — and still, legally, that clinic's patient data.
 *
 * Safe to call twice, and safe to call for a clinic that never uploaded
 * anything: both drivers treat "nothing there" as success.
 */
export async function deleteClinicFiles(clinicId: string): Promise<number> {
  // Guard the prefix. Everything under ROOT would be deleted by an empty or
  // traversing id, and this is called from a code path whose whole job is
  // destroying data — the one place a defensive check is worth its keystrokes.
  if (!/^[0-9a-f-]{36}$/i.test(clinicId)) throw new Error("deleteClinicFiles: bad clinic id");

  if (usingObjectStore()) {
    const { mod, client, bucket } = await s3();
    let deleted = 0;
    let token: string | undefined;
    do {
      const listed = await client.send(
        new mod.ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${clinicId}/`,
          ContinuationToken: token,
        })
      );
      const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
      if (keys.length) {
        // DeleteObjects takes 1000 keys at a time; ListObjectsV2 returns at
        // most 1000, so one call per page is always within the limit.
        await client.send(
          new mod.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } })
        );
        deleted += keys.length;
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  const abs = path.join(ROOT, clinicId);
  if (!abs.startsWith(ROOT)) return 0;
  const before = await countFiles(abs);
  await fs.promises.rm(abs, { recursive: true, force: true });
  return before;
}

async function countFiles(dir: string): Promise<number> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  let n = 0;
  for (const e of entries) {
    n += e.isDirectory() ? await countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}
