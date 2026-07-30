/**
 * Checks that the production Anthropic key actually works, and that every model
 * the platform might ask for is reachable with it.
 *
 * Reads `.env.production.local` itself rather than taking the key as an
 * argument, so the key never reaches a shell history, a process list or a log —
 * same reason `scripts/migrate-prod.ts` does it. Nothing here ever prints the
 * key; only a fingerprint (length and first/last few characters) so you can tell
 * two keys apart without exposing either.
 *
 * The env-level `ANTHROPIC_MODEL` is only the fallback. Each clinic can pick its
 * own model in `ai_agents.model`, and that wins — so a key that works for the
 * fallback can still fail for a clinic. This checks every distinct model in use.
 *
 *   npx tsx scripts/check-anthropic.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "pg";

process.loadEnvFile(".env.production.local");

const key = process.env.ANTHROPIC_API_KEY;
const fallbackModel = process.env.ANTHROPIC_MODEL || "claude-opus-5";

function fingerprint(k: string): string {
  return `${k.length} chars · ${k.slice(0, 7)}…${k.slice(-4)}`;
}

/** Models any clinic has actually selected, so we test what production will ask for. */
async function configuredModels(): Promise<string[]> {
  const url = process.env.DATABASE_SUPER_URL;
  if (!url) return [];
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    const rows = (
      await c.query<{ model: string | null }>(
        "select distinct model from ai_agents where model is not null and model <> ''"
      )
    ).rows;
    return rows.map((r) => r.model!).filter(Boolean);
  } catch (e) {
    console.log(`  (could not read ai_agents: ${(e as Error).message})`);
    return [];
  } finally {
    await c.end().catch(() => {});
  }
}

async function probe(client: Anthropic, model: string): Promise<boolean> {
  try {
    const res = await client.messages.create({
      model,
      max_tokens: 16,
      // A one-word answer: this is a reachability check, not a capability test.
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    });
    const text = res.content.find((b) => b.type === "text");
    console.log(
      `  ok    ${model} — replied ${JSON.stringify(text?.text?.trim() ?? "")}, ` +
        `${res.usage.input_tokens} in / ${res.usage.output_tokens} out`
    );
    return true;
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.log(`  FAIL  ${model} — ${err.status ?? "?"} ${err.message ?? String(e)}`);
    return false;
  }
}

async function main() {
  if (!key) {
    console.error("ANTHROPIC_API_KEY is not set in .env.production.local");
    console.error("Without it the AI receptionist stays off and escalates to staff.");
    process.exit(1);
  }
  console.log(`key:      ${fingerprint(key)}`);
  console.log(`fallback: ${fallbackModel}`);
  if (process.env.ANTHROPIC_BASE_URL) console.log(`base url: ${process.env.ANTHROPIC_BASE_URL}`);

  const client = new Anthropic({ apiKey: key });

  const perClinic = await configuredModels();
  const models = [...new Set([fallbackModel, ...perClinic])];
  console.log(
    perClinic.length
      ? `clinics have picked: ${perClinic.join(", ")}\n`
      : "no clinic has overridden the model\n"
  );

  console.log("live calls:");
  const results = await Promise.all(models.map((m) => probe(client, m)));

  const failed = models.filter((_, i) => !results[i]);
  if (failed.length) {
    console.log(`\n${failed.length} of ${models.length} model(s) unreachable: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nall ${models.length} model(s) reachable — the key works.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
