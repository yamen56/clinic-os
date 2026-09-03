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
 *
 * `scripts/qa-vocabulary.ts` fails the build if any path below names a key that
 * does not exist in the base dictionary, which is what stops this file rotting
 * quietly as the product is renamed around it.
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
    secondaryPhone: "Second contact",
    birthDate: "Signed up on",
    lastVisit: "Last contact",
    noPatients: "No clinics yet",
    noPatientsBody:
      "Add your first clinic, or they'll appear here automatically when they message you on WhatsApp.",
    showingOf: "Showing {shown} of {total} — use search to find a specific clinic.",
    existingPatient: "A clinic with this number already exists — opened their file.",
    phoneTaken: "Another clinic already has this number",
    sources: { staff: "Added by us", booking_link: "Demo link" },
    statusLead: "Prospect",
    statusActive: "Subscribed",
    statusArchived: "Churned",
    /*
      The rest of the file's own screen. The sidebar already said Clinics while
      the record inside it still offered to "Archive patient" and tabbed to
      "Documents" — one workspace speaking two languages about the same row.
    */
    archive: "Archive clinic",
    archived: "Clinic archived",
    restore: "Restore clinic",
    messageNoPhone: "Add a phone number before messaging this clinic.",
    merge: {
      title: "Merge clinic records",
      hint: "Moves all notes, meetings, invoices, and conversations from the other record into this one, and keeps both phone numbers here.",
    },
    overview: { summaryPlaceholder: "Important things to remember about this clinic…" },
    tabs: { appointments: "Meetings", documents: "Contracts" },
    exportAllEmpty: "No clinics match this filter, so there is nothing to export.",
    exportAllTooMany:
      "{n} clinics is more than one document can hold ({max} at a time). Narrow the list with a search or filter, then export again.",
    automations: {
      onHint: "Reminders, follow-ups and campaigns are sent to this clinic.",
      offHint:
        "No automation or campaign will message this clinic. Your team can still message them by hand, and booking confirmations still go out.",
    },
    filters: { mutedOnly: "Muted only" },
  },
  /*
    The inbox was entirely unpatched, which meant the one screen the team lives
    in all day was also the one most insistent that these are patients.
  */
  conversations: {
    emptyBody: "When clinics message you on WhatsApp, threads appear here.",
    noPatient: "No clinic file linked",
    createPatient: "Create clinic file",
    patientCreated: "Clinic file created",
    newPatientLead: "New prospect",
  },
  /*
    `calendar.newAppointment` was already patched to "New meeting", so the panel
    said New meeting at the top and labelled its main field "Patient".
  */
  calendar: {
    newAppointment: "New meeting",
    editAppointment: "Edit meeting",
    deleteAppointment: "Cancel meeting",
    patient: "Clinic",
    createNew: "Create new clinic",
    bookingAnswers: "What they told the booking page",
    doctor: "Who's meeting them",
    allDoctors: "Everyone",
    noDoctor: "Unassigned",
  },
  automations: {
    triggers: {
      patient_created: "New clinic is added",
      birthday: "Clinic's anniversary",
    },
    conditions: {
      has_tag: "Clinic has tag",
      replied: "Clinic replied",
    },
    optOut: "Clinics that opted out",
    optOutCount: "{n} clinics are muted",
    /*
      `messageHint` is deliberately not here: it names the real merge variable
      `{{patient.first_name}}`, and renaming that in the help text would send
      somebody looking for a variable that does not exist.
    */
  },
  invoices: {
    patient: "Clinic",
    emptyBody: "Create an invoice from a clinic's file or right here.",
    noPhone: "This clinic has no WhatsApp number on file.",
    viewPublic: "Clinic view",
    selectPatient: "Choose a clinic first",
  },
  waitlist: {
    sub: "Clinics waiting on a slot. When one frees up they are offered it automatically.",
    patient: "Clinic",
    createPatient: "Add them as a new clinic",
    alreadyWaiting: "This clinic is already on the list",
    emptyBody: "Add a clinic here when they ask for something sooner than you could offer.",
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
    sub: "Agreements and the clinics that still have to sign them.",
    relationship: "Relationship to the clinic",
    fromPatient: "From the clinic's file",
    /*
      `roles.patient` is the fallback used when a `signer_roles` row is missing.
      Normally the database row wins and this workspace edits its own — but that
      fallback path exists, and "Patient" is the wrong word to fall back to here.
    */
    roles: { patient: "Clinic" },
  },
  sign: {
    consentLabel:
      "I have read this agreement, I agree to its terms, and I accept that my electronic signature is as binding as a handwritten one.",
  },
  /* Settings screens that name the thing they configure. */
  tags: { title: "Clinic tags" },
  fields: { title: "Clinic fields" },
  import: { title: "Import clinics" },
  insurers: {
    // "The companies this clinic bills" becomes ambiguous the moment "clinic"
    // means the customer rather than us.
    sub: "Companies that pay on a clinic's behalf. Set one on a file to split an invoice.",
  },
  bookingSettings: {
    sub: "Public pages where clinics book time with you.",
    restrictDoctor: "Only this person",
  },
  /* The spreadsheet export: its values were already relabelled, its headers not. */
  patientSheet: {
    sheetPatients: "Clinics",
    sheetAppointments: "Meetings",
    id: "Clinic ID",
    patientId: "Clinic ID",
    name: "Clinic name",
    birthDate: "Signed up on",
    lastVisit: "Last contact",
    visitsCount: "Meetings",
  },
  /*
    The front page. Every number here already exists; only what it is called
    changes, so a software business reads its own dashboard rather than a
    clinic's.
  */
  dashboard: {
    todayAppointments: "Today's meetings",
    noAppointmentsToday: "No meetings today",
    emptyDay: "A quiet day — nothing booked yet.",
    unconfirmed: "meetings to confirm",
    newAppointment: "Meeting",
    newPatient: "Clinic",
    revenueWeek: "Collected this week",
    outstanding: "Owed by clinics",
    newPatientsMonth: "New clinics this month",
    appointmentsTrend: "Meetings, last 14 days",
    byDoctor: "By rep, this month",
    byDoctorSub: "Completed meetings, and how many were missed",
    noShowRate: "Missed meetings this month",
    demosMonth: "Demos booked this month",
    noShowShare: "{n}% of finished meetings were missed this month",
    topServices: "What earns, this month",
  },
  /*
    The public booking page. Until now it imported the raw dictionaries and could
    not be re-worded at all, which is why a prospect booking a demo was asked to
    "Choose a doctor" and offered a button to "Call the clinic".
  */
  book: {
    chooseService: "What would you like to book?",
    chooseDoctor: "Who would you like to meet?",
    anyDoctor: "First available",
    phone: "WhatsApp number",
    phoneHint: "We'll send a confirmation code to this number on WhatsApp.",
    booked: "You're booked in!",
    bookedBody: "We sent the details to your WhatsApp, including how to join.",
    bookedPendingBody: "We'll confirm your time shortly on WhatsApp.",
    fewMoreHint: "We ask these so the call is about your clinic rather than a generic tour.",
    callClinic: "Call us",
    bookAgain: "Book another time",
    notFound: "This booking page doesn't exist or is no longer active.",
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
    sources: { staff: "أضفناها", booking_link: "رابط العرض" },
    statusLead: "عميل محتمل",
    statusActive: "مشترِكة",
    statusArchived: "منتهية",
    archive: "أرشفة العيادة",
    archived: "تمت أرشفة العيادة",
    restore: "استعادة العيادة",
    messageNoPhone: "أضف رقم هاتف قبل مراسلة هذه العيادة.",
    merge: {
      title: "دمج ملفّي عيادة",
      hint: "ينقل كل الملاحظات والاجتماعات والفواتير والمحادثات من الملف الآخر إلى هذا، ويحتفظ بالرقمين معاً.",
    },
    overview: { summaryPlaceholder: "أمور مهمة تتذكّرها عن هذه العيادة…" },
    tabs: { appointments: "الاجتماعات", documents: "العقود" },
    exportAllEmpty: "لا توجد عيادات مطابقة لهذه التصفية، فلا شيء لتصديره.",
    exportAllTooMany:
      "{n} عيادة أكثر مما يتّسع له ملف واحد ({max} في المرة). ضيّق القائمة بالبحث أو التصفية ثم صدّر مرة أخرى.",
    automations: {
      onHint: "التذكيرات والمتابعات والحملات تُرسل إلى هذه العيادة.",
      offHint:
        "لن ترسل لها أي أتمتة أو حملة. يبقى بإمكان الفريق مراسلتها يدوياً، وتأكيدات الحجز تُرسل كالمعتاد.",
    },
    filters: { mutedOnly: "الموقوفة رسائلها فقط" },
  },
  conversations: {
    emptyBody: "عند مراسلة العيادات لك على واتساب ستظهر المحادثات هنا.",
    noPatient: "لا يوجد ملف عيادة مرتبط",
    createPatient: "إنشاء ملف عيادة",
    patientCreated: "تم إنشاء ملف العيادة",
    newPatientLead: "عميل محتمل جديد",
  },
  calendar: {
    newAppointment: "اجتماع جديد",
    editAppointment: "تعديل الاجتماع",
    deleteAppointment: "إلغاء الاجتماع",
    patient: "العيادة",
    createNew: "إنشاء عيادة جديدة",
    bookingAnswers: "ما ذكروه في صفحة الحجز",
    doctor: "من سيقابلهم",
    allDoctors: "الجميع",
    noDoctor: "غير محدد",
  },
  automations: {
    triggers: {
      patient_created: "إضافة عيادة جديدة",
      birthday: "ذكرى اشتراك العيادة",
    },
    conditions: {
      has_tag: "العيادة تحمل وسماً",
      replied: "العيادة ردّت",
    },
    optOut: "عيادات أوقفت الرسائل",
    optOutCount: "{n} عيادة موقوفة رسائلها",
  },
  invoices: {
    patient: "العيادة",
    emptyBody: "أنشئ فاتورة من ملف العيادة أو من هنا مباشرة.",
    noPhone: "لا يوجد رقم واتساب لهذه العيادة.",
    viewPublic: "عرض العيادة",
    selectPatient: "اختر عيادة أولاً",
  },
  waitlist: {
    sub: "عيادات تنتظر موعداً أقرب. عند إلغاء أي موعد يُعرض عليها تلقائياً.",
    patient: "العيادة",
    createPatient: "أضفها كعيادة جديدة",
    alreadyWaiting: "هذه العيادة مدرجة بالفعل",
    emptyBody: "أضف عيادة هنا عندما تطلب موعداً أقرب مما يمكنك تقديمه.",
  },
  docs: {
    title: "العقود",
    newDocument: "عقد جديد",
    forPatient: "لـ {name}",
    sub: "الاتفاقيات، ومن لم يوقّع منها بعد.",
    relationship: "الصفة تجاه العيادة",
    fromPatient: "من ملف العيادة",
    roles: { patient: "العيادة" },
  },
  sign: {
    consentLabel:
      "قرأت هذه الاتفاقية وأوافق على شروطها، وأقبل أن توقيعي الإلكتروني ملزم كالتوقيع بخط اليد.",
  },
  tags: { title: "وسوم العيادات" },
  fields: { title: "حقول العيادة" },
  import: { title: "استيراد العيادات" },
  insurers: {
    sub: "الجهات التي تدفع نيابة عن العيادة. حدّد واحدة على الملف لتقسيم الفاتورة.",
  },
  bookingSettings: {
    sub: "صفحات عامة تحجز فيها العيادات وقتاً معك.",
    restrictDoctor: "هذا الشخص فقط",
  },
  patientSheet: {
    sheetPatients: "العيادات",
    sheetAppointments: "الاجتماعات",
    id: "رقم العيادة",
    patientId: "رقم العيادة",
    name: "اسم العيادة",
    birthDate: "تاريخ الاشتراك",
    lastVisit: "آخر تواصل",
    visitsCount: "الاجتماعات",
  },
  dashboard: {
    todayAppointments: "اجتماعات اليوم",
    noAppointmentsToday: "لا اجتماعات اليوم",
    emptyDay: "يوم هادئ — لا شيء محجوز بعد.",
    unconfirmed: "اجتماعات بانتظار التأكيد",
    newAppointment: "اجتماع",
    newPatient: "عيادة",
    revenueWeek: "المحصّل هذا الأسبوع",
    outstanding: "مستحق على العيادات",
    newPatientsMonth: "عيادات جديدة هذا الشهر",
    appointmentsTrend: "الاجتماعات، آخر ١٤ يوماً",
    byDoctor: "حسب الموظف، هذا الشهر",
    byDoctorSub: "الاجتماعات المنجزة، وكم منها فات",
    noShowRate: "اجتماعات فائتة هذا الشهر",
    demosMonth: "عروض توضيحية هذا الشهر",
    noShowShare: "{n}% من الاجتماعات المنتهية فاتت هذا الشهر",
    topServices: "الأعلى دخلاً هذا الشهر",
  },
  book: {
    chooseService: "ما الذي تودّ حجزه؟",
    chooseDoctor: "مع من تودّ الاجتماع؟",
    anyDoctor: "أول موعد متاح",
    phone: "رقم واتساب",
    phoneHint: "سنرسل رمز التأكيد إلى هذا الرقم على واتساب.",
    booked: "تم حجز موعدك!",
    bookedBody: "أرسلنا التفاصيل ورابط الانضمام إلى واتساب.",
    bookedPendingBody: "سنؤكّد موعدك قريباً على واتساب.",
    fewMoreHint: "نسأل هذه الأسئلة ليكون اللقاء عن عيادتك تحديداً لا جولة عامة.",
    callClinic: "اتصل بنا",
    bookAgain: "حجز موعد آخر",
    notFound: "صفحة الحجز هذه غير موجودة أو لم تعد فعّالة.",
  },
};

/*
  Exported for `scripts/qa-vocabulary.ts` alone, which walks both patches and
  asserts they carry the same leaves. That check is what replaces reading the
  file: at twenty-eight entries you could eyeball the two lists, and at a
  hundred and forty you cannot — and the failure it catches, an English string
  left on an Arabic right-to-left screen, is invisible to anyone testing in
  English.
*/
export const AGENCY_PATCHES = { en: AGENCY_EN, ar: AGENCY_AR };

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
