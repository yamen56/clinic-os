/**
 * Dev database daemon: boots embedded PostgreSQL, ensures the clinicos
 * database + migrations, then stays alive. Ctrl+C stops Postgres cleanly.
 */
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import path from "node:path";
import { ensureDatabase, runMigrations } from "./lib-migrate";

const PG_PORT = Number(process.env.PG_PORT || 5544);
const dataDir = path.join(process.cwd(), ".pgdata");

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port: PG_PORT,
    persistent: true,
    // Windows initdb defaults to WIN1252, which cannot store Arabic text.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });

  if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
    console.log("[db] initialising data directory...");
    await pg.initialise();
  }
  await pg.start();
  console.log(`[db] PostgreSQL listening on 127.0.0.1:${PG_PORT}`);
  await ensureDatabase();
  await runMigrations();
  console.log("[db] ready");

  const stop = async () => {
    console.log("[db] stopping...");
    try {
      await pg.stop();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Keep alive
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  console.error("[db] fatal:", e);
  process.exit(1);
});
