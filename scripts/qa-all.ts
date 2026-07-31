/**
 * Runs every QA suite in order and reports a summary.
 * Requires the stack to be running (`npm run dev:all`).
 */
import { spawn } from "node:child_process";

const SUITES = [
  ["unit: phone normalization", "scripts/test-phone.ts"],
  ["unit: RLS tenant isolation", "scripts/test-rls.ts"],
  ["unit: Arabic-insensitive search", "scripts/test-search.ts"],
  ["unit: surviving a database blip", "scripts/qa-db-resilience.ts"],
  ["phase 1: foundation, auth, tenancy", "scripts/qa-phase1.ts"],
  ["phase 2: patients", "scripts/qa-phase2.ts"],
  ["phase 3: calendar", "scripts/qa-phase3.ts"],
  ["phase 4: public booking", "scripts/qa-phase4.ts"],
  ["phase 5: WhatsApp inbox", "scripts/qa-phase5.ts"],
  ["phase 6: invoicing", "scripts/qa-phase6.ts"],
  ["phase 7: automations", "scripts/qa-phase7.ts"],
  ["phase 8: AI receptionist", "scripts/qa-phase8.ts"],
  ["phase 9: PWA & notifications", "scripts/qa-phase9.ts"],
  ["phase 10: admin & demo data", "scripts/qa-phase10.ts"],
  ["campaigns: bulk send & drip rails", "scripts/qa-campaigns.ts"],
  ["concurrency: one slot, one appointment", "scripts/qa-booking-race.ts"],
  ["signing: integrity, tokens, orchestration", "scripts/qa-esign.ts"],
  ["signing: both journeys in the browser", "scripts/qa-esign-browser.ts"],
  ["documents: tabs, signed copies, imports", "scripts/qa-documents.ts"],
  ["payments: part-paid invoices", "scripts/qa-payments.ts"],
  ["photos: staff pictures & who may set them", "scripts/qa-photos.ts"],
  ["pdf: browser released when idle", "scripts/qa-pdf-idle.ts"],
  ["access: what each member can reach", "scripts/qa-access.ts"],
] as const;

function run(script: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", script], { shell: true, env: process.env });
    let out = "";
    child.stdout?.on("data", (b) => (out += b.toString()));
    child.stderr?.on("data", (b) => (out += b.toString()));
    child.on("exit", (code) => resolve({ ok: code === 0, out }));
  });
}

async function main() {
  const results: { name: string; ok: boolean; out: string }[] = [];
  for (const [name, script] of SUITES) {
    process.stdout.write(`\n▶ ${name}\n`);
    const r = await run(script);
    const lines = r.out
      .split("\n")
      .filter((l) => l.startsWith("✓") || l.includes("PASSED") || l.includes("FAILED") || l.includes("passed,"));
    for (const l of lines) process.stdout.write(`  ${l.trim()}\n`);
    if (!r.ok && lines.length === 0) process.stdout.write(r.out.split("\n").slice(-8).join("\n"));
    results.push({ name, ok: r.ok, out: r.out });
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "─".repeat(56));
  for (const r of results) console.log(`${r.ok ? "  PASS" : "  FAIL"}  ${r.name}`);
  console.log("─".repeat(56));
  console.log(`  ${results.length - failed.length}/${results.length} suites passed\n`);
  process.exit(failed.length ? 1 : 0);
}

main();
