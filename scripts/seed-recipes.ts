import { Client } from "pg";

/**
 * Agency-level defaults: automation recipes + AI knowledge structure.
 * Copied (disabled, fully editable) into every clinic on creation.
 */

export const RECIPES = [
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
    key: "reminder_24h",
    name: "Reminder — 24 hours before",
    name_ar: "تذكير قبل 24 ساعة",
    description: "Reminds the patient a day ahead and asks them to confirm.",
    trigger_type: "before_appointment",
    trigger_config: { hours: 24 },
    sort: 2,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "تذكير بموعدك غداً في {{clinic.name}} 🦷\n🕐 {{appointment.time}}\n{{appointment.service}}\n\nإذا احتجت تعديل الموعد راسلنا.",
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
    sort: 3,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message: "موعدك اليوم الساعة {{appointment.time}} في {{clinic.name}}. بانتظارك! 🌟",
        },
      },
    ],
  },
  {
    key: "no_show_followup",
    name: "No-show follow-up",
    name_ar: "متابعة عدم الحضور",
    description: "Reaches out when a patient misses their appointment.",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "no_show" },
    sort: 4,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}}، افتقدناك في موعدك اليوم 🌸\nحاب نحجزلك موعد جديد؟ راسلنا وبنرتبلك أقرب وقت مناسب.",
        },
      },
      { step_type: "add_tag", config: { tag: "لم يحضر" } },
      {
        step_type: "notify_staff",
        config: { title: "لم يحضر: {{patient.name}}", body: "{{appointment.date}} — تحتاج متابعة" },
      },
    ],
  },
  {
    key: "post_visit_review",
    name: "Thank you + review request",
    name_ar: "شكر وطلب تقييم",
    description: "Thanks the patient after a completed visit and asks for a Google review.",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 5,
    steps: [
      { step_type: "wait", config: { minutes: 180 } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "شكراً لزيارتك {{clinic.name}} اليوم 🌟\nنتمنى تكون تجربتك كانت ممتازة.\nإذا حابب تشاركنا رأيك، تقييمك بيفرق كتير معنا 🙏",
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
    sort: 6,
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
    key: "recall_6_months",
    name: "Recall — 6 months since last visit",
    name_ar: "تذكير مراجعة بعد 6 أشهر",
    description: "Invites the patient back for a routine check.",
    trigger_type: "after_last_visit",
    trigger_config: { days: 180 },
    sort: 7,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمر 6 أشهر على آخر زيارة لك في {{clinic.name}}.\nوقت التنظيف والفحص الدوري! حاب نحجزلك موعد؟",
        },
      },
    ],
  },
  {
    key: "unpaid_invoice",
    name: "Unpaid invoice reminder",
    name_ar: "تذكير فاتورة غير مدفوعة",
    description: "Follows up on an invoice that stayed unpaid.",
    trigger_type: "invoice_unpaid",
    trigger_config: { days: 3 },
    sort: 8,
    steps: [
      {
        step_type: "condition",
        config: { kind: "invoice_paid" },
        children: {
          no: [
            {
              step_type: "send_whatsapp",
              config: {
                message:
                  "مرحباً {{patient.first_name}}، تذكير بفاتورة {{invoice.number}} بقيمة {{invoice.total}}.\n{{invoice.link}}\n\nشكراً لك 🌷",
              },
            },
          ],
          yes: [{ step_type: "stop", config: {} }],
        },
      },
    ],
  },
];

export const KNOWLEDGE = [
  { category: "services_prices", title: "الخدمات والأسعار", content: "", sort: 1 },
  { category: "doctors", title: "الأطباء والتخصصات", content: "", sort: 2 },
  { category: "hours", title: "ساعات العمل", content: "", sort: 3 },
  { category: "location", title: "الموقع والوصول", content: "", sort: 4 },
  { category: "insurance", title: "شركات التأمين المقبولة", content: "", sort: 5 },
  { category: "preparation", title: "تعليمات ما قبل الزيارة", content: "", sort: 6 },
  { category: "faq", title: "أسئلة شائعة", content: "", sort: 7 },
];

export async function seedAgencyDefaults(c: Client) {
  for (const r of RECIPES) {
    await c.query(
      `insert into recipe_templates (key, name, name_ar, description, trigger_type, trigger_config, steps, sort)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (key) do update set
         name = excluded.name, name_ar = excluded.name_ar, description = excluded.description,
         trigger_type = excluded.trigger_type, trigger_config = excluded.trigger_config,
         steps = excluded.steps, sort = excluded.sort`,
      [
        r.key, r.name, r.name_ar, r.description, r.trigger_type,
        JSON.stringify(r.trigger_config), JSON.stringify(r.steps), r.sort,
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
      console.log(`[seed] ${RECIPES.length} recipes, ${KNOWLEDGE.length} knowledge templates`);
      return c.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
