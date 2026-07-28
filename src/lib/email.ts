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

/** Brand-consistent shell. Inline styles only — mail clients strip <style>. */
function layout(opts: { heading: string; body: string; cta?: { url: string; label: string }; footer: string; rtl: boolean }) {
  const dir = opts.rtl ? "rtl" : "ltr";
  const align = opts.rtl ? "right" : "left";
  return `<!doctype html><html dir="${dir}"><body style="margin:0;padding:0;background:#f2f5f9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f9;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e3e6eb;border-radius:12px;overflow:hidden">
        <tr><td style="background:#0b1220;padding:24px;text-align:center">
          <div style="color:#ffffff;font:700 18px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:-0.01em">Makan Scaling</div>
        </td></tr>
        <tr><td style="padding:28px 28px 8px;text-align:${align}">
          <h1 style="margin:0 0 12px;font:600 20px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;color:#16181c">${opts.heading}</h1>
          <p style="margin:0 0 20px;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#4b5159">${opts.body}</p>
        </td></tr>
        ${
          opts.cta
            ? `<tr><td style="padding:0 28px 24px;text-align:${align}">
          <a href="${opts.cta.url}" style="display:inline-block;background:#6989a6;color:#ffffff;text-decoration:none;font:600 15px/1 -apple-system,Segoe UI,Roboto,sans-serif;padding:14px 24px;border-radius:8px">${opts.cta.label}</a>
          <p style="margin:16px 0 0;font:400 12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#7a828c;word-break:break-all">${opts.cta.url}</p>
        </td></tr>`
            : ""
        }
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #e3e6eb;text-align:${align}">
          <p style="margin:0;font:400 12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#7a828c">${opts.footer}</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

export function inviteEmail(opts: {
  name: string;
  clinicName: string;
  url: string;
  locale: "ar" | "en";
}): { subject: string; html: string; text: string } {
  const ar = opts.locale === "ar";
  const subject = ar ? `دعوة للانضمام إلى ${opts.clinicName}` : `You've been invited to ${opts.clinicName}`;
  const heading = ar ? `مرحباً ${opts.name}` : `Hi ${opts.name}`;
  const body = ar
    ? `تمت دعوتك للانضمام إلى <strong>${opts.clinicName}</strong> على منصة مكان سكيلنج. اضغط الزر أدناه لتعيين كلمة المرور وتفعيل حسابك.`
    : `You've been invited to join <strong>${opts.clinicName}</strong> on Makan Scaling. Set your password below to activate your account.`;
  const label = ar ? "تعيين كلمة المرور" : "Set your password";
  const footer = ar
    ? "هذا الرابط صالح لمدة 7 أيام. إذا لم تكن تتوقع هذه الدعوة، تجاهل هذه الرسالة."
    : "This link is valid for 7 days. If you weren't expecting this invitation, you can ignore this email.";
  return {
    subject,
    html: layout({ heading, body, cta: { url: opts.url, label }, footer, rtl: ar }),
    text: `${heading}\n\n${body.replace(/<[^>]+>/g, "")}\n\n${opts.url}\n\n${footer}`,
  };
}

export function resetEmail(opts: {
  name: string;
  url: string;
  locale: "ar" | "en";
}): { subject: string; html: string; text: string } {
  const ar = opts.locale === "ar";
  const subject = ar ? "إعادة تعيين كلمة المرور" : "Reset your password";
  const heading = ar ? `مرحباً ${opts.name}` : `Hi ${opts.name}`;
  const body = ar
    ? "وصلنا طلب لإعادة تعيين كلمة مرور حسابك. اضغط الزر أدناه لاختيار كلمة مرور جديدة."
    : "We received a request to reset your password. Choose a new one below.";
  const label = ar ? "إعادة تعيين كلمة المرور" : "Reset password";
  const footer = ar
    ? "هذا الرابط صالح لمدة ساعة واحدة. إذا لم تطلب ذلك، تجاهل هذه الرسالة — كلمة مرورك لم تتغير."
    : "This link is valid for one hour. If you didn't request it, ignore this email — your password hasn't changed.";
  return {
    subject,
    html: layout({ heading, body, cta: { url: opts.url, label }, footer, rtl: ar }),
    text: `${heading}\n\n${body}\n\n${opts.url}\n\n${footer}`,
  };
}
