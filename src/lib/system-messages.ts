import type { PoolClient } from "pg";

/**
 * The messages the platform sends by itself, outside the automation engine.
 *
 * A booking confirmation, a verification code, a signing link, a waitlist
 * offer, an invoice: all of these went out in wording that lived in seven
 * different source files, which meant the automations page — the page whose
 * whole promise is "this is what goes out on its own" — was telling the truth
 * about roughly half of it. A clinic that wanted its confirmation to read
 * differently had no way to ask, and no way to even know the message existed
 * until a patient quoted it back.
 *
 * So they live here, as templates with the same {{variable}} syntax the
 * automation builder already uses, and a clinic overrides any of them from the
 * automations page. The default is the fallback, not a copy handed out at
 * creation — see migration 0033 for why that matters.
 */

export type SystemMessageKey =
  | "booking_confirmed"
  | "booking_pending"
  | "booking_otp"
  | "waitlist_offer"
  | "document_sign_request"
  | "document_reminder"
  | "document_bundle"
  | "document_signed_copy"
  | "signing_otp"
  | "invoice_sent"
  | "invoice_receipt";

export type SystemMessageGroup = "booking" | "waitlist" | "documents" | "billing";

export type SystemMessageDef = {
  key: SystemMessageKey;
  group: SystemMessageGroup;
  /**
   * Whether the clinic may switch it off.
   *
   * False where the surrounding flow stops working without it: a patient who is
   * never sent their verification code cannot finish booking, and an unsent
   * signing link is a document nobody can sign. Those stay editable — the
   * wording is the clinic's — but they cannot be silenced, because silencing
   * them looks from the clinic's side like the feature is simply broken.
   */
  canDisable: boolean;
  /** Offered as one-tap chips in the editor, in the order they read best. */
  vars: string[];
  ar: string;
  en: string;
};

