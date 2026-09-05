/**
 * Runtime logs for a Railway service, from the terminal.
 *
 * `deploy.ts --status` answers "did the build succeed", which is a different
 * question from "is the process alive". A container that boots, throws and gets
 * restarted still shows SUCCESS — the deployment is fine, the process is not —
 * so a crash loop is invisible from there and the only record is here.
 *
 *   npx tsx scripts/logs.ts                 # worker, last 200 lines
 *   npx tsx scripts/logs.ts --web
 *   npx tsx scripts/logs.ts --limit 500
 *   npx tsx scripts/logs.ts --filter error
 */
process.loadEnvFile(".env.production.local");

const API = "https://backboard.railway.com/graphql/v2";
const TOKEN = process.env.RAILWAY_TOKEN;
const ENV_ID = process.env.RAILWAY_ENV_ID;

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const serviceId = has("--web")
  ? process.env.RAILWAY_WEB_SERVICE_ID
  : process.env.RAILWAY_WORKER_SERVICE_ID;
const label = has("--web") ? "clinic-web" : "clinic-os (worker)";

if (!TOKEN || !ENV_ID || !serviceId) {
  console.error("RAILWAY_TOKEN / RAILWAY_ENV_ID / service id missing from .env.production.local");
  process.exit(1);
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
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

async function main() {
  const limit = Number(val("--limit") || 200);
  const filter = val("--filter");

  const dep = await gql<{ deployments: { edges: { node: { id: string; status: string; createdAt: string } }[] } }>(
    `query($serviceId: String!, $environmentId: String!) {
       deployments(first: 1, input: { serviceId: $serviceId, environmentId: $environmentId }) {
         edges { node { id status createdAt } }
       }
     }`,
    { serviceId, environmentId: ENV_ID }
  );
  const node = dep.deployments.edges[0]?.node;
  if (!node) {
    console.error("no deployment found");
    process.exit(1);
  }
  console.log(`\n${label} — deployment ${node.id.slice(0, 8)} (${node.status}, ${node.createdAt})\n`);

  const logs = await gql<{ deploymentLogs: { message: string; timestamp: string; severity?: string }[] }>(
    `query($deploymentId: String!, $limit: Int, $filter: String) {
       deploymentLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter) {
         message timestamp severity
       }
     }`,
    { deploymentId: node.id, limit, ...(filter ? { filter } : {}) }
  );

  for (const l of logs.deploymentLogs) {
    console.log(`${l.timestamp?.slice(11, 19) ?? "--:--:--"}  ${l.message}`);
  }
  console.log(`\n(${logs.deploymentLogs.length} lines)\n`);
}

main().catch((e) => {
  console.error(String((e as Error).message).slice(0, 500));
  process.exit(1);
});
