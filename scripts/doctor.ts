/**
 * Readiness check. Every line is either fine, or tells you the exact command
 * that fixes it. Run any time: npm run doctor
 */
import { existsSync, readFileSync } from "node:fs";
import { Client } from "pg";

try {
  process.loadEnvFile?.();
} catch {
  // no .env yet — reported below
}

type Level = "ok" | "warn" | "fail";
const results: { level: Level; label: string; detail: string }[] = [];
const add = (level: Level, label: string, detail: string) =>
  results.push({ level, label, detail });

const PG_PORT = Number(process.env.PG_PORT || 5544);
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const WORKER_URL = process.env.WORKER_URL || "http://localhost:4020";

/** Generous by default: a dev server compiles the route on first request. */
async function reachable(url: string, ms = 20_000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok || r.status < 500;
  } catch {
    return false;
  }
}

/**
 * Deployment readiness (`npm run doctor -- --deploy`).
 * Each CLI login is an interactive browser flow that only a human can complete;
 * this reports which ones are still outstanding.
 */
async function deployChecks() {
  const { execSync } = await import("node:child_process");
  const run = (cmd: string): string | null => {
    try {
      return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], timeout: 25_000 })
        .toString()
        .trim();
    } catch {
      return null;
    }
  };

  const gh = run("gh auth status");
  gh
    ? add("ok", "GitHub CLI", (gh.match(/account (\S+)/)?.[1] ?? "authenticated"))
    : add("warn", "GitHub CLI", "not logged in — run: gh auth login");

  const railway = run("npx --yes @railway/cli whoami");
  railway
    ? add("ok", "Railway CLI", railway.split("\n").pop() ?? "authenticated")
    : add("warn", "Railway CLI", "not logged in — run: npx @railway/cli login");

  existsSync(".env.production.local")
    ? add("ok", "Production secrets", ".env.production.local present")
    : add("fail", "Production secrets", "missing — regenerate before deploying");

  const remote = run("git remote get-url origin");
  remote
    ? add("ok", "Git remote", remote)
    : add("warn", "Git remote", "none yet — created during deploy");
}

/**
 * Whether mail will actually leave the building.
 *
 * Resend refuses any send whose From domain is not verified on the account, and
 * it refuses it at send time with a 403 — by which point the invitation or the
 * password reset has already been reported to the user as sent. `forgot` logs
 * the error and returns `{ sent: true }` regardless, because it must not reveal
 * whether an address exists. So the sending domain being wrong is invisible in
 * the product, and this is the only place it gets said out loud.
 */
async function emailCheck() {
  const from = process.env.EMAIL_FROM || "";
  const key = process.env.RESEND_API_KEY;

  if (!key) {
    add("warn", "Email", "RESEND_API_KEY empty — invitations and resets must be copied by hand");
    return;
  }
  const domain = from.match(/@([^>\s]+)/)?.[1]?.toLowerCase();
  if (!domain) {
    add("fail", "Email", `EMAIL_FROM is not an address: ${from || "(empty)"}`);
    return;
  }
  /*
    Resend's own shared sender is allowed to send without being verified, so it
    is not the 403 below — but it is a shared domain carrying nobody's
    reputation, and it lands in spam often enough that real staff should never
    be invited from it. See usingSharedSender() in src/lib/email.ts.
  */
  if (/(^|\.)resend\.dev$/.test(domain)) {
    add("warn", "Email", `from ${domain} — Resend's shared sender; often lands in spam`);
    return;
  }

  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    const r = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!r.ok) {
      add("warn", "Email", `could not check the sender with Resend (${r.status})`);
      return;
    }
    const body = (await r.json()) as { data?: { name: string; status: string }[] };
    const verified = (body.data ?? []).filter((d) => d.status === "verified").map((d) => d.name);
    // A domain verified on the account also covers its subdomains.
    const covered = verified.some((v) => domain === v || domain.endsWith(`.${v}`));
    covered
      ? add("ok", "Email", `from ${domain} · verified with Resend`)
      : add(
          "fail",
          "Email",
          `EMAIL_FROM uses ${domain}, which is not verified with Resend — every send fails 403. ` +
            (verified.length ? `Verified: ${verified.join(", ")}` : "No verified domains on this account.")
        );
  } catch {
    add("warn", "Email", "Resend unreachable — sender not checked");
  }
}

