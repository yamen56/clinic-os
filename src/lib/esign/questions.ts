/**
 * What a signer answers on the signing page, and the patient details they fill
 * in (Yamen, 2026-11-22, modelled on a clinic's paper intake form: "ask the
 * patient some questions … and instead of the values the receptionist fills,
 * make the patient fill them" — "make sure we don't make things complicated").
 *
 * Two things, deliberately kept apart:
 *
 *  - **Questions** a template asks: four kinds only — Yes/No (with room to
 *    explain a yes), a short answer, choose one, tick any. Each is asked of one
 *    kind of signer, the patient unless the clinic says otherwise.
 *  - **Fills**: patient details the document uses that the file did not have
 *    when it was sent. The frozen text carries a marked blank for each; the
 *    patient fills it before signing; the signed copy shows their answer and
 *    their file gains it.
 *
 * Pure: no database, no server imports, so the signing page, the template
 * editor and the print page share one reading of an answer.
 */

export const QUESTION_KINDS = ["yes_no", "text", "select", "choices"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export type SignerQuestion = {
  key: string;
  label: string;
  label_ar: string;
  /** One of QUESTION_KINDS; older templates may still carry longtext/number/date/checkbox. */
  type: string;
  required: boolean;
  options: string[];
  /** Who answers it. Empty means everyone — which is how a doctor got asked about allergies. */
  roles: string[];
};

export type PatientFill = {
  key: string;
  label: string;
  label_ar: string;
  type: string;
  options: string[];
};

/** A yes is worth explaining; the explanation rides beside the answer. */
/**
 * When the signing page asks the questions and the patient's missing details:
 * before the text is shown, on the same page under it, or after it (the
 * default, with the consent tick). Chosen per template, frozen per document.
 */
export const QUESTIONS_AT = ["before", "with", "after"] as const;
export type QuestionsAt = (typeof QUESTIONS_AT)[number];
export function normalizeQuestionsAt(v: unknown): QuestionsAt {
  return v === "before" || v === "with" ? v : "after";
}

export const DETAILS_SUFFIX = "__details";

/** Never asked of the patient: who they are is how the document reached them. */
const IDENTITY_KEYS = new Set(["patient.full_name", "patient.phone"]);
export function isPatientFillable(key: string, scope: string): boolean {
  return scope === "patient" && key.startsWith("patient.") && !IDENTITY_KEYS.has(key);
}

export function questionsForRole(questions: SignerQuestion[], role: string): SignerQuestion[] {
  return questions.filter((q) => !q.roles?.length || q.roles.includes(role));
}

/**
 * Who fills the patient's details: the patient, signing for themselves; for a
 * document with no patient line (a minor's form signed only by a guardian),
 * the guardian. Staff never do — they can still fill a value on the document
 * before it goes out, as before.
 */
export function fillerSignerId(signers: { id: string; role_key: string; user_id: string | null }[]): string | null {
  const outside = signers.filter((s) => !s.user_id);
  return (outside.find((s) => s.role_key === "patient") ?? outside.find((s) => s.role_key === "guardian"))?.id ?? null;
}

export function isAnswered(type: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (type === "checkbox") return value === true;
  if (type === "yes_no") return value === "yes" || value === "no";
  return String(value).trim() !== "";
}

/** The keys a signer still has to answer before they may sign. */
export function unanswered(
  questions: SignerQuestion[],
  fills: PatientFill[],
  answers: Record<string, unknown>
): string[] {
  return [
    ...questions.filter((q) => q.required && !isAnswered(q.type, answers[q.key])).map((q) => q.key),
    ...fills.filter((f) => !isAnswered(f.type, answers[f.key])).map((f) => f.key),
  ];
}

function fmtIsoDate(v: string, locale: "ar" | "en"): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return v;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

const YES = { ar: "نعم", en: "Yes" };
const NO = { ar: "لا", en: "No" };
const GENDER: Record<string, { ar: string; en: string }> = {
  male: { ar: "ذكر", en: "Male" },
  female: { ar: "أنثى", en: "Female" },
};

/** An answer as it reads on paper. */
export function answerText(
  type: string,
  value: unknown,
  locale: "ar" | "en",
  details?: unknown,
  key?: string
): string {
  if (value === undefined || value === null || value === "") return "";
  if (type === "yes_no") {
    const base = value === "yes" ? YES[locale] : value === "no" ? NO[locale] : String(value);
    const extra = typeof details === "string" ? details.trim() : "";
    return extra && value === "yes" ? `${base} — ${extra}` : base;
  }
  if (type === "checkbox" || typeof value === "boolean") return value === true ? YES[locale] : NO[locale];
  if (Array.isArray(value)) return value.map(String).join(locale === "ar" ? "، " : ", ");
  if (type === "date") return fmtIsoDate(String(value), locale);
  if (key === "patient.gender" && GENDER[String(value)]) return GENDER[String(value)][locale];
  return String(value);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The marked blank a frozen document carries for a detail the patient fills. */
export function fillPlaceholder(key: string, label: string): string {
  return `<span class="doc-fill" data-fill="${esc(key)}">${esc(label)}</span>`;
}

const FILL_RE = /<span class="doc-fill" data-fill="([\w.]+)">[^<]*<\/span>/g;

/**
 * The frozen text with the patient's own details in its blanks — for the
 * signed PDF and the document page. The stored snapshot (and its fingerprint)
 * keeps the blanks; what went in them is the signer's recorded answer.
 */
export function fillSnapshot(
  snapshot: string,
  fills: PatientFill[],
  answers: Record<string, unknown>,
  locale: "ar" | "en"
): string {
  if (!fills.length) return snapshot;
  const byKey = new Map(fills.map((f) => [f.key, f]));
  return snapshot.replace(FILL_RE, (whole, key: string) => {
    const f = byKey.get(key);
    const text = f ? answerText(f.type, answers[key], locale, undefined, key) : "";
    return text ? `<span class="doc-filled">${esc(text)}</span>` : whole;
  });
}

/** Every signer's answers merged — each key belongs to exactly one signer. */
export function mergedAnswers(signers: { field_answers?: Record<string, unknown> | null }[]): Record<string, unknown> {
  return Object.assign({}, ...signers.map((s) => s.field_answers ?? {}));
}

/**
 * The answers as a section of the signed document: the question as it was
 * asked, and what was answered — not `q1: yes`, which is how the certificate
 * printed them before.
 */
export function answersSectionHtml(
  questions: SignerQuestion[],
  signers: { name: string; role_key: string; field_answers?: Record<string, unknown> | null }[],
  locale: "ar" | "en"
): string {
  const blocks: string[] = [];
  const answering = signers.filter((s) => questionsForRole(questions, s.role_key).some((q) => isAnswered(q.type, s.field_answers?.[q.key])));
  for (const s of answering) {
    const rows = questionsForRole(questions, s.role_key)
      .map((q) => {
        const a = answerText(q.type, s.field_answers?.[q.key], locale, s.field_answers?.[q.key + DETAILS_SUFFIX], q.key);
        if (!a) return "";
        const label = (locale === "ar" ? q.label_ar || q.label : q.label || q.label_ar) || q.key;
        return `<tr><th>${esc(label)}</th><td>${esc(a)}</td></tr>`;
      })
      .filter(Boolean)
      .join("");
    if (!rows) continue;
    const title = locale === "ar" ? `إجابات ${s.name}` : `${s.name}'s answers`;
    blocks.push(`<h2>${esc(title)}</h2><table>${rows}</table>`);
  }
  return blocks.length ? `<section class="doc-answers">${blocks.join("")}</section>` : "";
}

/**
 * Ready questions, from the paper form a clinic sent (2026-11-22) and what a
 * consent usually asks. Picking one is a tap; writing your own is still there.
 */
export const READY_QUESTIONS: { id: string; label: string; label_ar: string; type: QuestionKind }[] = [
  { id: "health_problems", label: "Do you have any health problems?", label_ar: "هل تعاني من أي مشاكل صحية؟", type: "yes_no" },
  { id: "allergies", label: "Are you allergic to any medicines?", label_ar: "هل لديك حساسية من أي أدوية؟", type: "yes_no" },
  { id: "medicines", label: "Are you taking any medicines now?", label_ar: "هل تتناول أي أدوية حالياً؟", type: "yes_no" },
  { id: "blood_thinners", label: "Do you take blood thinners?", label_ar: "هل تتناول أدوية مميّعة للدم؟", type: "yes_no" },
  { id: "pregnancy", label: "Are you pregnant or breastfeeding?", label_ar: "هل أنتِ حامل أو مرضعة؟", type: "yes_no" },
  { id: "cosmetic_before", label: "Have you had a cosmetic procedure before?", label_ar: "هل سبق أن أجريت إجراءً تجميلياً؟", type: "yes_no" },
  { id: "smoker", label: "Do you smoke?", label_ar: "هل تدخّن؟", type: "yes_no" },
];
