/**
 * Sends one real alert, so the channel is known to work before it is needed.
 *
 * An alerting system nobody has ever received a message from is a belief, not a
 * safeguard — the same argument as `scripts/restore.ts --verify` makes about
 * backups, and for the same reason. The day it matters is the worst possible day
 * to discover that `RESEND_API_KEY` was never set on the worker, or that the
 * mail lands in spam, or that there is no super admin with an email address.
 *
 *   npx tsx scripts/ops-test-alert.ts            # against production config
 *   npx tsx scripts/ops-test-alert.ts --check    # say who would be told, send nothing
 *
 * Reads `.env.production.local`, like the backup tooling, so no key reaches a
 * shell history. Worth running after any change to the mail setup.
 */
process.loadEnvFile(".env.production.local");

import { collectFindings } from "../src/lib/ops-alert";

async function main() {
  const checkOnly = process.argv.includes("--check");

  const { withSystem } = await import("../src/lib/db");
  const configured = (process.env.OPS_ALERT_EMAIL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const admins = await withSystem(async (c) =>
    (
      await c.query(
        `select email from users where is_super_admin and email is not null and email <> ''`
      )
    ).rows.map((r) => r.email as string)
  );
  const to = configured.length ? configured : admins;

  console.log(`\nmail configured:  ${process.env.RESEND_API_KEY ? "yes" : "NO — nothing can be sent"}`);
  console.log(`from:             ${process.env.EMAIL_FROM || "(unset)"}`);
  console.log(`OPS_ALERT_EMAIL:  ${configured.length ? configured.join(", ") : "(unset — falling back)"}`);
  console.log(`super admins:     ${admins.length ? admins.join(", ") : "(none)"}`);
  console.log(`would alert:      ${to.length ? to.join(", ") : "NOBODY"}`);

  const findings = await collectFindings();
  console.log(
    `\ncurrent findings: ${findings.length ? findings.map((f) => f.key).join(", ") : "none — the platform looks healthy"}`
  );
  for (const f of findings) console.log(`  · ${f.title}`);

  if (checkOnly) {
    console.log("\n--check: nothing sent.\n");
    return;
  }
  if (!to.length) {
    console.error("\nThere is nobody to alert. Set OPS_ALERT_EMAIL or give a super admin an email.\n");
    process.exit(1);
  }

  const { sendEmail } = await import("../src/lib/email");
  let sent = 0;
  for (const address of to) {
    const res = await sendEmail({
      to: address,
      subject: "Clinicti: alert channel test",
      html:
        `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px">` +
        `<h2 style="margin:0 0 12px;font-size:18px">This is a test</h2>` +
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#333">Nothing is wrong. ` +
        `Somebody ran <code>scripts/ops-test-alert.ts</code> to confirm that platform alerts ` +
        `actually arrive.</p>` +
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#333">If this reached ` +
        `you, the backup, worker, queue and WhatsApp alarms will reach you too. If it landed in ` +
        `spam, fix that now rather than at 2am.</p></div>`,
      text:
        "This is a test. Nothing is wrong.\n\n" +
        "Somebody ran scripts/ops-test-alert.ts to confirm that platform alerts arrive.\n" +
        "If this reached you, the backup, worker, queue and WhatsApp alarms will too.",
    });
    if (res.ok) {
      sent++;
      console.log(`\nsent to ${address}`);
    } else {
      console.error(`\nFAILED to ${address}: ${res.error ?? "skipped (no API key)"}`);
    }
  }
  console.log(
    sent === to.length
      ? "\nThe alert channel works. Check the inbox — and check spam.\n"
      : "\nSome sends failed. Alerts will not reach you until this is fixed.\n"
  );
  if (sent !== to.length) process.exit(1);
}

main().catch((e) => {
  console.error(String((e as Error).message ?? e).slice(0, 500));
  process.exit(1);
});
