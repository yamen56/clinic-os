/** Sends one of each rendered template to a real inbox. */
import { renderEmail, type EmailType, type EmailLocale } from "../src/emails/render";

try { process.loadEnvFile?.(); } catch {}
process.env.APP_URL = process.env.APP_URL || "https://app.clinicti.app";

const to = process.argv[2] ?? "6000yamen.batarseh@gmail.com";
const combos: [EmailType, EmailLocale][] = [["invitation", "ar"], ["password-reset", "en"]];

async function main() {
 for (const [type, locale] of combos) {
  const m = renderEmail({
    type, locale,
    name: locale === "ar" ? "يامن" : "Yamen",
    clinic: "عيادات الحصن الطبي",
    url: "https://app.clinicti.app/invite/PREVIEW-TOKEN",
  });
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject: `[PREVIEW] ${m.subject}`, html: m.html, text: m.text }),
  });
  const j = await r.json();
  console.log(`${type}.${locale} → ${r.status} ${j.id ?? JSON.stringify(j).slice(0, 120)}`);
 }
}
main();
