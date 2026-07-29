/**
 * Transactional email.
 *
 * Uses Resend when RESEND_API_KEY is set. Without it, sending is a no-op that
 * reports failure rather than throwing — callers surface the link in the UI so
 * an owner can pass it on by hand. That keeps invitations usable before an
 * email provider exists, instead of blocking staff onboarding on it.
 */

const FROM = () => process.env.EMAIL_FROM || "Makan Scaling <onboarding@resend.dev>";
const REPLY_TO = () => process.env.EMAIL_REPLY_TO?.trim() || undefined;

/**
 * Inbox placement depends far more on the sending domain than on the message.
 * The default `onboarding@resend.dev` is a shared sender with no reputation of
 * yours and will often land in spam — set EMAIL_FROM to an address on a domain
 * verified in Resend (which publishes SPF and DKIM for it) before inviting real
 * staff. `npm run doctor` reports when this is still the shared default.
 */
export function usingSharedSender(): boolean {
  return /resend\.dev/i.test(FROM());
}

export type SendResult = { ok: boolean; skipped?: boolean; error?: string };

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  if (!emailConfigured()) return { ok: false, skipped: true };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM(),
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        // A plain-text alternative alongside the HTML: single-part HTML mail is
        // a well-known spam signal.
        text: opts.text,
        ...(REPLY_TO() ? { reply_to: REPLY_TO() } : {}),
        headers: {
          // Marks these as transactional so they are not filtered as bulk mail.
          "X-Entity-Ref-ID": crypto.randomUUID(),
          "Auto-Submitted": "auto-generated",
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `${res.status}: ${detail.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/*
  The message bodies now come from the finished templates in src/emails/templates,
  rendered by renderEmail. The old hand-written layout() and per-type builders are
  gone — see src/emails/render.ts for why they are treated as opaque assets.
*/
export { renderEmail } from "@/emails/render";
export type { EmailType, EmailLocale } from "@/emails/render";
