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

export type EmailType =
  | "invitation"
  | "password-reset"
  | "welcome"
  | "member-joined"
  | "payment-overdue"
  | "account-suspended";
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

export type RenderOptions = {
  type: EmailType;
  locale: EmailLocale;
  /** The recipient. */
  name: string;
  clinic: string;
  url: string;
  /** The recipient's own address — the welcome repeats it as the sign-in name. */
  email?: string;
  /** The colleague a member-joined email is about. */
  member?: { name: string; email: string };
};

const SUBJECTS: Record<EmailType, Record<EmailLocale, (o: RenderOptions) => string>> = {
  invitation: {
    en: (o) => `You have been invited to join ${o.clinic}`,
    ar: (o) => `دعوة للانضمام إلى ${o.clinic}`,
  },
  "password-reset": {
    en: () => "Reset your password",
    ar: () => "إعادة تعيين كلمة المرور",
  },
  welcome: {
    en: (o) => `Welcome to ${o.clinic}`,
    ar: (o) => `أهلًا بك في ${o.clinic}`,
  },
  "member-joined": {
    en: (o) => `${o.member?.name ?? ""} has joined ${o.clinic}`,
    ar: (o) => `${o.member?.name ?? ""} الآن ضمن فريق ${o.clinic}`,
  },
  "payment-overdue": {
    en: (o) => `Your ${o.clinic} subscription is past due`,
    ar: (o) => `اشتراك ${o.clinic} متأخر السداد`,
  },
  "account-suspended": {
    en: (o) => `Access to ${o.clinic} is paused`,
    ar: (o) => `تم إيقاف الوصول إلى ${o.clinic} مؤقتًا`,
  },
};

/** Plain-text alternative. Single-part HTML mail is a well-known spam signal. */
function plainText(opts: RenderOptions): string {
  const ar = opts.locale === "ar";
  const app = appUrl();
  switch (opts.type) {
    case "welcome":
      return ar
        ? `أهلًا بك، ${opts.name}

تم ضبط كلمة المرور وأصبحت الآن جزءًا من فريق ${opts.clinic}.

سجّل الدخول من: ${app}/login
باستخدام بريدك الإلكتروني: ${opts.email ?? ""}

${opts.url}

إذا لم تضبط كلمة المرور بنفسك، أعد تعيينها الآن: ${app}/forgot`
        : `Welcome, ${opts.name}

Your password is set and you are now part of the ${opts.clinic} team.

Sign in at: ${app}/login
With your email: ${opts.email ?? ""}

${opts.url}

If you did not set this password, reset it now: ${app}/forgot`;
    case "member-joined":
      return ar
        ? `مرحبًا ${opts.name}،

تم قبول دعوتك، و${opts.member?.name ?? ""} (${opts.member?.email ?? ""}) الآن ضمن فريق ${opts.clinic}. يمكنك مراجعة صلاحيات العضو الجديد أو تغييرها في أي وقت.

${opts.url}`
        : `Hi ${opts.name},

${opts.member?.name ?? ""} (${opts.member?.email ?? ""}) accepted your invitation and has joined the ${opts.clinic} team. You can review what they have access to at any time.

${opts.url}`;
    case "payment-overdue":
      return ar
        ? `مرحبًا ${opts.name}،

اشتراك ${opts.clinic} في كلينيكتي متأخر السداد. كل شيء يعمل حاليًا — هذا تذكير كي يبقى كذلك.

إذا بقي دون سداد، قد يُوقف الوصول مؤقتًا: لن يتمكن فريقك من تسجيل الدخول، وستُغلق صفحة الحجز الإلكتروني. لا يُحذف أي شيء.

للسداد، أو إذا كنت قد دفعت بالفعل، ما عليك إلا الرد على هذه الرسالة.`
        : `Hi ${opts.name},

The Clinicti subscription for ${opts.clinic} is past due. Everything is still working — this is a reminder so it stays that way.

If it stays unpaid, access may be paused: your team will not be able to sign in, and your online booking page will close. Nothing is deleted.

To settle it, or if you have already paid, just reply to this email.`;
    case "account-suspended":
      return ar
        ? `مرحبًا ${opts.name}،

تم إيقاف اشتراك ${opts.clinic} في كلينيكتي مؤقتًا، لذا لم يعد بإمكان فريقك تسجيل الدخول، وصفحة الحجز الإلكتروني مغلقة.

لا يُحذف أي شيء: المرضى والمواعيد والسجلات والمستندات محفوظة كما هي، وكل شيء يعود فور تسوية الاشتراك.

لاستعادة الوصول، ما عليك إلا الرد على هذه الرسالة.`
        : `Hi ${opts.name},

The Clinicti subscription for ${opts.clinic} has been paused, so your team can no longer sign in and your online booking page is closed.

Nothing is deleted: patients, appointments, records and documents are kept exactly as they are, and everything comes back the moment the subscription is settled.

To restore access, just reply to this email.`;
    case "invitation":
      return ar
        ? `مرحباً ${opts.name}،

تمت إضافتك إلى فريق ${opts.clinic}. اضبط كلمة المرور للبدء.

${opts.url}

تنتهي صلاحية هذه الدعوة بعد 7 أيام.`
        : `Hi ${opts.name},

You have been added to the ${opts.clinic} team. Set your password to get started.

${opts.url}

This invitation expires in 7 days.`;
    case "password-reset":
      return ar
        ? `مرحباً ${opts.name}،

وصلنا طلب لإعادة ضبط كلمة مرور حسابك في ${opts.clinic}.

${opts.url}

تنتهي صلاحية هذا الرابط بعد ساعة واحدة.`
        : `Hi ${opts.name},

We received a request to reset the password for your ${opts.clinic} account.

${opts.url}

This link expires in 1 hour.`;
  }
}

export function renderEmail(opts: RenderOptions): { subject: string; html: string; text: string } {
  const app = appUrl();
  const html = template(opts.type, opts.locale)
    .replaceAll("{{name}}", escapeHtml(opts.name))
    .replaceAll("{{clinic}}", escapeHtml(opts.clinic))
    .replaceAll("{{email}}", escapeHtml(opts.email ?? ""))
    .replaceAll("{{member_name}}", escapeHtml(opts.member?.name ?? ""))
    .replaceAll("{{member_email}}", escapeHtml(opts.member?.email ?? ""))
    .replaceAll("{{url}}", escapeUrl(opts.url))
    .replaceAll("{{app_url}}", escapeUrl(app))
    .replaceAll("{{app_host}}", escapeHtml(new URL(app).host))
    .replaceAll("{{logo_url}}", logoUrl());

  return {
    subject: SUBJECTS[opts.type][opts.locale](opts),
    html,
    text: plainText(opts),
  };
}