export const SYSTEM_MESSAGES: SystemMessageDef[] = [
  {
    key: "booking_confirmed",
    group: "booking",
    canDisable: true,
    vars: [
      "patient.first_name",
      "patient.name",
      "clinic.name",
      "appointment.service",
      "appointment.doctor",
      "appointment.when",
      "clinic.address",
    ],
    ar: [
      "مرحباً {{patient.first_name}} 👋",
      "تم تأكيد موعدك في {{clinic.name}}:",
      "{{appointment.service}}",
      "{{appointment.doctor}}",
      "🗓 {{appointment.when}}",
      "{{clinic.address}}",
    ].join("\n"),
    en: [
      "Hi {{patient.first_name}} 👋",
      "Your appointment at {{clinic.name}} is confirmed:",
      "{{appointment.service}}",
      "{{appointment.doctor}}",
      "🗓 {{appointment.when}}",
      "{{clinic.address}}",
    ].join("\n"),
  },
  {
    key: "booking_pending",
    group: "booking",
    canDisable: true,
    vars: ["patient.first_name", "patient.name", "clinic.name", "appointment.when", "appointment.service"],
    ar: "مرحباً {{patient.first_name}}، استلمنا طلب حجزك في {{clinic.name}} ليوم {{appointment.when}}. سنؤكده لك قريباً.",
    en: "Hi {{patient.first_name}}, we received your booking request at {{clinic.name}} for {{appointment.when}}. We'll confirm it shortly.",
  },
  {
    key: "booking_otp",
    group: "booking",
    canDisable: false,
    vars: ["code", "clinic.name"],
    ar: "{{code}} هو رمز التحقق الخاص بك من {{clinic.name}}.",
    en: "{{code}} is your {{clinic.name}} verification code.",
  },
  {
    key: "waitlist_offer",
    group: "waitlist",
    canDisable: true,
    vars: ["patient.first_name", "clinic.name", "appointment.when", "link"],
    ar: [
      "مرحباً {{patient.first_name}} 👋",
      "فضي موعد في {{clinic.name}}:",
      "📅 {{appointment.when}}",
      "",
      "إذا بناسبك احجزه من هنا قبل ما ينحجز:",
      "{{link}}",
    ].join("\n"),
    en: [
      "Hello {{patient.first_name}} 👋",
      "A slot has opened at {{clinic.name}}:",
      "📅 {{appointment.when}}",
      "",
      "If it suits you, book it here before someone else does:",
      "{{link}}",
    ].join("\n"),
  },
  {
    key: "document_sign_request",
    group: "documents",
    canDisable: false,
    vars: ["patient.first_name", "clinic.name", "document.title", "link"],
    ar: [
      "مرحباً {{patient.first_name}}، من {{clinic.name}}.",
      "لديك مستند بحاجة إلى توقيعك: {{document.title}}",
      "افتح الرابط لقراءته وتوقيعه — يستغرق أقل من دقيقة:",
      "{{link}}",
    ].join("\n"),
    en: [
      "Hi {{patient.first_name}}, this is {{clinic.name}}.",
      "You have a document to sign: {{document.title}}",
      "Open the link to read and sign it — it takes under a minute:",
      "{{link}}",
    ].join("\n"),
  },
  {
    key: "document_reminder",
    group: "documents",
    canDisable: true,
    vars: ["patient.first_name", "clinic.name", "document.title", "link"],
    ar: 'تذكير من {{clinic.name}}: ما زال المستند "{{document.title}}" بانتظار توقيعك.\n{{link}}',
    en: 'A reminder from {{clinic.name}}: "{{document.title}}" is still waiting for your signature.\n{{link}}',
  },
  {
    key: "document_bundle",
    group: "documents",
    canDisable: false,
    vars: ["patient.first_name", "clinic.name", "document.count", "document.list"],
    ar: [
      "مرحباً {{patient.first_name}}، من {{clinic.name}}.",
      "لديك {{document.count}} مستندات بحاجة إلى توقيعك. لكل واحد رابط خاص به:",
      "",
      "{{document.list}}",
    ].join("\n"),
    en: [
      "Hi {{patient.first_name}}, this is {{clinic.name}}.",
      "You have {{document.count}} documents waiting for your signature. Each has its own link:",
      "",
      "{{document.list}}",
    ].join("\n"),
  },
  {
    key: "document_signed_copy",
    group: "documents",
    canDisable: true,
    vars: ["clinic.name", "document.title"],
    ar: 'شكراً لك. هذه نسختك الموقّعة من "{{document.title}}" من {{clinic.name}}. احتفظ بها لسجلاتك.',
    en: 'Thank you. Here is your signed copy of "{{document.title}}" from {{clinic.name}}. Keep it for your records.',
  },
  {
    key: "signing_otp",
    group: "documents",
    canDisable: false,
    vars: ["code", "clinic.name"],
    ar: "{{code}} هو رمز تأكيد توقيعك.",
    en: "{{code}} is your signing verification code.",
  },
  {
    key: "invoice_sent",
    group: "billing",
    canDisable: false,
    vars: ["clinic.name", "invoice.number", "invoice.total", "invoice.link"],
    ar: "فاتورتك من {{clinic.name}}\nرقم {{invoice.number}} — الإجمالي {{invoice.total}}\n{{invoice.link}}",
    en: "Your invoice from {{clinic.name}}\n{{invoice.number}} — total {{invoice.total}}\n{{invoice.link}}",
  },
  {
    key: "invoice_receipt",
    group: "billing",
    canDisable: false,
    vars: ["clinic.name", "invoice.number", "invoice.paid", "invoice.link"],
    ar: "إيصال الدفع من {{clinic.name}}\nرقم {{invoice.number}} — مدفوع {{invoice.paid}}\n{{invoice.link}}",
    en: "Payment receipt from {{clinic.name}}\n{{invoice.number}} — paid {{invoice.paid}}\n{{invoice.link}}",
  },
];

