import { Client } from "pg";
import { SPECIALTY_RECIPES } from "./specialty-recipes";
import { replyToBook, UNLESS_BOOKED, callTask, CONFIRM_WORDS, CHANGE_WORDS } from "./recipe-kit";
import { COORDINATOR_RECIPE_LIST } from "./coordinator-recipes";

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
  /** What it solves and what the patient receives, in a sentence — shown on the gallery card. */
  description: string;
  description_ar: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  sort: number;
  steps: RecipeStep[];
  /** Omitted means 'general': suits every clinic, whatever it practises. */
  specialty?: string;
};


export const RECIPES: Recipe[] = [
  {
    key: "welcome_new_patient",
    name: "Welcome a new patient",
    name_ar: "ترحيب بمريض جديد",
    description:
      "A patient the team adds by hand — a walk-in, a phone call — gets the clinic's WhatsApp number and an opening to ask anything. Patients who booked online or wrote to you first are not greeted twice.",
    description_ar:
      "المريض الذي يضيفه الفريق يدوياً — زيارة مباشرة أو اتصال — يصله رقم العيادة على واتساب ودعوة ليسأل عن أي شيء. من حجز إلكترونياً أو راسلكم أولاً لا يصله ترحيب مكرر.",
    trigger_type: "patient_created",
    /*
      Staff-added files only. A patient who booked online has just had the
      booking confirmation; one created from a chat or by the AI is already in
      the conversation — "welcome, how can we help?" on top of either read as
      a bot that was not listening.
    */
    trigger_config: { sources: ["staff"] },
    sort: 0,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          /*
            Deliberately an opening, not an announcement. This is very often the
            clinic's first message to this number, and a first message that
            invites a reply is both more useful to the patient and far safer for
            the number than a broadcast.
          */
          message:
            "مرحباً {{patient.first_name}} 👋\nأهلاً بك في {{clinic.name}}.\nسجّلنا ملفك عندنا، وهذا رقمنا على واتساب لأي استفسار أو حجز موعد.\n\nكيف يمكننا مساعدتك؟",
        },
      },
    ],
  },
  {
    key: "confirm_on_booking",
    name: "Booking confirmation",
    name_ar: "تأكيد الحجز",
    description:
      "When reception books an appointment, the patient gets the day, time and service in writing at once — fewer calls asking 'what time was it?'. Online and AI bookings send their own.",
    description_ar:
      "عند حجز موعد من الاستقبال، يصل المريض اليوم والساعة والخدمة مكتوبة فوراً — مكالمات أقل للسؤال عن الموعد. الحجز الإلكتروني والمساعد الذكي يرسلان تأكيدهما بنفسهما.",
    trigger_type: "appointment_created",
    trigger_config: { sources: ["staff"] },
    sort: 1,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          // "Booked", not "confirmed": the day-before reminder is what asks them to confirm.
          message:
            "مرحباً {{patient.first_name}} 👋\nتم حجز موعدك في {{clinic.name}}:\n📅 {{appointment.date}}\n🕐 {{appointment.time}}\n{{appointment.service}}\n📍 {{clinic.address}}\n\nإذا حاب تغيّر الموعد راسلنا هنا.",
        },
      },
    ],
  },
  {
    key: "first_visit_welcome",
    name: "First visit — how to find us",
    name_ar: "الزيارة الأولى — كيف تصل إلينا",
    description:
      "New patients get lost on the way and arrive without their old reports. On a patient's first booking: the address, the map and what to bring.",
    description_ar:
      "المريض الجديد قد يضيع الطريق ويأتي دون تقاريره السابقة. عند أول حجز له: العنوان والخريطة وما يُحضره معه.",
    trigger_type: "appointment_created",
    trigger_config: { first_visit: true },
    sort: 2,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 10, unit: "minutes" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "أهلاً {{patient.first_name}}، سعيدون بزيارتك الأولى لـ{{clinic.name}} 🌟\n📍 {{clinic.address}}\n🗺 {{clinic.map_link}}\n\nيُفضّل الحضور قبل الموعد بعشر دقائق، وإحضار الهوية وبطاقة التأمين وأي تقارير أو صور أشعة سابقة.",
        },
      },
    ],
  },
  {
    key: "reminder_24h",
    name: "Reminder the day before — reply to confirm",
    name_ar: "تذكير قبل يوم — التأكيد بالرد",
    description:
      "Patients who are reminded and asked to confirm turn up. A day ahead — or within the hour for a booking made later than that: 1 confirms, 2 asks to change and gives reception a task to call; no answer puts 'call to confirm' on the desk's to-do list.",
    description_ar:
      "المريض الذي يُذكَّر ويُطلب منه التأكيد يحضر. قبل الموعد بيوم — أو خلال ساعة لحجز تمّ بعد ذلك: الرد بـ1 يؤكد، و2 لطلب التغيير ويعطي الاستقبال مهمة اتصال، وعدم الرد يضع «اتصل للتأكيد» على قائمة مهام الاستقبال.",
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
            // A job on the desk's To do, not only a flag in the inbox: somebody has to call them back.
            {
              step_type: "create_task",
              config: {
                title: "اتصل بـ{{patient.name}} لتغيير موعده",
                body: "{{appointment.date}} — {{appointment.time}}",
                due_amount: 0,
                due_unit: "minutes",
                assignee: "nobody",
              },
            },
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
                /*
                  A task, not also a notification: the desk's daily "not
                  confirmed for tomorrow" summary already lists them, and the
                  to-do is what gets the call made.
                */
                no: [
                  {
                    step_type: "create_task",
                    config: {
                      title: "اتصل بـ{{patient.name}} لتأكيد موعده",
                      body: "{{appointment.day}} · {{appointment.time}}",
                      due_amount: 0,
                      due_unit: "minutes",
                      assignee: "nobody",
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
    description:
      "Forgetting on the day is the other half of no-shows. Two hours before: the time, and the map for anyone who has not been before.",
    description_ar: "النسيان في نفس اليوم هو النصف الآخر لعدم الحضور. قبل ساعتين: الوقت، والخريطة لمن لم يزرنا من قبل.",
    trigger_type: "before_appointment",
    trigger_config: { hours: 2 },
    sort: 4,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message: "موعدك اليوم الساعة {{appointment.time}} في {{clinic.name}} — بانتظارك 🌟\n🗺 {{clinic.map_link}}",
        },
      },
    ],
  },
  {
    key: "rescheduled_notice",
    name: "Appointment moved",
    name_ar: "إبلاغ بتغيير الموعد",
    description:
      "When the clinic moves an appointment, the patient has the new time in writing at once — instead of turning up at the old one.",
    description_ar: "عندما تغيّر العيادة موعداً، يصل المريض الوقت الجديد مكتوباً فوراً — بدل أن يأتي في الوقت القديم.",
    trigger_type: "appointment_rescheduled",
    trigger_config: {},
    sort: 5,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}}، تم تعديل موعدك في {{clinic.name}} ليصبح:\n📅 {{appointment.date}}\n🕐 {{appointment.time}}\n👨‍⚕️ {{appointment.doctor}}\n\nإذا الوقت غير مناسب راسلنا هنا.",
        },
      },
    ],
  },
  {
    key: "next_visit_due_book",
    name: "The doctor's follow-up is due — reply to book",
    name_ar: "حان موعد المراجعة — الحجز بالرد",
    description:
      "Doctors say 'come back in two weeks' on the finish sheet, and the patient forgets. Two days before it falls due, unless they already booked: a reply of 1 books the first free time with the doctor who asked for it. No answer puts a call on reception's to-do list.",
    description_ar:
      "يكتب الطبيب «راجعنا بعد أسبوعين» عند إنهاء الزيارة، وينسى المريض. قبل الموعد المطلوب بيومين، إن لم يحجز بعد: الرد بـ1 يحجز أول وقت متاح مع الطبيب نفسه. وإن لم يرد تُضاف مهمة اتصال للاستقبال.",
    trigger_type: "next_visit_due",
    trigger_config: { days_before: 2 },
    sort: 6,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nطلب منك طبيبك في {{clinic.name}} مراجعة خلال الأيام القادمة.\nأرسل 1 ونحجزلك أول موعد متاح، أو راسلنا بالوقت اللي بناسبك.",
        },
      },
      replyToBook({
        like: "trigger",
        onSilence: callTask("اتصل بـ{{patient.name}} لحجز المراجعة", "طلب الطبيب مراجعته ولم يحجز ولم يرد على الرسالة."),
      }),
    ],
  },
  {
    key: "no_show_followup",
    name: "Missed appointment — rebook in one reply",
    name_ar: "عدم الحضور — إعادة الحجز بالرد",
    description:
      "A missed appointment is a patient about to be lost. An hour later, unless they already rebooked: a kind message, and a reply of 1 books the first free time with the same doctor — or puts them on the waitlist.",
    description_ar:
      "الموعد الفائت مريض على وشك أن يضيع. بعد ساعة، إن لم يحجز مجدداً: رسالة لطيفة، والرد بـ1 يحجز أول وقت متاح مع نفس الطبيب — أو يضعه على قائمة الانتظار.",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "no_show" },
    sort: 7,
    steps: [
      { step_type: "add_tag", config: { tag: "لم يحضر" } },
      { step_type: "wait", config: { mode: "duration", amount: 1, unit: "hours" } },
      UNLESS_BOOKED,
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}}، افتقدناك في موعدك اليوم 🌸\nحاب نحجزلك موعداً جديداً؟ أرسل 1 ونحجزلك أول وقت متاح مع نفس الطبيب.",
        },
      },
      replyToBook({ like: "trigger" }),
    ],
  },
  {
    key: "cancelled_rebook",
    name: "Cancelled — rebook in one reply",
    name_ar: "موعد ملغي — إعادة الحجز بالرد",
    description:
      "A cancellation usually means 'not that day', not 'never'. An hour later, unless something is already booked: a reply of 1 books the first free time with the same doctor.",
    description_ar:
      "الإلغاء غالباً يعني «ليس ذلك اليوم» لا «أبداً». بعد ساعة، إن لم يكن لديه موعد آخر: الرد بـ1 يحجز أول وقت متاح مع نفس الطبيب.",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "cancelled" },
    sort: 8,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 1, unit: "hours" } },
      UNLESS_BOOKED,
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}}، تم إلغاء موعدك في {{clinic.name}}.\nمتى ما حبيت نحجزلك موعداً جديداً، أرسل 1 ونحجزلك أول وقت متاح.",
        },
      },
      replyToBook({ like: "trigger" }),
    ],
  },
  {
    key: "post_visit_review",
    name: "Thank you + rating, then a Google review",
    name_ar: "شكر وتقييم ثم مراجعة على Google",
    description:
      "Most happy patients never leave a review, and an unhappy one leaves it in public. After a finished visit: a 1–5 rating. 4–5 get your Google review link (set it in Automations); 1–3 reach the owner first, with a task to call.",
    description_ar:
      "أغلب المرضى الراضين لا يكتبون تقييماً، وغير الراضي يكتبه علناً. بعد انتهاء الزيارة: تقييم من 1 إلى 5. من يعطي 4–5 يصله رابط تقييم Google (أضِفه في صفحة الأتمتة)، ومن يعطي 1–3 يصل صاحب العيادة أولاً مع مهمة اتصال.",
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
            // Not "منيح": "مش منيح" contains it, and the first answer that matches wins.
            { label: "راضٍ", keywords: ["5", "4", "ممتاز", "ممتازه", "رائع", "حلو", "كويس", "تمام", "excellent", "great", "😍", "👍"] },
            { label: "غير راضٍ", keywords: ["1", "2", "3", "سيئ", "سيء", "مش منيح", "زعلان", "bad"] },
          ],
        },
        children: {
          "opt:0": [
            {
              step_type: "send_whatsapp",
              config: {
                // The second line goes on its own when the clinic has not set a review link.
                message: "يسعدنا هذا كثيراً 🙏 شكراً لثقتك بنا.\nلو عندك دقيقة، قيّمنا على Google: {{clinic.review_link}}",
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
          // Something that is not a number — a question, a complaint in words — needs a person to read it.
          other: [{ step_type: "flag_conversation", config: { reason: "ردّ على طلب التقييم" } }],
        },
      },
    ],
  },
  {
    key: "recall_6_months",
    name: "Six-month check-up — reply to book",
    name_ar: "فحص دوري بعد 6 أشهر — الحجز بالرد",
    description:
      "Patients drift away between check-ups. Six months after the last visit, unless something is booked: an invitation, and a reply of 1 books the same service with the same doctor.",
    description_ar:
      "المرضى يبتعدون بين فحص وآخر. بعد 6 أشهر من آخر زيارة، إن لم يكن لديه موعد: دعوة، والرد بـ1 يحجز نفس الخدمة مع نفس الطبيب.",
    trigger_type: "after_last_visit",
    trigger_config: { days: 180 },
    sort: 10,
    steps: [
      UNLESS_BOOKED,
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمرّ 6 أشهر على آخر زيارة لك في {{clinic.name}} — صار وقت الفحص الدوري.\nأرسل 1 ونحجزلك أول موعد متاح.",
        },
      },
      replyToBook({ like: "last", waitDays: 3 }),
    ],
  },
  {
    key: "birthday",
    name: "Birthday greeting",
    name_ar: "تهنئة عيد ميلاد",
    description: "A small touch that keeps the clinic in mind: a warm message on the patient's birthday, every year.",
    description_ar: "لمسة بسيطة تُبقي العيادة في البال: رسالة دافئة في يوم ميلاد المريض، كل سنة.",
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
    description:
      "Patients stop a medicine early, or react to it, and do not say. Three days after a prescription: how are you doing? Any answer goes to the doctors.",
    description_ar:
      "قد يوقف المريض الدواء مبكراً أو يتحسس منه دون أن يخبر أحداً. بعد 3 أيام من الوصفة: كيف حالك؟ وأي رد يصل للأطباء.",
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
    key: "results_ready",
    name: "Results are ready — reply to book a review",
    name_ar: "النتائج جاهزة — الحجز بالرد",
    description:
      "Patients phone to ask whether their results are back. Tag the file 'نتائج جاهزة' when they arrive: the patient is told at once, and a reply of 1 books a visit to go through them with the same doctor.",
    description_ar:
      "المرضى يتصلون للسؤال عن نتائجهم. ضع وسم «نتائج جاهزة» على الملف عند وصولها: يُبلَّغ المريض فوراً، والرد بـ1 يحجز موعداً لمراجعتها مع نفس الطبيب.",
    trigger_type: "tag_added",
    trigger_config: { tag: "نتائج جاهزة" },
    sort: 13,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nنتائج فحوصاتك وصلت إلى {{clinic.name}}.\nأرسل 1 ونحجزلك موعداً لمراجعتها مع الطبيب.",
        },
      },
      replyToBook({ like: "last" }),
    ],
  },
  {
    key: "unanswered_alert",
    name: "A patient is waiting for a reply",
    name_ar: "مريض ينتظر الرد",
    description:
      "A message left unanswered is a booking lost to the clinic that answered first. After 15 minutes without a reply, reception is alerted — during your messaging hours only.",
    description_ar:
      "الرسالة التي لا يُرد عليها حجز يذهب للعيادة التي ردّت أولاً. بعد 15 دقيقة دون رد يُنبَّه الاستقبال — ضمن ساعات المراسلة فقط.",
    trigger_type: "conversation_unanswered",
    trigger_config: { minutes: 15 },
    sort: 14,
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
    description:
      "An online booking waiting for approval is easy to miss among the day's alerts. It becomes a task on reception's to-do list, due within the hour.",
    description_ar: "الحجز الإلكتروني الذي ينتظر الموافقة يضيع بسهولة بين تنبيهات اليوم. يصبح مهمة على قائمة الاستقبال، مستحقة خلال ساعة.",
    trigger_type: "booking_submitted",
    trigger_config: { needs_approval: true },
    sort: 15,
    steps: [
      // A task only: the booking page already sends the "waiting for approval" alert.
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
    ],
  },
  {
    key: "unpaid_invoice",
    name: "Unpaid invoice reminder",
    name_ar: "تذكير فاتورة غير مدفوعة",
    description:
      "Balances are forgotten more often than refused. Three days after an invoice is sent and still unpaid: a polite reminder with the amount and the payment link. Nothing is sent once it is paid.",
    description_ar:
      "المبالغ المستحقة تُنسى أكثر مما تُرفض. بعد 3 أيام من إرسال فاتورة لم تُدفع: تذكير لطيف بالمبلغ ورابط الفاتورة. ولا يُرسل شيء إذا دُفعت.",
    trigger_type: "invoice_unpaid",
    trigger_config: { days: 3 },
    sort: 16,
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
                  "مرحباً {{patient.first_name}}، تذكير بفاتورة {{invoice.number}} من {{clinic.name}} — المتبقي {{invoice.balance}}.\nللاطلاع والدفع: {{invoice.link}}\n\nشكراً لك 🌷",
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

    The two patient reminders (24 hours, then 72) are not recipes: they are
    built into the send path and timed by the clinic's own "first reminder
    after" setting. What these recipes add is what a fixed reminder cannot —
    a task on somebody's list. They do not notify: the expiry and the decline
    already alert the team on their own.
  */
  {
    key: "document_expired_alert",
    name: "Document expired unsigned",
    name_ar: "مستند انتهت صلاحيته بدون توقيع",
    description: "A consent form that expired unsigned blocks the treatment. It becomes a task to send a new link.",
    description_ar: "نموذج الموافقة الذي انتهت صلاحيته دون توقيع يوقف العلاج. يصبح مهمة لإرسال رابط جديد.",
    trigger_type: "document_expired",
    trigger_config: {},
    sort: 17,
    steps: [
      {
        step_type: "create_task",
        config: {
          title: "إعادة إرسال «{{document.title}}» لـ{{patient.name}}",
          body: "انتهت صلاحية رابط التوقيع بدون توقيع. أرسل رابطاً جديداً إن كان ما زال مطلوباً.",
          due_amount: 4,
          due_unit: "hours",
          assignee: "nobody",
        },
      },
    ],
  },
  {
    key: "document_unsigned_escalate",
    name: "Chase an unsigned document",
    name_ar: "متابعة مستند غير موقّع",
    description:
      "After two automatic reminders, the next step is a phone call. Five days with no signature: a task for reception to call.",
    description_ar: "بعد تذكيرين تلقائيين، الخطوة التالية مكالمة. بعد 5 أيام دون توقيع: مهمة اتصال للاستقبال.",
    trigger_type: "document_unsigned",
    // Later than the built-in 24h and 72h reminders: by day five, two messages have gone unanswered.
    trigger_config: { days: 5 },
    sort: 18,
    steps: [
      {
        step_type: "create_task",
        config: {
          title: "اتصل بـ{{patient.name}} بخصوص «{{document.title}}»",
          body: "أُرسل المستند قبل خمسة أيام ولم يُوقّع بعد. الرسائل التلقائية لم تُجدِ.",
          due_amount: 2,
          due_unit: "hours",
          assignee: "nobody",
        },
      },
    ],
  },
  {
    key: "document_declined_alert",
    name: "Patient declined a document",
    name_ar: "المريض رفض توقيع مستند",
    description: "A declined consent form needs a conversation before treatment goes ahead. It becomes a task within the hour.",
    description_ar: "رفض نموذج الموافقة يحتاج حديثاً مع المريض قبل متابعة العلاج. يصبح مهمة خلال ساعة.",
    trigger_type: "document_declined",
    trigger_config: {},
    sort: 19,
    steps: [
      {
        step_type: "create_task",
        config: {
          title: "{{patient.name}} رفض توقيع «{{document.title}}»",
          body: "تواصل مع المريض لفهم السبب قبل المتابعة في العلاج.",
          due_amount: 1,
          due_unit: "hours",
          assignee: "nobody",
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
export const ALL_RECIPES: Recipe[] = [...RECIPES, ...SPECIALTY_RECIPES, ...COORDINATOR_RECIPE_LIST];

export async function seedAgencyDefaults(c: Client) {
  for (const r of ALL_RECIPES) {
    await c.query(
      `insert into recipe_templates (key, name, name_ar, description, description_ar, trigger_type, trigger_config, steps, sort, specialty, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
       on conflict (key) do update set
         name = excluded.name, name_ar = excluded.name_ar, description = excluded.description,
         description_ar = excluded.description_ar,
         trigger_type = excluded.trigger_type, trigger_config = excluded.trigger_config,
         steps = excluded.steps, sort = excluded.sort, specialty = excluded.specialty, active = true`,
      [
        r.key, r.name, r.name_ar, r.description, r.description_ar, r.trigger_type,
        JSON.stringify(r.trigger_config), JSON.stringify(r.steps), r.sort,
        r.specialty ?? "general",
      ]
    );
  }
  /*
    A template taken out of the library leaves the gallery. Not deleted: a
    clinic's own copy keeps its recipe_key, and the row says what it was.
  */
  await c.query(`update recipe_templates set active = false where not (key = any($1::text[]))`, [ALL_RECIPES.map((r) => r.key)]);
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
