/**
 * Runs every QA suite in order and reports a summary.
 * Requires the stack to be running (`npm run dev:all`).
 */
import { spawn } from "node:child_process";

const SUITES = [
  // First, so the browser suites time the app and not the dev compiler.
  ["warm-up: compile the routes", "scripts/qa-warm.ts"],
  ["unit: phone normalization", "scripts/test-phone.ts"],
  ["unit: RLS tenant isolation", "scripts/test-rls.ts"],
  ["unit: Arabic-insensitive search", "scripts/test-search.ts"],
  ["unit: readable ink on a clinic colour", "scripts/test-contrast.ts"],
  ["phones: country codes and RTL display", "scripts/qa-phone-ui.ts"],
  ["numbers: a price you can actually delete", "scripts/qa-number-fields.ts"],
  ["unit: surviving a database blip", "scripts/qa-db-resilience.ts"],
  ["phase 1: foundation, auth, tenancy", "scripts/qa-phase1.ts"],
  ["vocabulary: one workspace, different words", "scripts/qa-vocabulary.ts"],
  ["dashboard: analytics, shortcuts, and what each member may see", "scripts/qa-dashboard.ts"],
  ["phase 2: patients", "scripts/qa-phase2.ts"],
  ["patients: exporting the record", "scripts/qa-patient-export.ts"],
  ["patients: the list as a spreadsheet", "scripts/qa-patient-excel.ts"],
  ["adding somebody back after removing them", "scripts/qa-readd.ts"],
  ["phase 3: calendar", "scripts/qa-phase3.ts"],
  ["phase 4: public booking", "scripts/qa-phase4.ts"],
  ["phase 5: WhatsApp inbox", "scripts/qa-phase5.ts"],
  ["phase 6: invoicing", "scripts/qa-phase6.ts"],
  ["tax & e-invoicing: per-line tax, JoFotara, credit notes", "scripts/qa-einvoicing.ts"],
  ["invoices & patients: a title, filing one at a time, muting somebody", "scripts/qa-invoice-title-opt-outs.ts"],
  ["phase 7: automations", "scripts/qa-phase7.ts"],
  ["automations: built-in messages, team alerts, specialty packs", "scripts/qa-automation-coverage.ts"],
  ["phase 8: AI receptionist", "scripts/qa-phase8.ts"],
  ["phase 9: PWA & notifications", "scripts/qa-phase9.ts"],
  ["phase 10: admin & demo data", "scripts/qa-phase10.ts"],
  ["campaigns: bulk send & drip rails", "scripts/qa-campaigns.ts"],
  ["concurrency: one slot, one appointment", "scripts/qa-booking-race.ts"],
  ["booking: the clinic's own questions", "scripts/qa-booking-intake.ts"],
  ["booking: settings and the public page, in a browser", "scripts/qa-booking-ui.ts"],
  ["notes: versions, categories, voice", "scripts/qa-notes.ts"],
  ["notes: the tab and the merged booking step", "scripts/qa-notes-ui.ts"],
  ["notes: filed against a visit", "scripts/qa-notes-visits.ts"],
  ["signing: integrity, tokens, orchestration", "scripts/qa-esign.ts"],
  ["signing: both journeys in the browser", "scripts/qa-esign-browser.ts"],
  ["documents: tabs, signed copies, imports", "scripts/qa-documents.ts"],
  ["payments: part-paid invoices", "scripts/qa-payments.ts"],
  ["photos: staff pictures & who may set them", "scripts/qa-photos.ts"],
  ["branding: the clinic logo where it belongs", "scripts/qa-clinic-logo.ts"],
  ["tablet: iPad layouts", "scripts/qa-tablet.ts"],
  ["phone: nothing scrolls sideways", "scripts/qa-mobile-width.ts"],
  ["account & tags: the profile page and the tag catalogue", "scripts/qa-profile-tags.ts"],
  ["import & digest: reading their file, sending one summary", "scripts/qa-import-digest.ts"],
  ["import: the shapes a real patient list arrives in", "scripts/qa-import-variants.ts"],
  ["waitlist & insurance: filling cancellations, splitting the bill", "scripts/qa-waitlist-insurance.ts"],
  ["whatsapp: messaging a patient first", "scripts/qa-first-message.ts"],
  ["whatsapp: sending, unreachable numbers, receipts", "scripts/qa-whatsapp-delivery.ts"],
  ["whatsapp: LID chats and the sending window", "scripts/qa-whatsapp-lid.ts"],
  ["whatsapp: 500 messages a day", "scripts/qa-whatsapp-volume.ts"],
  ["pdf: browser released when idle", "scripts/qa-pdf-idle.ts"],
  ["backup: dump and restore", "scripts/qa-backup.ts"],
  ["access: what each member can reach", "scripts/qa-access.ts"],
  ["agency: modules, limited admins, deleting a clinic", "scripts/qa-agency-control.ts"],
  ["load: can one caller take the platform down", "scripts/qa-dos.ts"],
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
