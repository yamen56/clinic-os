/**
 * Seals the JoFotara secrets stored before src/lib/crypto-secret.ts existed.
 *
 * New and changed secrets are sealed as they are saved; this does the ones
 * already in the table. Idempotent — a sealed value is left alone — and it
 * proves each one opens again before writing it, so a wrong key cannot turn a
 * working credential into one nobody can read.
 *
 * Needs APP_ENCRYPTION_KEY: the same value the web and worker services run
 * with, or the worker will not be able to open what this writes.
 *
 *   npx tsx scripts/seal-secrets.ts                 # local database
 *   npx tsx scripts/seal-secrets.ts --prod          # .env.production.local
 *   npx tsx scripts/seal-secrets.ts --prod --dry-run
 */
import { Client } from "pg";
import { isSealed, openSecret, sealSecret } from "../src/lib/crypto-secret";

const PROD = process.argv.includes("--prod");
const DRY = process.argv.includes("--dry-run");
try {
  process.loadEnvFile(PROD ? ".env.production.local" : ".env");
} catch {}

async function main() {
  if (!process.env.APP_ENCRYPTION_KEY) {
    console.error("APP_ENCRYPTION_KEY is not set — nothing would be sealed.");
    process.exit(1);
  }
  const url = PROD
    ? process.env.DATABASE_SUPER_URL
    : `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
  if (!url) {
    console.error("DATABASE_SUPER_URL is not set in .env.production.local");
    process.exit(1);
  }
  const c = new Client({ connectionString: url, ssl: PROD ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  console.log(`target: ${new URL(url).host}${DRY ? " (dry run)" : ""}`);

  const rows = (
    await c.query(`select clinic_id, secret_key from clinic_einvoice_settings where coalesce(secret_key, '') <> ''`)
  ).rows as { clinic_id: string; secret_key: string }[];
  let sealed = 0;
  for (const r of rows) {
    if (isSealed(r.secret_key)) continue;
    const next = sealSecret(r.secret_key);
    if (openSecret(next) !== r.secret_key) throw new Error(`round trip failed for ${r.clinic_id}`);
    if (!DRY) {
      await c.query(
        `update clinic_einvoice_settings set secret_key = $2 where clinic_id = $1 and secret_key = $3`,
        [r.clinic_id, next, r.secret_key]
      );
    }
    sealed++;
  }
  console.log(`${rows.length} secret(s) stored, ${sealed} ${DRY ? "would be" : ""} sealed now`);
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
