import type { Recipe, RecipeStep } from "./seed-recipes";
import { BOOK_WORDS, CHANGE_WORDS, CONFIRM_WORDS } from "./recipe-kit";

/*
  The treatment coordinator's flows (a test, behind the opt-in `coordinator`
  feature — src/lib/courses.ts decides who is due). Their triggers belong to
  the `coordinator` module, so no other clinic is offered them; switching the
  feature on in Admin installs all three, switched on (src/lib/coordinator.ts).

  What they do is what a good receptionist does for a patient part-way
  through a treatment: books the next session at the time they usually come,
  with the doctor who treats them, and says "reply 2 if it doesn't suit" —
  and hands the patient to a person the moment it is not that simple.
*/

const askAPerson = (): RecipeStep[] => [
  { step_type: "flag_conversation", config: { reason: "ردّ على رسالة منسّق العلاج" } },
  {
    step_type: "notify_staff",
    config: { title: "{{patient.name}} ردّ على رسالة منسّق العلاج", body: "«{{reply.text}}»", roles: ["receptionist"] },
  },
];

export const COORDINATOR_RECIPE_LIST: Recipe[] = [
  {
    key: "coordinator_next_session",
    name: "Book the next session of a treatment",
    name_ar: "حجز الجلسة التالية من العلاج",
    description:
      "A course of laser, a package of sessions, the doctor's 'come back in two weeks': a week before the next session falls due, unless something is booked, it is booked — the time they usually come, with the doctor who treats them — and the patient is told: 1 confirms, 2 cancels it and reception calls to pick a time. Nothing free within two weeks: the waitlist, and a task.",
    description_ar:
      "جلسات ليزر، باقة جلسات، أو «راجعنا بعد أسبوعين» من الطبيب: قبل موعد الجلسة التالية بأسبوع، إن لم يكن لديه موعد، تُحجز — في الوقت الذي يأتي فيه عادةً ومع الطبيب الذي يعالجه — ويُبلَّغ المريض: 1 للتأكيد، و2 لإلغائها ويتصل به الاستقبال لاختيار وقت. لا وقت متاح خلال أسبوعين: قائمة الانتظار ومهمة للاستقبال.",
    trigger_type: "treatment_session_due",
    trigger_config: { action: "book", days_ahead: 7 },
    sort: 40,
    steps: [
      {
        step_type: "book_appointment",
        config: {
          service: "treatment",
          doctor: "treatment",
          from: "due",
          after_days: 0,
          search_days: 14,
          part_of_day: "same_time",
          then_any: true,
          within_link_rules: true,
          // Booked by the system, not by them: scheduled, and the day-before reminder asks them to confirm.
          status: "scheduled",
          skip_if_booked: true,
        },
        children: {
          booked: [
            {
              step_type: "send_whatsapp",
              config: {
                message:
                  "مرحباً {{patient.first_name}} 👋\nحجزنالك {{treatment.session_label}} في {{clinic.name}}:\n📋 {{treatment.name}}\n📅 {{appointment.date}}\n🕐 {{appointment.time}}\n👨‍⚕️ {{appointment.doctor}}\n\nإذا الوقت مناسب أرسل 1 ✅\nإذا بدك تغيّره أرسل 2",
              },
            },
            {
              step_type: "wait_for_reply",
              config: {
                amount: 2,
                unit: "days",
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
                    config: { message: "تم تأكيد موعدك ✅\nبانتظارك {{appointment.date}} الساعة {{appointment.time}} 🌷" },
                  },
                ],
                "opt:1": [
                  // Quietly: reception calls them — the "rebook in one reply" flow must not also write.
                  { step_type: "update_appointment", config: { status: "cancelled", quiet: true } },
                  {
                    step_type: "create_task",
                    config: {
                      title: "اتصل بـ{{patient.name}} لاختيار وقت {{treatment.session_label}}",
                      body: "ألغى الموعد الذي حجزه النظام ({{appointment.date}} — {{appointment.time}}).\n{{treatment.name}}",
                      due_amount: 0,
                      due_unit: "minutes",
                      assignee: "nobody",
                    },
                  },
                  {
                    step_type: "send_whatsapp",
                    config: { message: "ولا يهمك 🙏 ألغينا هذا الموعد، ورح يتواصل معك فريقنا لنختار وقت بناسبك." },
                  },
                ],
                other: askAPerson(),
              },
            },
          ],
          no_slot: [
            {
              step_type: "add_to_waitlist",
              config: { service: "treatment", doctor: "treatment", within_days: 21, note: "{{treatment.session_label}} — {{treatment.name}}" },
            },
            {
              step_type: "create_task",
              config: {
                title: "رتّب {{treatment.session_label}} لـ{{patient.name}}",
                body: "حان موعدها ولا يوجد وقت متاح خلال أسبوعين — أُضيف لقائمة الانتظار.\n{{treatment.name}}",
                due_amount: 1,
                due_unit: "days",
                assignee: "nobody",
              },
            },
            {
              step_type: "send_whatsapp",
              config: {
                message:
                  "مرحباً {{patient.first_name}} 👋\nحان موعد {{treatment.session_label}} في {{clinic.name}}، والمواعيد القريبة محجوزة 🙏\nسجّلناك على قائمة الانتظار، ورح نتواصل معك أول ما يفضى وقت.",
              },
            },
          ],
        },
      },
    ],
  },
  {
    key: "coordinator_plan_invite",
    name: "Invite back for the rest of a treatment plan",
    name_ar: "دعوة لإكمال خطة العلاج",
    description:
      "Planned dental work with nothing booked: whether they took the plan, how long the visit is and who does it are a receptionist's questions, so this never books. A week after the last visit of the plan (two days after it was charted, if not started): reply 1, and reception gets a task naming the treatment and the teeth.",
    description_ar:
      "عمل أسنان مخطط وليس له موعد: هل وافق المريض على الخطة، وكم مدة الزيارة ومن يقوم بها — أسئلة يجيب عنها الاستقبال، لذلك لا يحجز هذا التدفق بنفسه. بعد أسبوع من آخر زيارة في الخطة (أو بعد يومين من تسجيلها إن لم تبدأ): الرد بـ1 يعطي الاستقبال مهمة باسم العلاج والأسنان.",
    trigger_type: "treatment_session_due",
    trigger_config: { action: "invite", days_ahead: 0 },
    sort: 41,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nحان وقت {{treatment.session_label}} في {{clinic.name}}:\n🦷 {{treatment.name}}\n\nأرسل 1 ونتواصل معك لترتيب موعد بناسبك، أو اكتبلنا الوقت اللي بناسبك.",
        },
      },
      {
        step_type: "wait_for_reply",
        config: { amount: 2, unit: "days", options: [{ label: "نعم", keywords: BOOK_WORDS }] },
        children: {
          "opt:0": [
            {
              step_type: "create_task",
              config: {
                title: "اتصل بـ{{patient.name}} لحجز {{treatment.name}}",
                body: "طلب موعداً للزيارة التالية من خطة علاجه.\nالأسنان: {{treatment.tooth}}",
                due_amount: 0,
                due_unit: "minutes",
                assignee: "nobody",
              },
            },
            { step_type: "send_whatsapp", config: { message: "تمام ✅ رح يتواصل معك فريقنا اليوم لترتيب الموعد." } },
          ],
          other: askAPerson(),
        },
      },
    ],
  },
  {
    key: "coordinator_enquiry",
    name: "Asked, did not book — offer the consultation",
    name_ar: "استفسر ولم يحجز — عرض موعد الكشفية",
    description:
      "Someone wrote in this week, the clinic answered, and then nothing: a day after the last message, once per conversation, unless they booked: reply 1 and the first free consultation is booked — a file is opened for them if they have none. A question instead goes to a person.",
    description_ar:
      "شخص راسل العيادة هذا الأسبوع وردّت عليه، ثم لا شيء: بعد يوم من آخر رسالة، مرة واحدة لكل محادثة، إن لم يحجز: الرد بـ1 يحجز أول موعد كشفية متاح — ويُفتح له ملف إن لم يكن له ملف. وإن كتب سؤالاً يذهب لموظف.",
    trigger_type: "enquiry_not_booked",
    trigger_config: { hours: 24 },
    sort: 42,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً 👋\nشكراً لتواصلك مع {{clinic.name}}.\nإذا حاب نحجزلك موعد كشفية، أرسل 1 ونحجزلك أول وقت متاح ونرسلك التفاصيل.\nوإذا عندك أي سؤال، اكتبه هنا 🌷",
        },
      },
      {
        step_type: "wait_for_reply",
        config: { amount: 2, unit: "days", options: [{ label: "احجز", keywords: BOOK_WORDS }] },
        children: {
          "opt:0": [
            {
              step_type: "book_appointment",
              config: {
                service: "consultation",
                doctor: "any",
                from: "now",
                after_days: 1,
                search_days: 14,
                part_of_day: "any",
                within_link_rules: true,
                // They asked for it: booked as confirmed.
                status: "confirmed",
                skip_if_booked: true,
              },
              children: {
                booked: [
                  {
                    step_type: "send_whatsapp",
                    config: {
                      message:
                        "تم ✅ حجزنالك موعد كشفية في {{clinic.name}}:\n📅 {{appointment.date}}\n🕐 {{appointment.time}}\n👨‍⚕️ {{appointment.doctor}}\n\nإذا الوقت مش مناسب ردّ علينا هنا ومنغيّره.",
                    },
                  },
                ],
                already_booked: [
                  {
                    step_type: "send_whatsapp",
                    config: { message: "عندك موعد قادم في {{clinic.name}} ✅\n📅 {{appointment.date}}\n🕐 {{appointment.time}}\n\nبانتظارك 🌷" },
                  },
                ],
                no_slot: [
                  {
                    step_type: "create_task",
                    config: {
                      title: "رتّب موعد كشفية لـ{{patient.name}}",
                      body: "طلب موعداً بالرد على رسالة تلقائية ولا يوجد وقت متاح خلال أسبوعين.",
                      due_amount: 0,
                      due_unit: "minutes",
                      assignee: "nobody",
                    },
                  },
                  {
                    step_type: "send_whatsapp",
                    config: { message: "المواعيد القريبة محجوزة حالياً 🙏 رح يتواصل معك فريقنا اليوم لترتيب موعد بناسبك." },
                  },
                ],
              },
            },
          ],
          other: askAPerson(),
        },
      },
    ],
  },
];
