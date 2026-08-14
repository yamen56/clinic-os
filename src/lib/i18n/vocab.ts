import type { Dict } from "./en";
import type { Locale } from "./index";

/**
 * The words one workspace uses for the objects every other workspace shares.
 *
 * Clinicti runs its own business inside Clinicti: the rows in `patients` are the
 * clinics it sells to, and the document it sends them is a service agreement
 * rather than a consent form. Nothing underneath changes — same tables, same
 * routes, same code paths — because the product is right for every tenant but
 * this one, and forking the schema per tenant would mean maintaining the same
 * bugs twice.
 *
 * So this is a patch over the dictionary, not a second dictionary. It lists only
 * the strings that would read as wrong, which keeps it small enough to stay
 * correct: a term added to `en.ts` tomorrow simply keeps its default wording
 * here until somebody decides it needs different words, rather than silently
 * going missing.
 */

/** Deep merge, arrays and primitives replaced whole. */
function merge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = merge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

type Patch = Record<string, unknown>;

const AGENCY_EN: Patch = {
  nav: { patients: "Clinics", documents: "Contracts", waitlist: "Pipeline" },
  patients: {
    title: "Clinics",
    newPatient: "New clinic",
    searchPlaceholder: "Search by clinic or phone…",
    fullName: "Clinic name",
    phone: "Phone",
    secondaryPhone: "Second contact",
    birthDate: "Signed up on",
    lastVisit: "Last contact",
    noPatients: "No clinics yet",
    noPatientsBody:
      "Add your first clinic, or they'll appear here automatically when they message you on WhatsApp.",
    showingOf: "Showing {shown} of {total} — use search to find a specific clinic.",
    existingPatient: "A clinic with this number already exists — opened their file.",
    phoneTaken: "Another clinic already has this number",
    sources: { staff: "Added by us", booking_link: "Demo link", ai_agent: "AI agent" },
    statusLead: "Prospect",
    statusActive: "Subscribed",
    statusArchived: "Churned",
  },
  /*
    The signing module is where the framing matters most. A clinic signing with
    Clinicti is agreeing to a commercial contract, not consenting to treatment,
    and "consent" on that screen would be actively misleading about what the
    signature means.
  */
  docs: {
    title: "Contracts",
    newDocument: "New contract",
    forPatient: "For {name}",
  },
  sign: {
    consentLabel:
      "I have read this agreement, I agree to its terms, and I accept that my electronic signature is as binding as a handwritten one.",
  },
  invoices: { patient: "Clinic" },
  calendar: { newAppointment: "New meeting" },
  waitlist: {
    sub: "Clinics waiting on a slot. When one frees up they are offered it automatically.",
    patient: "Clinic",
  },
};

/*
  Signer role labels are not here on purpose. They live in `signer_roles`, one
  set of rows per clinic, and are already editable in settings — so this
  workspace renames "Patient" to "Clinic" there by editing its own row, the same
  way any clinic would. Overriding them in the dictionary would fight the
  database and win only until somebody edited it.
*/

const AGENCY_AR: Patch = {
  nav: { patients: "العيادات", documents: "العقود", waitlist: "العملاء المحتملون" },
  patients: {
    title: "العيادات",
    newPatient: "عيادة جديدة",
    searchPlaceholder: "ابحث بالاسم أو الرقم…",
    fullName: "اسم العيادة",
    secondaryPhone: "رقم إضافي",
    birthDate: "تاريخ الاشتراك",
    lastVisit: "آخر تواصل",
    noPatients: "لا توجد عيادات بعد",
    noPatientsBody: "أضف أول عيادة، أو ستظهر هنا تلقائياً عند مراسلتك على واتساب.",
    showingOf: "عرض {shown} من {total} — استخدم البحث للوصول إلى عيادة معيّنة.",
    existingPatient: "توجد عيادة بهذا الرقم — تم فتح ملفها.",
    phoneTaken: "هذا الرقم مسجّل لعيادة أخرى",
    sources: { staff: "أضفناها", booking_link: "رابط العرض", ai_agent: "المساعد الذكي" },
    statusLead: "عميل محتمل",
    statusActive: "مشترِكة",
    statusArchived: "منتهية",
  },
  docs: {
    title: "العقود",
    newDocument: "عقد جديد",
    forPatient: "لـ {name}",
  },
  sign: {
    consentLabel:
      "قرأت هذه الاتفاقية وأوافق على شروطها، وأقبل أن توقيعي الإلكتروني ملزم كالتوقيع بخط اليد.",
  },
  invoices: { patient: "العيادة" },
  calendar: { newAppointment: "اجتماع جديد" },
  waitlist: {
    sub: "عيادات تنتظر موعداً أقرب. عند إلغاء أي موعد يُعرض عليها تلقائياً.",
    patient: "العيادة",
  },
};

export type Vocabulary = "medical" | "agency";

/**
 * The dictionary this workspace should speak.
 *
 * `medical` returns the base dictionary untouched — the same object, not a copy
 * — so every clinic but one pays nothing for this existing.
 */
export function applyVocabulary(dict: Dict, vocabulary: Vocabulary, locale: Locale): Dict {
  if (vocabulary !== "agency") return dict;
  return merge(dict, locale === "en" ? AGENCY_EN : AGENCY_AR);
}