async function main() {
  // Node
  const major = Number(process.versions.node.split(".")[0]);
  major >= 20
    ? add("ok", "Node.js", `v${process.versions.node}`)
    : add("fail", "Node.js", `v${process.versions.node} — needs v20 or newer`);

  // Env file
  if (!existsSync(".env")) {
    add("fail", "Environment", "no .env — run: cp .env.example .env");
  } else {
    const env = readFileSync(".env", "utf8");
    const weak = ["SESSION_SECRET", "INTERNAL_API_SECRET"].filter((k) =>
      new RegExp(`^${k}=.*change-in-production`, "m").test(env)
    );
    weak.length
      ? add("warn", "Secrets", `still placeholders: ${weak.join(", ")}`)
      : add("ok", "Secrets", "session + worker secrets set");
  }

  // Chromium for PDFs
  try {
    const { chromium } = await import("playwright");
    existsSync(chromium.executablePath())
      ? add("ok", "Chromium (invoice PDFs)", "installed")
      : add("fail", "Chromium (invoice PDFs)", "missing — run: npx playwright install chromium");
  } catch {
    add("fail", "Chromium (invoice PDFs)", "playwright not installed — run: npm install");
  }

  // Database
  let db: Client | null = null;
  try {
    db = new Client({
      connectionString: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/clinicos`,
    });
    await db.connect();
    add("ok", "Database", `listening on port ${PG_PORT}`);

    const mig = await db.query("select count(*)::int n from _migrations").catch(() => null);
    mig
      ? add("ok", "Migrations", `${mig.rows[0].n} applied`)
      : add("fail", "Migrations", "not applied — run: npm run migrate");

    const clinics = await db.query("select count(*)::int n from clinics").catch(() => null);
    if (clinics) {
      clinics.rows[0].n > 0
        ? add("ok", "Clinics", `${clinics.rows[0].n} in database`)
        : add("warn", "Clinics", "none yet — run: npm run seed (demo clinic)");
    }

    const wa = await db
      .query(
        `select status, phone_e164 from whatsapp_sessions where status = 'connected' limit 1`
      )
      .catch(() => null);
    if (wa?.rowCount) {
      add("ok", "WhatsApp", `connected as ${wa.rows[0].phone_e164}`);
    } else {
      add(
        "warn",
        "WhatsApp",
        "not paired — Settings → WhatsApp, then scan the QR with your clinic phone"
      );
    }
  } catch {
    add("fail", "Database", `not reachable on ${PG_PORT} — run: npm run dev:all`);
  } finally {
    await db?.end().catch(() => {});
  }

  // Services
  (await reachable(`${APP_URL}/login`))
    ? add("ok", "Web app", APP_URL)
    : add("fail", "Web app", `not running at ${APP_URL} — run: npm run dev:all`);

  (await reachable(`${WORKER_URL}/health`, 4000))
    ? add("ok", "Worker", WORKER_URL)
    : add("fail", "Worker", `not running at ${WORKER_URL} — run: npm run dev:all`);

  // Optional integrations
  process.env.ANTHROPIC_API_KEY
    ? add("ok", "AI receptionist", `key set · model ${process.env.ANTHROPIC_MODEL || "default"}`)
    : add(
        "warn",
        "AI receptionist",
        "ANTHROPIC_API_KEY empty — agent stays off and escalates to staff"
      );

  process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ? add("ok", "Push notifications", "VAPID keys set")
    : add("warn", "Push notifications", "VAPID keys missing — push disabled");

  await emailCheck();

  if (process.argv.includes("--deploy")) await deployChecks();

  // Report
  const icon = { ok: "\x1b[32m✓\x1b[0m", warn: "\x1b[33m!\x1b[0m", fail: "\x1b[31m✗\x1b[0m" };
  const pad = Math.max(...results.map((r) => r.label.length));
  console.log("\n  Clinicti — readiness\n" + "  " + "─".repeat(pad + 46));
  for (const r of results) {
    console.log(`  ${icon[r.level]} ${r.label.padEnd(pad)}  ${r.detail}`);
  }
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log("  " + "─".repeat(pad + 46));
  console.log(
    fails
      ? `  \x1b[31m${fails} blocking\x1b[0m${warns ? `, ${warns} optional` : ""}\n`
      : warns
        ? `  \x1b[32mReady to run.\x1b[0m ${warns} optional integration${warns > 1 ? "s" : ""} not configured.\n`
        : "  \x1b[32mEverything configured.\x1b[0m\n"
  );
  process.exitCode = fails ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
