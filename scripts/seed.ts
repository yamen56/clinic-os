/**
 * Seed: super admin + demo clinic with realistic Arabic data.
 * Idempotent — safe to run repeatedly.
 */
import { Client } from "pg";
import bcrypt from "bcryptjs";

const PG_PORT = Number(process.env.PG_PORT || 5544);
const url = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/clinicos`;

export const SEED = {
  adminEmail: "admin@makan.agency",
  adminPassword: "admin1234",
  ownerEmail: "owner@rima.clinic",
  ownerPassword: "rima1234",
  doctorEmail: "doctor@rima.clinic",
  doctorPassword: "rima1234",
  receptionEmail: "reception@rima.clinic",
  receptionPassword: "rima1234",
  clinicSlug: "rima-dental",
};

async function main() {
  const c = new Client({ connectionString: url });
  await c.connect();

  const hash = (pw: string) => bcrypt.hashSync(pw, 10);

  async function upsertUser(email: string, password: string, name: string, opts: { superAdmin?: boolean; locale?: string; phone?: string } = {}) {
    const r = await c.query(
      `insert into users (email, password_hash, full_name, is_super_admin, locale, phone_e164)
       values ($1, $2, $3, $4, $5, $6)
       on conflict ((lower(email))) do update set full_name = excluded.full_name
       returning id`,
      [email, hash(password), name, opts.superAdmin ?? false, opts.locale ?? "ar", opts.phone ?? null]
    );
    return r.rows[0].id as string;
  }

  const adminId = await upsertUser(SEED.adminEmail, SEED.adminPassword, "Makan Admin", {
    superAdmin: true,
    locale: "en",
  });
  console.log("[seed] super admin:", SEED.adminEmail, "/", SEED.adminPassword, `(${adminId.slice(0, 8)})`);

  await c.end();
  console.log("[seed] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
