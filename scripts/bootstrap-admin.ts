/**
 * Creates the agency super-admin on a fresh production database.
 *
 * Separate from `seed.ts` on purpose: that script builds the fictional demo
 * clinic, which must never touch a database serving real patients. This creates
 * exactly one account and nothing else.
 *
 *   DATABASE_SUPER_URL=… npx tsx scripts/bootstrap-admin.ts <email> [password]
 *
 * Omit the password and a strong one is generated and printed once.
 */
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

try {
  process.loadEnvFile?.();
} catch {}

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: bootstrap-admin.ts <email> [password]");
    process.exit(1);
  }
  // base64url avoids characters that get mangled when pasted into a shell.
  const password = process.argv[3] ?? randomBytes(12).toString("base64url");
  const name = process.argv[4] ?? "Clinicti Admin";

  const url =
    process.env.DATABASE_SUPER_URL ??
    `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

  const c = new Client({
    connectionString: url,
    ssl: /@(localhost|127\.0\.0\.1)/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  await c.connect();

  const r = await c.query(
    `insert into users (email, password_hash, full_name, is_super_admin, locale)
     values ($1, $2, $3, true, 'ar')
     on conflict ((lower(email))) do update
       set password_hash = excluded.password_hash,
           is_super_admin = true
     returning id, (xmax = 0) as created`,
    [email, bcrypt.hashSync(password, 10), name]
  );
  await c.end();

  const { created } = r.rows[0];
  console.log(`\n  ${created ? "Created" : "Updated"} agency super-admin`);
  console.log(`  email     ${email}`);
  console.log(`  password  ${password}`);
  console.log(`\n  Shown once. Store it in a password manager now.\n`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
