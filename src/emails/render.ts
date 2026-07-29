import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appUrl } from "@/lib/urls";

/**
 * Renders the finished email templates in `templates/`.
 *
 * Those files are production email HTML and are treated as opaque assets:
 * substitution is plain string replacement, never a DOM parser or sanitiser. The
 * `<!--[if mso]>` blocks and the `<v:roundrect>` inside them are what keep the
 * button's radius in Outlook's Word engine, and any DOM-based templating would
 * silently drop them.
 */

export type EmailType = "invitation" | "password-reset";
export type EmailLocale = "en" | "ar";

const cache = new Map<string, string>();

function template(type: EmailType, locale: EmailLocale): string {
  const key = `${type}.${locale}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const html = readFileSync(join(process.cwd(), "src/emails/templates", `${key}.html`), "utf8");
  cache.set(key, html);
  return html;
}

/** Values land inside element text, so angle brackets and quotes must not escape. */
function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The action URL appears four times — the VML href, the button href, the
 * fallback href, and the fallback's visible text. Only `&` needs escaping; the
 * token itself is already base64url, which is URL-safe.
 */
function escapeUrl(v: string): string {
  return v.replace(/&/g, "&amp;");
}

/** Absolute, unauthenticated URL — mail clients cannot resolve relative paths. */
function logoUrl(): string {
  return process.env.EMAIL_LOGO_URL?.trim() || `${appUrl()}/assets/mark-light.png`;
}

const SUBJECTS: Record<EmailType, Record<EmailLocale, (clinic: string) => string>> = {
  invitation: {
    en: (c) => `You have been invited to join ${c}`,
    ar: (c) => `دعوة للانضمام إلى ${c}`,
  },
  "password-reset": {
    en: () => "Reset your password",
    ar: () => "إعادة تعيين كلمة المرور",
  },
};

/** Plain-text alternative. Single-part HTML mail is a well-known spam signal. */
function plainText(opts: {
  type: EmailType;
  locale: EmailLocale;
  name: string;
  clinic: string;
  url: string;
}): string {
  const ar = opts.locale === "ar";
  if (opts.type === "invitation") {
    return ar
      ? `مرحباً ${opts.name}،\n\nتمت إضافتك إلى فريق ${opts.clinic}. اضبط كلمة المرور للبدء.\n\n${opts.url}\n\nتنتهي صلاحية هذه الدعوة بعد 7 أيام.`
      : `Hi ${opts.name},\n\nYou have been added to the ${opts.clinic} team. Set your password to get started.\n\n${opts.url}\n\nThis invitation expires in 7 days.`;
  }
  return ar
    ? `مرحباً ${opts.name}،\n\nوصلنا طلب لإعادة ضبط كلمة مرور حسابك في ${opts.clinic}.\n\n${opts.url}\n\nتنتهي صلاحية هذا الرابط بعد ساعة واحدة.`
    : `Hi ${opts.name},\n\nWe received a request to reset the password for your ${opts.clinic} account.\n\n${opts.url}\n\nThis link expires in 1 hour.`;
}

export function renderEmail(opts: {
  type: EmailType;
  locale: EmailLocale;
  name: string;
  clinic: string;
  url: string;
}): { subject: string; html: string; text: string } {
  const html = template(opts.type, opts.locale)
    .replaceAll("{{name}}", escapeHtml(opts.name))
    .replaceAll("{{clinic}}", escapeHtml(opts.clinic))
    .replaceAll("{{url}}", escapeUrl(opts.url))
    .replaceAll("{{logo_url}}", logoUrl());

  return {
    subject: SUBJECTS[opts.type][opts.locale](opts.clinic),
    html,
    text: plainText(opts),
  };
}
