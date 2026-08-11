/**
 * Starts the whole stack in one terminal: embedded Postgres, the Next.js app,
 * and the background worker. Ctrl+C stops all three.
 *
 * First run is self-preparing: pending migrations apply automatically, and an
 * empty database gets the demo clinic seeded, so `npm run dev:all` is the only
 * command needed from a fresh clone.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Client } from "pg";

const PG_PORT = Number(process.env.PG_PORT || 5544);
const children: ChildProcess[] = [];

function run(name: string, args: string[], color: string) {
  const child = spawn("npx", args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: process.env,
  });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream: NodeJS.ReadableStream) => {
    stream.on("data", (b: Buffer) => {
      for (const line of b.toString().split("\n")) {
        if (line.trim()) process.stdout.write(prefix + line + "\n");
      }
    });
  };
  if (child.stdout) pipe(child.stdout);
  if (child.stderr) pipe(child.stderr);
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.log(`${prefix}exited with code ${code}`);
  });
  children.push(child);
  return child;
}

/** Waits for the server to accept connections (before any migration exists). */
async function waitForDb(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const c = new Client({
        connectionString: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/clinicos`,
      });
      await c.connect();
      await c.query("select 1");
      await c.end();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return false;
}

function step(name: string, args: string[]) {
  const r = spawnSync("npx", args, { stdio: "inherit", shell: true, env: process.env });
  if (r.status !== 0) throw new Error(`${name} failed`);
}

/** True when the database has no clinics yet, so a fresh clone gets demo data. */
async function isEmpty() {
  const c = new Client({
    connectionString: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/clinicos`,
  });
  await c.connect();
  try {
    const r = await c.query("select count(*)::int as n from clinics");
    return r.rows[0].n === 0;
  } finally {
    await c.end();
  }
}

async function main() {
  console.log("Starting Clinicti…\n");
  run("db", ["tsx", "scripts/db.ts"], "36");

  if (!(await waitForDb())) {
    console.error("Database did not become ready in time.");
    process.exit(1);
  }
  console.log("\x1b[36m[db]\x1b[0m ready\n");

  step("migrate", ["tsx", "scripts/migrate.ts"]);
  if (await isEmpty()) {
    console.log("\nEmpty database — seeding the demo clinic…\n");
    step("seed", ["tsx", "scripts/seed.ts"]);
  }

  run("web", ["next", "dev"], "32");
  run("worker", ["tsx", "worker/index.ts"], "35");

  console.log("\n  Web    http://localhost:3000");
  console.log("  Worker http://localhost:4020");
  console.log("  DB     postgres://127.0.0.1:" + PG_PORT + "/clinicos\n");
}

const stop = () => {
  console.log("\nStopping…");
  for (const c of children) {
    try {
      c.kill();
    } catch {}
  }
  setTimeout(() => process.exit(0), 800);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

main().catch((e) => {
  console.error(e);
  stop();
});