export const SYSTEM_MESSAGE_KEYS: string[] = SYSTEM_MESSAGES.map((m) => m.key);

export function systemMessageDef(key: string): SystemMessageDef | undefined {
  return SYSTEM_MESSAGES.find((m) => m.key === key);
}

export type Lang = "ar" | "en";

/**
 * Fills {{variables}} in, then drops the lines that were only ever variables.
 *
 * The second half is what makes an optional value safe to put in a template. A
 * booking with no doctor assigned, or a clinic with no address on file, would
 * otherwise leave a blank line in the middle of the message — the sort of small
 * wrongness a patient notices and the clinic gets blamed for. A line is removed
 * only when it held a token and rendered to nothing, so a deliberate blank line
 * between paragraphs survives.
 */
export function renderSystemMessage(template: string, vars: Record<string, string>): string {
  return template
    .split("\n")
    .map((line) => {
      const hadToken = /\{\{\s*[\w.]+\s*\}\}/.test(line);
      const out = line.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => vars[path] ?? "");
      return hadToken && !out.trim() ? null : out;
    })
    .filter((line): line is string => line !== null)
    .join("\n")
    .trim();
}

export type SystemMessageState = { enabled: boolean; ar: string; en: string };

/** A clinic's full set: its overrides layered on the defaults. */
export async function loadSystemMessages(
  c: PoolClient,
  clinicId: string
): Promise<Record<string, SystemMessageState>> {
  const rows = await c.query(
    `select key, enabled, body_ar, body_en from clinic_system_messages where clinic_id = $1`,
    [clinicId]
  );
  const overrides = new Map<string, { enabled: boolean; body_ar: string; body_en: string }>(
    rows.rows.map((r) => [r.key as string, r])
  );
  const out: Record<string, SystemMessageState> = {};
  for (const def of SYSTEM_MESSAGES) {
    const o = overrides.get(def.key);
    out[def.key] = {
      enabled: o ? o.enabled : true,
      // An empty override body means "unchanged", so clearing the box in the
      // editor restores the default rather than sending an empty message.
      ar: o?.body_ar?.trim() ? o.body_ar : def.ar,
      en: o?.body_en?.trim() ? o.body_en : def.en,
    };
  }
  return out;
}

/**
 * The wording one clinic uses for one message, before any variables are filled.
 *
 * Separate from `systemMessage` for the fan-out cases — a waitlist offer going
 * to five people is one clinic's wording and five names, and reading the row
 * five times to discover that would be five queries to learn one thing.
 */
export async function systemMessageTemplate(
  c: PoolClient,
  clinicId: string,
  key: SystemMessageKey,
  lang: Lang
): Promise<{ enabled: boolean; template: string }> {
  const def = systemMessageDef(key);
  if (!def) return { enabled: false, template: "" };

  const r = await c.query(
    `select enabled, body_ar, body_en from clinic_system_messages where clinic_id = $1 and key = $2`,
    [clinicId, key]
  );
  const row = r.rows[0];
  if (row && def.canDisable && !row.enabled) return { enabled: false, template: "" };

  const override = lang === "ar" ? row?.body_ar : row?.body_en;
  return {
    enabled: true,
    template: override && String(override).trim() ? String(override) : def[lang],
  };
}

/**
 * One message, ready to send.
 *
 * Returns `enabled: false` rather than an empty body when a clinic has switched
 * it off, so the caller can skip the whole surrounding step instead of queueing
 * a blank WhatsApp message.
 */
export async function systemMessage(
  c: PoolClient,
  args: {
    clinicId: string;
    key: SystemMessageKey;
    lang: Lang;
    vars: Record<string, string>;
  }
): Promise<{ enabled: boolean; body: string }> {
  const t = await systemMessageTemplate(c, args.clinicId, args.key, args.lang);
  return t.enabled
    ? { enabled: true, body: renderSystemMessage(t.template, args.vars) }
    : { enabled: false, body: "" };
}
