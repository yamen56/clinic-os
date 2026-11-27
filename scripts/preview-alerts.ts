/**
 * Renders what the platform's alert emails say right now, without sending
 * anything: every finding the checks report against this database, plus a
 * WhatsApp logout built for the occasion, to a file to read.
 *
 *   npx tsx scripts/preview-alerts.ts <out.html>
 */
import "../worker/env";
import { writeFileSync } from "node:fs";
import { collectFindings, previewAlertEmail, type Finding } from "../src/lib/ops-alert";

async function main() {
  const out = process.argv[2] || "alerts-preview.html";
  const found = await collectFindings();
  const sample: Finding = {
    key: "whatsapp_down:example",
    severity: "urgent",
    title: "عيادة الأمل: WhatsApp is logged out",
    detail: 'Session status is "logged_out". It will not recover on its own.',
    impact:
      "Since Fri 27 Nov, 14:05 Amman time, عيادة الأمل is neither sending nor receiving WhatsApp: reminders, confirmations and patients' messages have stopped.",
    steps: [
      "Call Dr Rana on +962790000000.",
      "Ask them to open Settings → WhatsApp in Clinicti and scan the code with the clinic's phone.",
      "This clears by itself once it reconnects.",
    ],
    clinic: { name: "عيادة الأمل", slug: "al-amal" },
    link: "/admin/clinics/al-amal",
  };
  const list = [sample, ...found];
  const one = previewAlertEmail([sample]);
  const all = previewAlertEmail(list);
  writeFileSync(
    out,
    `<h1>Subject: ${one.subject}</h1>${one.html}<hr style="margin:40px 0"><h1>Subject: ${all.subject}</h1>${all.html}<pre>${all.text.replace(/</g, "&lt;")}</pre>`
  );
  console.log(`${list.length} finding(s) → ${out}`);
  console.log(one.subject);
  console.log(one.text);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
