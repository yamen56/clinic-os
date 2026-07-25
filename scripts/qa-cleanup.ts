/** Removes clinics and users created by QA runs. */
import { Client } from "pg";

const PG_PORT = Number(process.env.PG_PORT || 5544);

async function main() {
  const c = new Client({
    connectionString: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/clinicos`,
  });
  await c.connect();
  const r1 = await c.query(
    `delete from clinics where slug like 'qa-clinic-%' or slug like 'qa2-%' or slug like 'qa3-%' or slug like 'qa%-test%' returning slug`
  );
  const r2 = await c.query(`delete from users where email like 'owner-qa%@test.local' returning email`);
  console.log(`[qa-cleanup] removed ${r1.rowCount} clinics, ${r2.rowCount} users`);
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
