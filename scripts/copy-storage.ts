/**
 * Copies every object from one S3-compatible bucket to another.
 *
 * The companion to copy-database.ts: that moves the rows, this moves the files
 * they point at — patient uploads, signatures, signed PDFs, WhatsApp media and
 * the database backups themselves.
 *
 * Each object is verified after writing, by comparing the bytes rather than
 * trusting the upload's own response. A file store that silently drops a
 * signature is worse than one that fails loudly, and a signed consent form
 * whose image is missing is not a signed consent form.
 *
 *   npx tsx scripts/copy-storage.ts --from-env <file> --to-env <file> [--dry-run]
 *
 * Env files hold: ENDPOINT, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION.
 */
import fs from "node:fs";
import crypto from "node:crypto";

type Conn = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
};

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) {
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

function connFrom(vars: Record<string, string>, prefix: string): Conn {
  const g = (k: string) => vars[`${prefix}${k}`] ?? vars[k] ?? "";
  const c = {
    endpoint: g("ENDPOINT"),
    bucket: g("BUCKET"),
    accessKeyId: g("ACCESS_KEY_ID"),
    secretAccessKey: g("SECRET_ACCESS_KEY"),
    region: g("REGION") || "auto",
  };
  for (const [k, v] of Object.entries(c)) {
    if (!v) throw new Error(`missing ${prefix}${k.toUpperCase()}`);
  }
  return c;
}

async function client(c: Conn) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: c.region,
    endpoint: c.endpoint,
    // Supabase and R2 both accept path-style; virtual-hosted needs DNS per bucket.
    forcePathStyle: true,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
}

async function listAll(cl: Awaited<ReturnType<typeof client>>, bucket: string) {
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const r = await cl.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token })
    );
    for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (f: string) => {
    const i = argv.indexOf(f);
    return i === -1 ? undefined : argv[i + 1];
  };
  const fromEnv = arg("--from-env");
  const toEnv = arg("--to-env");
  const dryRun = argv.includes("--dry-run");
  if (!fromEnv || !toEnv) {
    console.error("usage: copy-storage.ts --from-env <file> --to-env <file> [--dry-run]");
    process.exit(1);
  }

  const from = connFrom(readEnvFile(fromEnv), "SRC_");
  const to = connFrom(readEnvFile(toEnv), "DST_");
  if (from.endpoint === to.endpoint && from.bucket === to.bucket) {
    console.error("refusing to copy a bucket onto itself");
    process.exit(1);
  }

  const src = await client(from);
  const dst = await client(to);
  const { GetObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");

  console.log(`source → ${new URL(from.endpoint).host}/${from.bucket}`);
  console.log(`target → ${new URL(to.endpoint).host}/${to.bucket}\n`);

  const objects = await listAll(src, from.bucket);
  const total = objects.reduce((n, o) => n + o.size, 0);
  console.log(`${objects.length} objects, ${(total / 1048576).toFixed(2)} MB`);

  if (dryRun) {
    for (const o of objects) console.log(`  ${o.key} (${o.size} bytes)`);
    return;
  }

  // What is already there, so a re-run resumes instead of re-uploading.
  const existing = new Map((await listAll(dst, to.bucket)).map((o) => [o.key, o.size]));

  let copied = 0;
  let skipped = 0;
  let failed = 0;

  for (const o of objects) {
    if (existing.get(o.key) === o.size) {
      skipped++;
      continue;
    }
    try {
      const got = await src.send(new GetObjectCommand({ Bucket: from.bucket, Key: o.key }));
      const body = Buffer.from(await got.Body!.transformToByteArray());
      await dst.send(
        new PutObjectCommand({
          Bucket: to.bucket,
          Key: o.key,
          Body: body,
          ContentType: got.ContentType,
        })
      );

      // Read it back and compare bytes. The upload reporting success is not the
      // same as the bytes being right.
      const check = await dst.send(new GetObjectCommand({ Bucket: to.bucket, Key: o.key }));
      const back = Buffer.from(await check.Body!.transformToByteArray());
      const same =
        back.length === body.length &&
        crypto.createHash("md5").update(back).digest("hex") ===
          crypto.createHash("md5").update(body).digest("hex");
      if (!same) {
        failed++;
        console.error(`  MISMATCH ${o.key}`);
        continue;
      }
      copied++;
      console.log(`  ${o.key.padEnd(58)} ${String(o.size).padStart(8)} bytes`);
    } catch (e) {
      failed++;
      console.error(`  FAILED ${o.key}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  const after = await listAll(dst, to.bucket);
  console.log(`\ncopied ${copied}, already present ${skipped}, failed ${failed}`);
  console.log(`target now holds ${after.length} objects`);

  const missing = objects.filter((o) => !after.some((a) => a.key === o.key && a.size === o.size));
  if (missing.length) {
    console.error(`\n${missing.length} object(s) missing or wrong size — do not switch over`);
    for (const m of missing.slice(0, 10)) console.error(`  ${m.key}`);
    process.exit(1);
  }
  if (failed) process.exit(1);
  console.log("\nCOPY OK — every object present and byte-identical");
}

main().catch((e) => {
  console.error("COPY FAILED:", (e as Error).message);
  process.exit(1);
});
