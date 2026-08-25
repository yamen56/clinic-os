/**
 * Ships the current commit to Railway.
 *
 * Auto-deploy does not fire on this project, so every release is triggered by
 * hand — and by hand is exactly where the trap is: `serviceInstanceRedeploy`
 * and a bare `serviceInstanceDeploy` both rebuild whatever commit the service
 * is *pinned* to, report SUCCESS, and ship nothing new. So the commit is always
 * named explicitly, and it is read from git rather than typed.
 *
 * Both services are deployed together. They share the repo and the worker
 * applies migrations on boot; deploying one without the other leaves the two
 * halves of the app on different code.
 *
 *   npx tsx scripts/deploy.ts            # deploy HEAD to web + worker
 *   npx tsx scripts/deploy.ts --web      # one service only
 *   npx tsx scripts/deploy.ts --worker
 *   npx tsx scripts/deploy.ts --status   # what is live right now
 */
import { execSync } from "node:child_process";

process.loadEnvFile(".env.production.local");

const API = "https://backboard.railway.com/graphql/v2";
const TOKEN = process.env.RAILWAY_TOKEN;
const ENV_ID = process.env.RAILWAY_ENV_ID;
const SERVICES = [
  { key: "web", label: "clinic-web", id: process.env.RAILWAY_WEB_SERVICE_ID },
  { key: "worker", label: "clinic-os (worker)", id: process.env.RAILWAY_WORKER_SERVICE_ID },
];

if (!TOKEN || !ENV_ID) {
  console.error("RAILWAY_TOKEN / RAILWAY_ENV_ID missing from .env.production.local");
  process.exit(1);
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await r.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new Error(`no data (http ${r.status})`);
  return body.data;
}

const sh = (cmd: string) => execSync(cmd, { encoding: "utf8" }).trim();

type Deployment = {
  id: string;
  status: string;
  meta?: { commitHash?: string; commitMessage?: string } | null;
  createdAt: string;
};

async function latest(serviceId: string): Promise<Deployment | null> {
  const d = await gql<{ deployments: { edges: { node: Deployment }[] } }>(
    `query($serviceId: String!, $environmentId: String!) {
       deployments(first: 1, input: { serviceId: $serviceId, environmentId: $environmentId }) {
         edges { node { id status meta createdAt } }
       }
     }`,
    { serviceId, environmentId: ENV_ID }
  );
  return d.deployments.edges[0]?.node ?? null;
}

function describe(d: Deployment | null): string {
  if (!d) return "none";
  const sha = d.meta?.commitHash?.slice(0, 7) ?? "?";
  const msg = (d.meta?.commitMessage ?? "").split("\n")[0].slice(0, 48);
  return `${d.status.padEnd(10)} ${sha}  ${msg}`;
}

async function status() {
  for (const s of SERVICES) {
    if (!s.id) continue;
    console.log(`  ${s.label.padEnd(20)} ${describe(await latest(s.id))}`);
  }
}

/** Terminal states, so a failed build ends the wait instead of running the clock out. */
const DONE = new Set(["SUCCESS", "FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

async function waitFor(label: string, id: string, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const d = await gql<{ deployment: Deployment }>(
      `query($id: String!) { deployment(id: $id) { id status meta createdAt } }`,
      { id }
    );
    const s = d.deployment.status;
    if (s !== last) {
      console.log(`  ${label}: ${s}`);
      last = s;
    }
    if (DONE.has(s)) return s;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return `TIMEOUT(${last})`;
}

async function main() {
  if (process.argv.includes("--status")) {
    console.log("\nlive now:\n");
    await status();
    console.log();
    return;
  }

  const sha = sh("git rev-parse HEAD");
  const subject = sh("git log -1 --format=%s");
  const branch = sh("git rev-parse --abbrev-ref HEAD");
  const dirty = sh("git status --porcelain");
  const ahead = sh(`git rev-list --count origin/${branch}..HEAD`);

  console.log(`\ncommit:  ${sha.slice(0, 7)}  ${subject}`);
  console.log(`branch:  ${branch}`);
  if (dirty) console.log("WARNING: working tree is dirty — those changes are NOT in this commit.");
  if (ahead !== "0") {
    console.error(`\n${ahead} commit(s) not pushed. Railway builds from the remote; push first.`);
    process.exit(1);
  }

  const only = process.argv.includes("--web")
    ? ["web"]
    : process.argv.includes("--worker")
      ? ["worker"]
      : ["web", "worker"];
  const targets = SERVICES.filter((s) => s.id && only.includes(s.key));

  console.log("\nbefore:\n");
  await status();

  const started: { label: string; id: string }[] = [];
  for (const s of targets) {
    const d = await gql<{ serviceInstanceDeployV2: string }>(
      `mutation($serviceId: String!, $environmentId: String!, $commitSha: String!) {
         serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
       }`,
      { serviceId: s.id, environmentId: ENV_ID, commitSha: sha }
    );
    console.log(`\n→ ${s.label}: deployment ${d.serviceInstanceDeployV2}`);
    started.push({ label: s.label, id: d.serviceInstanceDeployV2 });
  }

  console.log();
  const results = await Promise.all(started.map((s) => waitFor(s.label, s.id)));

  console.log("\nafter:\n");
  await status();

  const bad = results.filter((r) => r !== "SUCCESS");
  console.log();
  if (bad.length) {
    console.error(`FAILED: ${bad.join(", ")}`);
    process.exit(1);
  }
  console.log(`✓ ${sha.slice(0, 7)} is live on ${started.length} service(s)\n`);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
