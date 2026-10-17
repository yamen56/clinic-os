import { Client } from "pg";
import { SPECIALTY_RECIPES } from "./specialty-recipes";

/**
 * Agency-level defaults: automation recipes + AI knowledge structure.
 * Copied (disabled, fully editable) into every clinic on creation.
 */

export type RecipeStep = {
  step_type: string;
  config?: Record<string, unknown>;
  /** Branches by output: yes / no, or a reply step's opt:0, other, timeout… */
  children?: Record<string, RecipeStep[] | undefined>;
};

export type Recipe = {
  key: string;
  name: string;
  name_ar: string;
  description: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  sort: number;
  steps: RecipeStep[];
  /** Omitted means 'general': suits every clinic, whatever it practises. */
  specialty?: string;
};

/*
  Words that mean "yes, I'll come" and "I need to change it", as patients in
  Jordan actually type them. Matching ignores tashkeel, alef and taa-marbuta
  spelling and reads ١ as 1, so one spelling of each is enough.
*/
const CONFIRM_WORDS = ["1", "نعم", "اكيد", "تمام", "موافق", "تأكيد", "ok", "yes", "confirm", "👍"];
const CHANGE_WORDS = ["2", "تغيير", "تأجيل", "الغاء", "لا", "مش رح اقدر", "change", "cancel", "no"];

