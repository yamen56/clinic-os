/** Verifies the rendered templates against the design spec's acceptance list. */
import { renderEmail, type EmailType, type EmailLocale } from "../src/emails/render";

try {
  process.loadEnvFile?.();
} catch {}
// Force a production-shaped URL: .env points at localhost, which is not https.
process.env.APP_URL = "https://clinic-web-production-bbff.up.railway.app";

const combos: [EmailType, EmailLocale][] = [
  ["invitation", "en"],
  ["invitation", "ar"],
  ["password-reset", "en"],
  ["password-reset", "ar"],
];

let bad = 0;
for (const [type, locale] of combos) {
  const r = renderEmail({
    type,
    locale,
    name: "سامي <script>",
    clinic: "Rima & Co",
    url: "https://example.com/invite/AbC-123_xyz?a=1&b=2",
  });
  const checks: [string, boolean][] = [
    ["no placeholders left", !r.html.includes("{{")],
    ["absolute https logo", /<img src="https:\/\/[^"]+mark-light\.png"/.test(r.html)],
    ["mso conditional kept", r.html.includes("<!--[if mso]>")],
    ["v:roundrect kept", r.html.includes("<v:roundrect")],
    ["no <style tag", !r.html.includes("<style")],
    ["no class attribute", !/\sclass=/.test(r.html)],
    ["subject non-empty", r.subject.trim().length > 0],
    ["plain-text part", r.text.trim().length > 0],
    ["name html-escaped", !r.html.includes("<script>")],
    ["ampersand escaped in url", !/href="[^"]*[^p]&[^a#]/.test(r.html)],
    ...(locale === "ar"
      ? ([["RLM marks intact", r.html.includes("&#8207;")]] as [string, boolean][])
      : []),
  ];
  const failed = checks.filter(([, ok]) => !ok);
  bad += failed.length;
  console.log(
    `  ${failed.length ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m"} ${type}.${locale}` +
      `  ${checks.length - failed.length}/${checks.length}` +
      (failed.length ? `  failed: ${failed.map(([n]) => n).join(", ")}` : "")
  );
  if (type === "invitation" && locale === "ar") {
    console.log(`      subject: ${r.subject}`);
  }
}
console.log(bad ? `\n  ${bad} checks failed\n` : "\n  all acceptance checks passed\n");
process.exitCode = bad ? 1 : 0;