export const RECIPES: Recipe[] = [
  {
    key: "welcome_new_patient",
    name: "Welcome a new patient",
    name_ar: "ترحيب بمريض جديد",
    description: "Greets a patient on WhatsApp as soon as their file is created.",
    trigger_type: "patient_created",
    trigger_config: {},
    sort: 0,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          /*
            Deliberately an opening, not an announcement. This is very often the
            clinic's first message to this number, and a first message that
            invites a reply is both more useful to the patient and far safer for
            the number than a broadcast — WhatsApp reads a one-way blast to
            strangers very differently from a conversation someone answers.
          */
          message:
            "مرحباً {{patient.first_name}} 👋\nأهلاً بك في {{clinic.name}}.\nسجّلنا ملفك عندنا، وهذا رقمنا على واتساب لأي استفسار أو حجز موعد.\n\nكيف يمكننا مساعدتك؟",
        },
      },
    ],
  },
  {
    key: "confirm_on_booking",
    name: "Appointment confirmation",
    name_ar: "تأكيد الحجز",
    description: "Sends a confirmation as soon as an appointment is created.",
    trigger_type: "appointment_created",
    trigger_config: {},
    sort: 1,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nتم تأكيد موعدك في {{clinic.name}}:\n📅 {{appointment.date}}\n🕐 {{appointment.time}}\n{{appointment.service}}\n\nلأي استفسار راسلنا هنا.",
        },
      },
    ],
  },
  {
    key: "first_visit_welcome",
    name: "First visit — how to find us",
    name_ar: "الزيارة الأولى — كيف تصل إلينا",
    description: "A patient's first appointment: the address, the map and what to bring.",
    trigger_type: "appointment_created",
    trigger_config: { first_visit: true },
    sort: 2,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 10, unit: "minutes" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "أهلاً {{patient.first_name}}، سعيدون بزيارتك الأولى لـ{{clinic.name}} 🌟\n📍 {{clinic.address}}\n{{clinic.map_link}}\n\nيُفضّل الحضور قبل الموعد بعشر دقائق، وإحضار الهوية وأي تقارير أو صور أشعة سابقة.",
        },
      },
    ],
  },
  {
    key: "reminder_24h",
    name: "Reminder the day before — reply to confirm",
    name_ar: "تذكير قبل يوم — التأكيد بالرد",
    description:
      "Reminds the patient a day ahead. A reply of 1 confirms the appointment; 2 tells reception to rebook; no reply gets a second nudge.",
    trigger_type: "before_appointment",
    trigger_config: { hours: 24 },
    sort: 3,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nتذكير بموعدك {{appointment.day}} في {{clinic.name}}\n🕐 {{appointment.time}}\n{{appointment.service}}\n\nللتأكيد أرسل 1 ✅\nلتغيير الموعد أرسل 2",
        },
      },
      {
        step_type: "wait_for_reply",
        config: {
          amount: 12,
          unit: "hours",
          options: [
            { label: "تأكيد", keywords: CONFIRM_WORDS },
            { label: "تغيير", keywords: CHANGE_WORDS },
          ],
        },
        children: {
          "opt:0": [
            { step_type: "update_appointment", config: { status: "confirmed" } },
            {
              step_type: "send_whatsapp",
              config: { message: "تم تأكيد موعدك ✅\nبانتظارك {{appointment.day}} الساعة {{appointment.time}} 🌷" },
            },
          ],
          "opt:1": [
            { step_type: "flag_conversation", config: { reason: "يريد تغيير موعده" } },
            {
              step_type: "notify_staff",
              config: {
                title: "{{patient.name}} يريد تغيير موعده",
                body: "{{appointment.date}} — {{appointment.time}}",
                roles: ["receptionist", "owner"],
              },
            },
            {
              step_type: "send_whatsapp",
              config: { message: "ولا يهمك 🙏 سيتواصل معك فريقنا قريباً لترتيب موعد جديد." },
            },
          ],
          other: [
            { step_type: "flag_conversation", config: { reason: "ردّ على تذكير الموعد" } },
            {
              step_type: "notify_staff",
              config: {
                title: "ردّ على تذكير موعد: {{patient.name}}",
                body: "«{{reply.text}}»",
                roles: ["receptionist"],
              },
            },
          ],
          timeout: [
            {
              step_type: "condition",
              config: { match: "all", rules: [{ kind: "appointment_status", values: ["confirmed"] }] },
              children: {
                no: [
                  {
                    step_type: "notify_staff",
                    config: {
                      title: "لم يؤكد {{patient.name}} موعده",
                      body: "{{appointment.day}} · {{appointment.time}} — يُفضّل الاتصال به",
                      roles: ["receptionist"],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  },
  {
    key: "reminder_2h",
    name: "Reminder — 2 hours before",
    name_ar: "تذكير قبل ساعتين",
    description: "Short nudge on the day of the appointment.",
    trigger_type: "before_appointment",
    trigger_config: { hours: 2 },
    sort: 4,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message: "موعدك اليوم الساعة {{appointment.time}} في {{clinic.name}}. بانتظارك! 🌟\n{{clinic.map_link}}",
        },
      },
    ],
  },
  {
    key: "rescheduled_notice",
    name: "Appointment moved",
    name_ar: "إبلاغ بتغيير الموعد",
    description: "Tells the patient their appointment's new time as soon as it is moved.",
    trigger_type: "appointment_rescheduled",
    trigger_config: {},
    sort: 5,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}}، تم تعديل موعدك في {{clinic.name}} ليصبح:\n📅 {{appointment.date}}\n🕐 {{appointment.time}}\n{{doctor.name}}\n\nإذا الوقت غير مناسب راسلنا هنا.",
        },
      },
    ],
  },
  {
    key: "arrival_tell_doctor",
    name: "Tell the doctor the patient has arrived",
    name_ar: "إبلاغ الطبيب بوصول المريض",
    description: "The moment reception marks a patient as arrived, their doctor is told in the app.",
    trigger_type: "patient_arrived",
    trigger_config: {},
    sort: 6,
    steps: [
      {
        step_type: "notify_staff",
        config: {
          title: "وصل {{patient.name}}",
          body: "{{appointment.time}} · {{appointment.service}}",
          appointment_doctor: true,
        },
      },
    ],
  },
  {
    key: "no_show_followup",
    name: "No-show — offer another time",
    name_ar: "عدم الحضور — اقتراح موعد آخر",
    description: "Reaches out after a missed appointment with the booking link, unless they have already rebooked.",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "no_show" },
    sort: 7,
    steps: [
      { step_type: "add_tag", config: { tag: "لم يحضر" } },
      { step_type: "wait", config: { mode: "duration", amount: 1, unit: "hours" } },
      {
        step_type: "condition",
        config: { match: "all", rules: [{ kind: "has_upcoming_appointment" }] },
        children: {
          yes: [{ step_type: "stop", config: {} }],
          no: [
            {
              step_type: "send_whatsapp",
              config: {
                message:
                  "مرحباً {{patient.first_name}}، افتقدناك في موعدك اليوم 🌸\nحاب نحجزلك موعد جديد؟ اختر الوقت المناسب من هنا:\n{{clinic.booking_link}}\n\nأو راسلنا وبنرتبلك أقرب وقت.",
              },
            },
            {
              step_type: "notify_staff",
              config: {
                title: "لم يحضر: {{patient.name}}",
                body: "{{appointment.date}} — تحتاج متابعة",
                roles: ["receptionist"],
              },
            },
          ],
        },
      },
    ],
  },
  {
    key: "cancelled_rebook",
    name: "Cancelled — invite to rebook",
    name_ar: "موعد ملغي — دعوة لإعادة الحجز",
    description: "An hour after a cancellation, offers the booking link — unless another appointment is already booked.",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "cancelled" },
    sort: 8,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 1, unit: "hours" } },
      {
        step_type: "condition",
        config: { match: "all", rules: [{ kind: "has_upcoming_appointment" }] },
        children: {
          yes: [{ step_type: "stop", config: {} }],
          no: [
            {
              step_type: "send_whatsapp",
              config: {
                message:
                  "مرحباً {{patient.first_name}}، تم إلغاء موعدك في {{clinic.name}}.\nمتى ما كان مناسباً لك، احجز موعداً جديداً من هنا:\n{{clinic.booking_link}}",
              },
            },
          ],
        },
      },
    ],
  },
  {
    key: "post_visit_review",
    name: "Thank you + rating, then a review",
    name_ar: "شكر وتقييم ثم مراجعة على Google",
    description:
      "Thanks the patient after a finished visit and asks for a 1–5 rating. Happy patients get your Google review link; unhappy ones reach the clinic admin first.",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 9,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 3, unit: "hours" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "شكراً لزيارتك {{clinic.name}} اليوم 🌟\nكيف كانت تجربتك معنا؟ أرسل رقماً من 1 إلى 5 (5 = ممتازة).",
        },
      },
      {
        step_type: "wait_for_reply",
        config: {
          amount: 1,
          unit: "days",
          options: [
            { label: "راضٍ", keywords: ["5", "4", "ممتاز", "ممتازه", "رائع", "حلو", "excellent", "great"] },
            { label: "غير راضٍ", keywords: ["1", "2", "3", "سيئ", "سيء", "مش منيح", "bad"] },
          ],
        },
        children: {
          "opt:0": [
            {
              step_type: "send_whatsapp",
              config: {
                message:
                  "يسعدنا هذا كثيراً 🙏\nلو عندك دقيقة، تقييمك على Google بيساعد غيرك يلاقينا:\n{{clinic.review_link}}",
              },
            },
          ],
          "opt:1": [
            {
              step_type: "send_whatsapp",
              config: {
                message: "نأسف أن تجربتك لم تكن كما يجب 🙏 سيتواصل معك مسؤول العيادة شخصياً لنفهم ما حدث.",
              },
            },
            {
              step_type: "notify_staff",
              config: { title: "تقييم منخفض من {{patient.name}}", body: "«{{reply.text}}»", roles: ["owner"] },
            },
            {
              step_type: "create_task",
              config: {
                title: "اتصل بـ{{patient.name}} بخصوص تقييمه",
                body: "قيّم زيارته بـ«{{reply.text}}».",
                due_amount: 1,
                due_unit: "days",
                assignee: "nobody",
              },
            },
          ],

        },
      },
    ],
  },
  {
    key: "recall_6_months",
    name: "Recall — 6 months since last visit",
    name_ar: "تذكير مراجعة بعد 6 أشهر",
    description: "Invites the patient back for a routine check, unless they already have an appointment.",
    trigger_type: "after_last_visit",
    trigger_config: { days: 180 },
    sort: 10,
    steps: [
      {
        step_type: "condition",
        config: { match: "all", rules: [{ kind: "has_upcoming_appointment" }] },
        children: { yes: [{ step_type: "stop", config: {} }] },
      },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمر 6 أشهر على آخر زيارة لك في {{clinic.name}}.\nوقت الفحص الدوري! احجز من هنا:\n{{clinic.booking_link}}\nأو راسلنا ونرتبلك موعد.",
        },
      },
    ],
  },
  {
    key: "birthday",
    name: "Birthday greeting",
    name_ar: "تهنئة عيد ميلاد",
    description: "Sends a warm birthday message.",
    trigger_type: "birthday",
    trigger_config: {},
    sort: 11,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message: "كل عام وأنت بخير {{patient.first_name}} 🎂🎉\nمن كل القلب، فريق {{clinic.name}}",
        },
      },
    ],
  },
  {
    key: "prescription_check_in",
    name: "Check in after a prescription",
    name_ar: "الاطمئنان بعد وصفة طبية",
    description: "Three days after a prescription, asks how the patient is doing and tells the doctors if they answer.",
    trigger_type: "prescription_sent",
    trigger_config: {},
    sort: 12,
    steps: [
      { step_type: "wait", config: { mode: "until_time", amount: 3, unit: "days", time: "11:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message: "مرحباً {{patient.first_name}} 🌷\nنطمئن عليك من {{clinic.name}} — كيف حالك مع العلاج؟ إذا عندك أي سؤال راسلنا هنا.",
        },
      },
      {
        step_type: "wait_for_reply",
        config: { amount: 2, unit: "days", options: [] },
        children: {
          replied: [
            { step_type: "flag_conversation", config: { reason: "ردّ على متابعة الوصفة" } },
            {
              step_type: "notify_staff",
              config: { title: "{{patient.name}} ردّ على متابعة الوصفة", body: "«{{reply.text}}»", roles: ["doctor"] },
            },
          ],
        },
      },
    ],
  },
  {
    key: "unanswered_alert",
    name: "A patient is waiting for a reply",
    name_ar: "مريض ينتظر الرد",
    description: "When a WhatsApp message has gone 15 minutes without an answer, reception is told.",
    trigger_type: "conversation_unanswered",
    trigger_config: { minutes: 15 },
    sort: 13,
    steps: [
      {
        step_type: "notify_staff",
        config: {
          title: "رسالة بانتظار الرد منذ 15 دقيقة",
          body: "{{patient.name}}",
          roles: ["receptionist"],
        },
      },
    ],
  },
  {
    key: "booking_needs_approval",
    name: "Online booking waiting for approval",
    name_ar: "حجز إلكتروني بانتظار الموافقة",
    description: "A booking from your link that needs approving becomes a task for reception, so it is not left waiting.",
    trigger_type: "booking_submitted",
    trigger_config: { needs_approval: true },
    sort: 14,
    steps: [
      {
        step_type: "create_task",
        config: {
          title: "راجع طلب حجز {{patient.name}}",
          body: "{{appointment.date}} — {{appointment.time}} · {{appointment.service}}",
          due_amount: 1,
          due_unit: "hours",
          assignee: "nobody",
        },
      },
      {
        step_type: "notify_staff",
        config: { title: "حجز جديد بانتظار موافقتك", body: "{{patient.name}} · {{appointment.date}}", roles: ["receptionist", "owner"] },
      },
    ],
  },
  {
    key: "unpaid_invoice",
    name: "Unpaid invoice reminder",
    name_ar: "تذكير فاتورة غير مدفوعة",
    description: "Follows up on an invoice that stayed unpaid, and stops the moment it is paid.",
    trigger_type: "invoice_unpaid",
    trigger_config: { days: 3 },
    sort: 15,
    steps: [
      {
        step_type: "condition",
        config: { match: "all", rules: [{ kind: "invoice_paid" }] },
        children: {
          no: [
            {
              step_type: "send_whatsapp",
              config: {
                message:
                  "مرحباً {{patient.first_name}}، تذكير بفاتورة {{invoice.number}} — المتبقي {{invoice.balance}}.\n{{invoice.link}}\n\nشكراً لك 🌷",
              },
            },
          ],
          yes: [{ step_type: "stop", config: {} }],
        },
      },
    ],
  },

  /*
    Document signing.

    The two patient reminders the brief asks for (24 hours, then 72) are not
    recipes: they are built into the send path and timed by the clinic's own
    "first reminder after" setting, so they are hour-accurate and cannot be
    accidentally switched off along with an automation. Duplicating them here
    would send every patient the same nudge twice. What these recipes add is
    everything a flow can do that a fixed reminder cannot — escalate to a task,
    chase staff, branch on whether the patient replied.
  */
  {
    key: "document_expired_alert",
    name: "Document expired unsigned",
    name_ar: "مستند انتهت صلاحيته بدون توقيع",
    description: "Raises a task when a signing link expires with no signature.",
    trigger_type: "document_expired",
    trigger_config: {},
    sort: 16,
    steps: [
      {
        step_type: "notify_staff",
        config: {
          title: "مستند انتهت صلاحيته بدون توقيع",
          body: "المستند «{{document.title}}» الخاص بـ{{patient.name}} انتهت صلاحيته. أرسل رابطاً جديداً إن كان ما زال مطلوباً.",
          roles: ["owner", "receptionist"],
        },
      },
      {
        step_type: "create_task",
        config: {
          title: "إعادة إرسال «{{document.title}}» لـ{{patient.name}}",
          body: "انتهت صلاحية رابط التوقيع بدون توقيع.",
          due_in_minutes: 240,
        },
      },
    ],
  },
  {
    key: "document_unsigned_escalate",
    name: "Chase an unsigned document",
    name_ar: "متابعة مستند غير موقّع",
    description: "After five days with no signature, hands it to reception to chase by phone.",
    trigger_type: "document_unsigned",
    // Deliberately later than the built-in 24h and 72h reminders: by day five,
    // two WhatsApp messages have already gone unanswered and the next step is a
    // person picking up the phone.
    trigger_config: { days: 5 },
    sort: 17,
    steps: [
      {
        step_type: "create_task",
        config: {
          title: "اتصل بـ{{patient.name}} بخصوص «{{document.title}}»",
          body: "أُرسل المستند قبل خمسة أيام ولم يُوقّع بعد. الرسائل التلقائية لم تُجدِ.",
          due_in_minutes: 120,
        },
      },
    ],
  },
  {
    key: "document_declined_alert",
    name: "Patient declined a document",
    name_ar: "المريض رفض توقيع مستند",
    description: "Notifies staff and opens a task when a patient declines.",
    trigger_type: "document_declined",
    trigger_config: {},
    sort: 18,
    steps: [
      {
        step_type: "create_task",
        config: {
          title: "{{patient.name}} رفض توقيع «{{document.title}}»",
          body: "تواصل مع المريض لفهم السبب قبل المتابعة في العلاج.",
          due_in_minutes: 60,
        },
      },
    ],
  },
];

// Which of these arrive switched on lives in src/lib/esign/constants.ts, so the
// seed script and clinic creation cannot disagree.
export { RECIPES_ON_BY_DEFAULT } from "../src/lib/esign/constants";

export const KNOWLEDGE = [
  { category: "services_prices", title: "الخدمات والأسعار", content: "", sort: 1 },
  { category: "doctors", title: "الأطباء والتخصصات", content: "", sort: 2 },
  { category: "hours", title: "ساعات العمل", content: "", sort: 3 },
  { category: "location", title: "الموقع والوصول", content: "", sort: 4 },
  { category: "insurance", title: "شركات التأمين المقبولة", content: "", sort: 5 },
  { category: "preparation", title: "تعليمات ما قبل الزيارة", content: "", sort: 6 },
  { category: "faq", title: "أسئلة شائعة", content: "", sort: 7 },
];

/**
 * Everything the agency hands out: the library every clinic gets, then the
 * per-field packs on top. One list, because a recipe is a recipe — the
 * `specialty` column is the only thing that decides who is offered it.
 */
export const ALL_RECIPES: Recipe[] = [...RECIPES, ...SPECIALTY_RECIPES];

export async function seedAgencyDefaults(c: Client) {
  for (const r of ALL_RECIPES) {
    await c.query(
      `insert into recipe_templates (key, name, name_ar, description, trigger_type, trigger_config, steps, sort, specialty)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (key) do update set
         name = excluded.name, name_ar = excluded.name_ar, description = excluded.description,
         trigger_type = excluded.trigger_type, trigger_config = excluded.trigger_config,
         steps = excluded.steps, sort = excluded.sort, specialty = excluded.specialty`,
      [
        r.key, r.name, r.name_ar, r.description, r.trigger_type,
        JSON.stringify(r.trigger_config), JSON.stringify(r.steps), r.sort,
        r.specialty ?? "general",
      ]
    );
  }
  await c.query(`delete from knowledge_templates`);
  for (const k of KNOWLEDGE) {
    await c.query(
      `insert into knowledge_templates (category, title, content, sort) values ($1, $2, $3, $4)`,
      [k.category, k.title, k.content, k.sort]
    );
  }
}

if (process.argv[1]?.includes("seed-recipes")) {
  // Targets DATABASE_SUPER_URL when set, so the same script seeds production.
  const url =
    process.env.DATABASE_SUPER_URL ??
    `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
  const c = new Client({
    connectionString: url,
    ssl: /@(localhost|127\.0\.0\.1)/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  c.connect()
    .then(() => seedAgencyDefaults(c))
    .then(() => {
      console.log(
        `[seed] ${RECIPES.length} general + ${SPECIALTY_RECIPES.length} specialty recipes, ${KNOWLEDGE.length} knowledge templates`
      );
      return c.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
