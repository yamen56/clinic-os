import type { Recipe, RecipeStep } from "./seed-recipes";
import { callTask, replyToBook, UNLESS_BOOKED } from "./recipe-kit";

/**
 * Automation recipes for one field of medicine.
 *
 * The generic library — confirm, remind, thank, recall, chase an invoice — is
 * the same everywhere. The messages that actually save a phone call are
 * specific: tell an eye patient they will not be able to drive home, tell a
 * dental patient what to do with the gauze, tell a laser patient to stay out
 * of the sun. None of those generalise, which is why they live here.
 *
 * Rules every recipe here keeps (2026-11-08 review, "make sure each one solves
 * a real problem and works"):
 *
 * - **The right patients.** A recall that only fits some patients says so in a
 *   condition — orthodontic patients by the "تقويم" tag (put on automatically
 *   when braces are charted), pregnant patients by "حامل", chronic patients by
 *   "مزمن" — instead of writing to everybody the specialty sees.
 * - **In time to act on.** Preparation that needs days ("stop retinoids three
 *   days before") goes out when the appointment is booked, not the day before,
 *   and it is not a second reminder on top of the clinic's own.
 * - **A yes becomes a booking.** Recalls end on "reply 1" (recipe-kit), which
 *   books the first free time like the last visit, waitlists when nothing is
 *   free, and passes anything else to a person.
 * - **Never a medical instruction the doctor did not give.** Medicines are
 *   stopped "as the doctor tells you", never by the message.
 *
 * Tag-triggered recipes name the tag in Arabic because that is what reception
 * types; a clinic that spells it differently changes one field in the builder.
 */

/** Only patients this condition holds for; the rest stop here. */
const only = (rules: Record<string, unknown>[]): RecipeStep => ({
  step_type: "condition",
  config: { match: "all", rules },
  children: { no: [{ step_type: "stop", config: {} }] },
});
const tagged = (tag: string) => ({ kind: "has_tag", value: tag });
const notBooked = { kind: "has_upcoming_appointment", negate: true };

const dental: Recipe[] = [
  {
    key: "dental_post_extraction",
    name: "After an extraction",
    name_ar: "تعليمات بعد الخلع",
    description:
      "Bleeding and dry socket bring patients back in pain. The moment an extraction is marked done on the chart: the aftercare in writing, and a check-in the next morning.",
    description_ar:
      "النزف والتهاب مكان الخلع يعيدان المريض متألماً. لحظة تسجيل الخلع على المخطط: تعليمات العناية مكتوبة، واطمئنان صباح اليوم التالي.",
    specialty: "dental",
    trigger_type: "treatment_done",
    trigger_config: { treatments: ["extraction", "extraction_surgical", "extraction_wisdom", "root_removal", "extraction_primary"] },
    sort: 20,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🦷\nتعليمات بعد الخلع:\n• اعضّ على الشاش نصف ساعة ولا تبدّله كل شوي\n• لا تمضمض ولا تبصق اليوم، ولا تشرب بشفّاطة\n• كمّادات باردة على الخد ١٠ دقائق كل ساعة\n• لا تدخين ولا أكل ساخن اليوم\n\nإذا استمر النزف أو زاد الألم بعد بكرا، راسلنا فوراً.",
        },
      },
      { step_type: "wait", config: { mode: "until_time", amount: 1, unit: "days", time: "11:00" } },
      {
        step_type: "send_whatsapp",
        config: { message: "كيف حالك اليوم {{patient.first_name}}؟ 🌸\nإذا في نزف أو ألم مستمر أو انتفاخ زايد، خبّرنا وبنشوفك." },
      },
    ],
  },
  {
    key: "dental_implant_aftercare",
    name: "After implant surgery",
    name_ar: "تعليمات بعد الزراعة",
    description:
      "Swelling on day two frightens patients into calling. When an implant, a bone graft or a sinus lift is marked done: what to expect and what to do, then a check-in two days later.",
    description_ar:
      "الانتفاخ في اليوم الثاني يقلق المريض فيتصل. عند تسجيل زراعة أو تطعيم عظم أو رفع جيب: ما المتوقع وما يجب فعله، ثم اطمئنان بعد يومين.",
    specialty: "dental",
    trigger_type: "treatment_done",
    trigger_config: { treatments: ["implant", "bone_graft", "sinus_lift"] },
    sort: 21,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🦷\nتعليمات بعد العملية ({{treatment.name}}):\n• كمّادات باردة على الخد أول يومين\n• أكل طري وبارد، وامضغ على الجهة الثانية\n• لا تمضمض بقوة ولا تدخّن\n• خُذ الدواء بمواعيده كما وصفه الطبيب\n\nانتفاخ بسيط طبيعي لثلاثة أيام. إذا زاد الألم أو النزف أو الانتفاخ، راسلنا فوراً.",
        },
      },
      { step_type: "wait", config: { mode: "until_time", amount: 2, unit: "days", time: "11:00" } },
      {
        step_type: "send_whatsapp",
        config: { message: "كيف صرت اليوم {{patient.first_name}}؟ 🌸\nإذا في ألم مستمر أو انتفاخ زايد أو حرارة، خبّرنا وبنشوفك." },
      },
    ],
  },
  {
    key: "dental_gum_surgery_aftercare",
    name: "After gum surgery",
    name_ar: "تعليمات بعد جراحة اللثة",
    description:
      "Brushing the wrong place in the first week undoes gum surgery. When a graft, a flap, crown lengthening or a gingivectomy is marked done: the week's care in writing.",
    description_ar:
      "التفريش على مكان العملية في الأسبوع الأول يفسد جراحة اللثة. عند تسجيل تطعيم أو شريحة أو إطالة تاج أو قص لثة: عناية الأسبوع مكتوبة.",
    specialty: "dental",
    trigger_type: "treatment_done",
    trigger_config: { treatments: ["gum_graft", "flap_surgery", "crown_lengthening", "gingivectomy"] },
    sort: 22,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🌿\nتعليمات بعد جراحة اللثة:\n• لا تفرّش مكان العملية أسبوعاً، وفرّش باقي الأسنان بلطف\n• استعمل المضمضة التي وصفها الطبيب\n• أكل طري، ولا تدخين\n• لا تشد الشفة لترى المكان\n\nموعد فك الغرز سيُرتّب معك. لأي نزف أو ألم زايد، راسلنا.",
        },
      },
    ],
  },
  {
    key: "dental_whitening_aftercare",
    name: "After whitening",
    name_ar: "تعليمات بعد التبييض",
    description:
      "Coffee in the first 48 hours stains a fresh whitening, and the patient blames the clinic. When whitening is marked done on the chart: what to avoid, and that the sensitivity passes.",
    description_ar:
      "القهوة في أول ٤٨ ساعة تصبغ التبييض الجديد ويلوم المريض العيادة. عند تسجيل التبييض على المخطط: ما يجب تجنّبه، وأن الحساسية تزول.",
    specialty: "dental",
    // From the chart, not from a tag somebody had to remember to add.
    trigger_type: "treatment_done",
    trigger_config: { treatments: ["whitening"] },
    sort: 23,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مبروك ابتسامتك الجديدة {{patient.first_name}} ✨\nلأول ٤٨ ساعة تجنّب: القهوة، الشاي، المشروبات الغازية الداكنة، الصلصات الحمراء، والتدخين.\nحساسية بسيطة بالأسنان طبيعية وبتروح لحالها خلال يومين.",
        },
      },
    ],
  },
  {
    key: "dental_crown_after_root_canal",
    name: "Crown after a root canal — reply to arrange",
    name_ar: "التلبيسة بعد علاج العصب — الترتيب بالرد",
    description:
      "A root-canal tooth left without its crown cracks months later. Two weeks after the root canal is finished, unless something is booked: why the crown matters, and a reply of 1 puts a call on reception's list to book it.",
    description_ar:
      "السن المعالج عصبه دون تلبيسة ينكسر بعد أشهر. بعد أسبوعين من إنهاء علاج العصب، إن لم يكن لديه موعد: لماذا التلبيسة مهمة، والرد بـ1 يضع مهمة اتصال للاستقبال لحجزها.",
    specialty: "dental",
    trigger_type: "treatment_done",
    trigger_config: { treatments: ["rct", "rct_retreat"] },
    sort: 24,
    steps: [
      { step_type: "wait", config: { mode: "until_time", amount: 14, unit: "days", time: "11:00" } },
      UNLESS_BOOKED,
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nسنّك ({{treatment.tooth}}) خلص علاج عصبه، بس لسا بحاجة تلبيسة تحميه — السن بعد علاج العصب بصير أضعف وممكن ينكسر.\nأرسل 1 ونتواصل معك لتحديد موعد التلبيسة.",
        },
      },
      {
        step_type: "wait_for_reply",
        config: { amount: 3, unit: "days", options: [{ label: "نعم", keywords: ["1", "نعم", "اكيد", "تمام", "موافق", "ok", "yes"] }] },
        children: {
          /*
            A call, not a booking: the crown is a different service from the
            root canal, and the lab work decides how long it needs.
          */
          "opt:0": [
            ...callTask("احجز تلبيسة لـ{{patient.name}} ({{treatment.tooth}})", "أنهى علاج العصب وطلب موعد التلبيسة بالرد على الرسالة."),
            { step_type: "send_whatsapp", config: { message: "تمام 🙏 رح يتواصل معك فريقنا خلال اليوم لتحديد موعد التلبيسة." } },
          ],
          other: [{ step_type: "flag_conversation", config: { reason: "ردّ على رسالة التلبيسة" } }],
        },
      },
    ],
  },
  {
    key: "dental_next_visit_unbooked",
    name: "Next session not booked — reply to book",
    name_ar: "الجلسة التالية غير محجوزة — الحجز بالرد",
    description:
      "Half-finished treatments are lost money and a tooth at risk. A week after a treatment's last step with nothing booked: why the next session matters, and a reply of 1 books it with the same doctor. No answer becomes a call on the to-do list.",
    description_ar:
      "العلاج غير المكتمل مال ضائع وسن في خطر. بعد أسبوع من آخر خطوة في علاج لم تُحجز جلسته التالية: لماذا الجلسة مهمة، والرد بـ1 يحجزها مع نفس الطبيب. وعدم الرد يصبح مهمة اتصال.",
    specialty: "dental",
    trigger_type: "treatment_unbooked",
    trigger_config: { days: 7 },
    sort: 25,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🦷\nعلاجك ({{treatment.name}}) لسا ما خلص، والجلسة الجاية مهمة حتى ما يرجع الألم أو يتضرر السن.\nأرسل 1 ونحجزلك أول موعد متاح مع نفس الطبيب.",
        },
      },
      replyToBook({
        like: "last",
        onSilence: callTask("اتصل بـ{{patient.name}} لحجز جلسته التالية", "{{treatment.name}} — لم يحجز ولم يرد على الرسالة."),
      }),
    ],
  },
  {
    key: "dental_tag_ortho_patients",
    name: "Mark orthodontic patients",
    name_ar: "تمييز مرضى التقويم",
    description:
      "So the monthly adjustment reminder reaches braces patients only. When brackets or aligners are charted, the file gets the tag 'تقويم'.",
    description_ar: "حتى يصل تذكير الشد الشهري لمرضى التقويم فقط. عند تسجيل براكيت أو تقويم شفاف على المخطط، يُضاف وسم «تقويم» للملف.",
    specialty: "dental",
    trigger_type: "treatment_done",
    trigger_config: { treatments: ["bracket", "aligners"] },
    sort: 26,
    steps: [{ step_type: "add_tag", config: { tag: "تقويم" } }],
  },
  {
    key: "dental_ortho_recall",
    name: "Braces adjustment due — reply to book",
    name_ar: "موعد شد التقويم — الحجز بالرد",
    description:
      "A missed adjustment stretches treatment by weeks. Four weeks after the last visit, for patients tagged 'تقويم' with nothing booked: a reply of 1 books the adjustment with the same doctor.",
    description_ar:
      "الشد الفائت يطيل العلاج أسابيع. بعد 4 أسابيع من آخر زيارة، لمن يحمل وسم «تقويم» وليس لديه موعد: الرد بـ1 يحجز الشد مع نفس الطبيب.",
    specialty: "dental",
    trigger_type: "after_last_visit",
    trigger_config: { days: 28 },
    sort: 27,
    steps: [
      only([tagged("تقويم"), notBooked]),
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nصار وقت شد التقويم في {{clinic.name}} — التأخير بيطوّل مدة العلاج.\nأرسل 1 ونحجزلك أول موعد متاح.",
        },
      },
      replyToBook({ like: "last" }),
    ],
  },
];

const dermatology: Recipe[] = [
  {
    key: "derm_pre_session_prep",
    name: "How to prepare — sent at booking",
    name_ar: "التحضير للجلسة — عند الحجز",
    description:
      "A patient who used retinol or tanned the week before cannot have their laser session, and the slot is lost. When the appointment is booked — early enough to act on: sun, retinoids, shaving.",
    description_ar:
      "المريض الذي استعمل الريتينول أو تعرّض للشمس قبل الجلسة لا يمكن إجراء جلسته، ويضيع الموعد. عند الحجز — بوقت يكفي للالتزام: الشمس، الريتينول، الحلاقة.",
    specialty: "dermatology",
    /*
      At booking, not the day before: "stop retinoids three days before" read
      the evening before is too late to follow, and a second message beside
      the clinic's own reminder that day was one too many.
    */
    trigger_type: "appointment_created",
    trigger_config: {},
    sort: 30,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 10, unit: "minutes" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🌿\nإذا كان موعدك ({{appointment.date}}) جلسة ليزر أو تقشير:\n• تجنّب الشمس والتسمير قبلها بأسبوع\n• أوقف كريمات الريتينول والتقشير قبلها بـ٣ أيام\n• احلق المنطقة قبل الجلسة بيوم (بدون شمع أو نتف)\n• تعالَ بدون مكياج أو عطور على المنطقة",
        },
      },
    ],
  },
  {
    key: "derm_post_session_care",
    name: "After a session — aftercare",
    name_ar: "العناية بعد الجلسة",
    description:
      "Sun on freshly treated skin causes the pigmentation the patient came to remove. A couple of hours after the visit: sunscreen, heat and what redness is normal.",
    description_ar:
      "الشمس على البشرة المعالجة حديثاً تسبب التصبغ الذي جاء المريض لإزالته. بعد ساعتين من الزيارة: واقي الشمس، والحرارة، وما هو الاحمرار الطبيعي.",
    specialty: "dermatology",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 31,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 2, unit: "hours" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "شكراً لزيارتك {{clinic.name}} اليوم 🌟\nإذا كانت جلستك ليزر أو تقشير:\n• واقي شمس SPF 50 كل ساعتين، حتى داخل البيت\n• لا مياه ساخنة ولا بخار ولا رياضة عنيفة ٤٨ ساعة\n• رطّب المنطقة ولا تفرك ولا تقشّر\n\nاحمرار خفيف أول يومين شي طبيعي.",
        },
      },
    ],
  },
  {
    key: "derm_laser_series_recall",
    name: "Next session in the course — reply to book",
    name_ar: "الجلسة التالية في البرنامج — الحجز بالرد",
    description:
      "Laser courses fail when the gap between sessions grows. A month after the last session, for patients tagged 'جلسات ليزر' with nothing booked: a reply of 1 books the next one.",
    description_ar:
      "برامج الليزر تفشل حين تطول الفترة بين الجلسات. بعد شهر من آخر جلسة، لمن يحمل وسم «جلسات ليزر» وليس لديه موعد: الرد بـ1 يحجز الجلسة التالية.",
    specialty: "dermatology",
    trigger_type: "after_last_visit",
    trigger_config: { days: 30 },
    sort: 32,
    steps: [
      only([tagged("جلسات ليزر"), notBooked]),
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمرّ شهر على آخر جلسة لك في {{clinic.name}}، وهذا الوقت المثالي للجلسة التالية حتى تحافظ على النتيجة.\nأرسل 1 ونحجزلك أول موعد متاح.",
        },
      },
      replyToBook({ like: "last" }),
    ],
  },
];

const ophthalmology: Recipe[] = [
  {
    key: "ophtha_dilation_notice",
    name: "Bring someone to drive you — sent at booking",
    name_ar: "تنبيه توسيع البؤبؤ — عند الحجز",
    description:
      "A patient who drove to an exam that needs dilation cannot drive home. When the appointment is booked: bring a driver and sunglasses — days ahead, when it can still be arranged.",
    description_ar:
      "المريض الذي جاء يقود لفحص يحتاج توسيع البؤبؤ لا يستطيع القيادة للعودة. عند الحجز: أحضر من يقود ونظارة شمسية — قبل الموعد بأيام حين يمكن الترتيب.",
    specialty: "ophthalmology",
    trigger_type: "appointment_created",
    trigger_config: {},
    sort: 33,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 10, unit: "minutes" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👁\nقد يحتاج فحصك ({{appointment.date}}) توسيع البؤبؤ، وبعدها بتكون الرؤية مشوّشة ٤–٦ ساعات:\n• رجاءً رتّب شخصاً يقود بدلاً عنك\n• أحضر نظارة شمسية\n• إذا بتلبس عدسات لاصقة، أحضر نظارتك الطبية معك",
        },
      },
    ],
  },
  {
    key: "ophtha_post_op_care",
    name: "After eye surgery",
    name_ar: "تعليمات بعد عملية العيون",
    description:
      "Rubbing the eye or skipping drops after surgery risks the result. Tag the patient 'عملية' after surgery: drops, water and rubbing in writing, and reception is reminded to book the review.",
    description_ar:
      "فرك العين أو إهمال القطرات بعد العملية يعرّض النتيجة للخطر. ضع وسم «عملية» بعد العملية: القطرات والماء والفرك مكتوبة، ويُذكَّر الاستقبال بحجز المراجعة.",
    specialty: "ophthalmology",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 34,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "سلامتك {{patient.first_name}} 🌷\nبعد العملية:\n• التزم بمواعيد القطرات بالضبط ولا توقفها من نفسك\n• لا تفرك عينك نهائياً، والبس الواقي وقت النوم\n• لا ماء ولا صابون على العين، ولا سباحة\n• لا رفع أوزان ولا انحناء للأمام\n\nإذا صار ألم شديد أو نقص مفاجئ بالنظر، اتصل فينا فوراً.",
        },
      },
      UNLESS_BOOKED,
      ...callTask("احجز مراجعة ما بعد العملية لـ{{patient.name}}", "أُرسلت تعليمات ما بعد العملية ولا يوجد موعد مراجعة محجوز."),
    ],
  },
  {
    key: "ophtha_annual_exam",
    name: "Annual eye exam — reply to book",
    name_ar: "الفحص السنوي للعيون — الحجز بالرد",
    description:
      "Pressure and prescription changes go unnoticed until they matter. A year after the last visit, unless something is booked: a reply of 1 books the yearly exam with the same doctor.",
    description_ar:
      "تغيّر ضغط العين والنظر لا يُلاحظ حتى يصبح مشكلة. بعد سنة من آخر زيارة، إن لم يكن لديه موعد: الرد بـ1 يحجز الفحص السنوي مع نفس الطبيب.",
    specialty: "ophthalmology",
    trigger_type: "after_last_visit",
    trigger_config: { days: 365 },
    sort: 35,
    steps: [
      UNLESS_BOOKED,
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمرّت سنة على آخر فحص لعينيك في {{clinic.name}}.\nالفحص السنوي بيكشف تغيّرات النظر وضغط العين قبل ما تحسّ فيها. أرسل 1 ونحجزلك أول موعد متاح.",
        },
      },
      replyToBook({ like: "last", waitDays: 3 }),
    ],
  },
];

const obgyn: Recipe[] = [
  {
    key: "obgyn_scan_prep",
    name: "Before an ultrasound — sent at booking",
    name_ar: "تحضير ما قبل السونار — عند الحجز",
    description:
      "An empty bladder means a repeat scan and a lost slot. When the appointment is booked: how to prepare if it includes an ultrasound, and the reports to bring.",
    description_ar:
      "المثانة الفارغة تعني إعادة السونار وضياع الموعد. عند الحجز: كيف تتحضّر إن تضمّن الموعد سونار، والتقارير التي تُحضرها.",
    specialty: "obgyn",
    trigger_type: "appointment_created",
    trigger_config: {},
    sort: 36,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 10, unit: "minutes" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🌸\nإذا كان موعدك ({{appointment.date}}) يتضمن سونار:\n• اشربي ٣–٤ أكواب ماء قبل الموعد بساعة ولا تفرّغي المثانة\n• أحضري تقارير وتحاليل الفحوصات السابقة إن وُجدت\n• البسي ملابس مريحة وواسعة",
        },
      },
    ],
  },
  {
    key: "obgyn_antenatal_recall",
    name: "Antenatal follow-up — reply to book",
    name_ar: "متابعة الحمل — الحجز بالرد",
    description:
      "A missed antenatal visit is a missed check. Four weeks after the last visit, for patients tagged 'حامل' with nothing booked: a reply of 1 books the follow-up with the same doctor.",
    description_ar:
      "زيارة متابعة الحمل الفائتة فحص فائت. بعد 4 أسابيع من آخر زيارة، لمن تحمل وسم «حامل» وليس لديها موعد: الرد بـ1 يحجز المتابعة مع نفس الطبيب.",
    specialty: "obgyn",
    trigger_type: "after_last_visit",
    trigger_config: { days: 28 },
    sort: 37,
    steps: [
      only([tagged("حامل"), notBooked]),
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🌸\nصار وقت موعد متابعة الحمل في {{clinic.name}}.\nأرسلي 1 ونحجزلك أول موعد متاح.",
        },
      },
      replyToBook({ like: "last" }),
    ],
  },
  {
    key: "obgyn_postpartum_checkin",
    name: "Postpartum check — reply to book",
    name_ar: "فحص ما بعد الولادة — الحجز بالرد",
    description:
      "The postpartum check is the visit most often skipped. Tag the patient 'ولادة' after delivery: the pregnancy follow-ups stop, and forty days later a reply of 1 books her check.",
    description_ar:
      "فحص ما بعد الولادة أكثر زيارة تُهمَل. ضع وسم «ولادة» بعد الولادة: تتوقف رسائل متابعة الحمل، وبعد ٤٠ يوماً الرد بـ1 يحجز فحصها.",
    specialty: "obgyn",
    trigger_type: "tag_added",
    trigger_config: { tag: "ولادة" },
    sort: 38,
    steps: [
      // She is no longer pregnant: the antenatal recall must stop writing to her.
      { step_type: "remove_tag", config: { tag: "حامل" } },
      { step_type: "wait", config: { mode: "until_time", amount: 40, unit: "days", time: "11:00" } },
      UNLESS_BOOKED,
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "ألف سلامة عليكِ {{patient.first_name}} 🌷\nصار وقت فحص ما بعد الولادة في {{clinic.name}} — بنطمّن عليكِ وعلى التئام الجرح ونحكي بموضوع وسائل المباعدة إذا حابة.\nأرسلي 1 ونحجزلك أول موعد متاح.",
        },
      },
      replyToBook({ like: "last" }),
    ],
  },
];

const pediatrics: Recipe[] = [
  {
    key: "peds_vaccine_recall",
    name: "Vaccination due (under 2) — reply to arrange",
    name_ar: "موعد المطعوم (دون سنتين) — الترتيب بالرد",
    description:
      "Vaccines slip when parents lose track of the schedule. Two months after the last visit, for children under two with nothing booked: a reminder to check the card, and a reply of 1 puts a call on reception's list.",
    description_ar:
      "المطاعيم تتأخر حين يضيع الأهل جدولها. بعد شهرين من آخر زيارة، للأطفال دون السنتين ممن ليس لديهم موعد: تذكير بمراجعة دفتر المطاعيم، والرد بـ1 يضع مهمة اتصال للاستقبال.",
    specialty: "pediatrics",
    trigger_type: "after_last_visit",
    trigger_config: { days: 60 },
    sort: 40,
    steps: [
      // Two-monthly vaccine visits are an infant's schedule, not an older child's.
      only([{ kind: "age_between", number: 0, number2: 1 }, notBooked]),
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً 👋\nمرّ شهران على آخر زيارة لـ{{patient.first_name}} في {{clinic.name}}.\nإذا كان عليه مطعوم حسب الدفتر، أرسلوا 1 ونتواصل معكم لتحديد الموعد. أحضروا دفتر المطاعيم معكم.",
        },
      },
      {
        step_type: "wait_for_reply",
        config: { amount: 3, unit: "days", options: [{ label: "نعم", keywords: ["1", "نعم", "اكيد", "تمام", "موافق", "ok", "yes"] }] },
        children: {
          // A call, not a booking: which vaccine, and how long it takes, is the clinic's to decide.
          "opt:0": [
            ...callTask("رتّب موعد مطعوم لـ{{patient.name}}", "طلب الأهل موعد المطعوم بالرد على الرسالة."),
            { step_type: "send_whatsapp", config: { message: "تمام 🙏 رح نتواصل معكم خلال اليوم لتحديد الموعد." } },
          ],
          other: [{ step_type: "flag_conversation", config: { reason: "ردّ على تذكير المطعوم" } }],
        },
      },
    ],
  },
  {
    key: "peds_visit_checkin",
    name: "How is your child today?",
    name_ar: "اطمئنان بعد الزيارة",
    description:
      "A fever that does not settle is caught a day late without it. The morning after the visit: how is the child, and when to come back without waiting.",
    description_ar: "الحرارة التي لا تنزل تُكتشف متأخرة يوماً بدونه. صباح اليوم التالي للزيارة: كيف حال الطفل، ومتى يعودون دون انتظار الموعد.",
    specialty: "pediatrics",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 41,
    steps: [
      { step_type: "wait", config: { mode: "until_time", amount: 1, unit: "days", time: "11:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً 🌸\nكيف حال {{patient.first_name}} اليوم؟\nإذا الحرارة ما نزلت، أو صار خمول أو رفض شرب، راسلونا فوراً ولا تنتظروا الموعد.",
        },
      },
      {
        step_type: "wait_for_reply",
        config: { amount: 1, unit: "days", options: [] },
        children: {
          replied: [
            { step_type: "flag_conversation", config: { reason: "ردّ على الاطمئنان بعد الزيارة" } },
            { step_type: "notify_staff", config: { title: "ردّ أهل {{patient.name}} بعد الزيارة", body: "«{{reply.text}}»", roles: ["doctor", "receptionist"] } },
          ],
        },
      },
    ],
  },
];

const orthopedics: Recipe[] = [
  {
    key: "ortho_post_op_care",
    name: "After orthopaedic surgery",
    name_ar: "تعليمات بعد عملية العظام",
    description:
      "Swelling, a wet wound or weight too soon set recovery back. Tag the patient 'عملية' after surgery: the first days' care and the warning signs in writing.",
    description_ar: "الانتفاخ أو بلل الجرح أو التحميل المبكر يؤخر التعافي. ضع وسم «عملية» بعد العملية: عناية الأيام الأولى وعلامات الخطر مكتوبة.",
    specialty: "orthopedics",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 42,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "سلامتك {{patient.first_name}} 🌷\nبعد العملية:\n• ارفع الطرف على وسادة قدر الإمكان أول ٤٨ ساعة\n• كمّادات باردة ١٥ دقيقة كل ساعتين\n• حافظ على الجرح ناشف ونظيف ولا تبلّه\n• لا تحمّل وزن على الطرف إلا حسب تعليمات الطبيب\n\nإذا صار انتفاخ شديد، احمرار، حرارة أو ألم مفاجئ بالساق — اتصل فينا فوراً.",
        },
      },
    ],
  },
  {
    key: "ortho_home_exercise",
    name: "Don't skip the exercises",
    name_ar: "تذكير بتمارين البيت",
    description:
      "Exercises are dropped on day two, and the patient blames the treatment. Two days after a visit, for anyone given exercises: keep going, and ask if one hurts.",
    description_ar: "التمارين تُترك في اليوم الثاني، ويلوم المريض العلاج. بعد يومين من الزيارة، لمن وُصفت له تمارين: استمر، واسألنا إن آلمك تمرين.",
    specialty: "orthopedics",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 43,
    steps: [
      { step_type: "wait", config: { mode: "until_time", amount: 2, unit: "days", time: "17:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nإذا وصفنالك تمارين: هي بتفرق أكتر من أي شي ثاني بسرعة تحسّنك، فلا تتركها.\nإذا في تمرين بيوجعك أو مش متأكد من طريقته، راسلنا.",
        },
      },
    ],
  },
  {
    key: "ortho_cast_removal",
    name: "Cast review due — reply to book",
    name_ar: "مراجعة الجبيرة — الحجز بالرد",
    description:
      "A cast left on too long stiffens the joint. Tag the patient 'جبيرة' when it goes on: three weeks later, unless something is booked, a reply of 1 books the X-ray and review with the same doctor.",
    description_ar:
      "الجبيرة التي تبقى أطول من اللازم تُيبّس المفصل. ضع وسم «جبيرة» عند تركيبها: بعد ثلاثة أسابيع، إن لم يكن لديه موعد، الرد بـ1 يحجز التصوير والمراجعة مع نفس الطبيب.",
    specialty: "orthopedics",
    trigger_type: "tag_added",
    trigger_config: { tag: "جبيرة" },
    sort: 44,
    steps: [
      { step_type: "wait", config: { mode: "until_time", amount: 21, unit: "days", time: "10:00" } },
      UNLESS_BOOKED,
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nصار وقت مراجعة الجبيرة في {{clinic.name}} — تصوير وفحص قبل الفك.\nأرسل 1 ونحجزلك أول موعد متاح.",
        },
      },
      replyToBook({
        like: "last",
        onSilence: callTask("متابعة جبيرة: {{patient.name}}", "مرّت ثلاثة أسابيع على التجبير ولم يحجز المراجعة."),
      }),
    ],
  },
];

const physiotherapy: Recipe[] = [
  {
    key: "physio_home_program",
    name: "Your home programme",
    name_ar: "برنامج تمارين البيت",
    description:
      "Half the result is made between sessions. Right after a session, while it is fresh: do the home exercises, and tell us if they hurt.",
    description_ar: "نصف النتيجة تُصنع بين الجلسات. بعد الجلسة مباشرة وهي حاضرة في الذهن: التزم بتمارين البيت، وأخبرنا إن آلمتك.",
    specialty: "physiotherapy",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 45,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "شكراً لجلستك اليوم في {{clinic.name}} 💪\nلا تنسَ تمارين البيت — الجلسة لحالها بتعطي نص النتيجة، والباقي بين الجلسات.\nإذا زاد الألم بعد التمرين أو حسّيت بشي غريب، راسلنا قبل الجلسة الجاية.",
        },
      },
    ],
  },
  {
    key: "physio_lapsed_series",
    name: "Two weeks without a session — reply to book",
    name_ar: "انقطاع عن الجلسات — الحجز بالرد",
    description:
      "Courses end quietly halfway. Two weeks since the last session, with nothing booked and the patient not tagged 'أنهى البرنامج': a reply of 1 books the next session with the same therapist; no answer becomes a call.",
    description_ar:
      "البرامج تنتهي بصمت في منتصفها. بعد أسبوعين من آخر جلسة، إن لم يكن لديه موعد ولا يحمل وسم «أنهى البرنامج»: الرد بـ1 يحجز الجلسة التالية مع نفس المعالج، وعدم الرد يصبح مهمة اتصال.",
    specialty: "physiotherapy",
    trigger_type: "after_last_visit",
    trigger_config: { days: 14 },
    sort: 46,
    steps: [
      only([{ kind: "has_tag", value: "أنهى البرنامج", negate: true }, notBooked]),
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nصار أسبوعين على آخر جلسة لك في {{clinic.name}}.\nالانقطاع بمنتصف البرنامج بيرجّع التحسّن للوراء. أرسل 1 ونحجزلك الجلسة الجاية.",
        },
      },
      replyToBook({
        like: "last",
        onSilence: callTask("متابعة انقطاع: {{patient.name}}", "أسبوعان بدون جلسة ولم يرد على الرسالة. اتصل للاطمئنان وإعادة الجدولة."),
      }),
    ],
  },
];

const ent: Recipe[] = [
  {
    key: "ent_post_op_care",
    name: "After ENT surgery",
    name_ar: "تعليمات بعد عملية الأنف والأذن",
    description:
      "Blowing the nose or lifting in the first week causes bleeding. Tag the patient 'عملية' after surgery: the week's do's and don'ts and the warning signs.",
    description_ar: "نفخ الأنف أو رفع الأوزان في الأسبوع الأول يسبب النزف. ضع وسم «عملية» بعد العملية: ما يجب وما لا يجب في الأسبوع الأول وعلامات الخطر.",
    specialty: "ent",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 47,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "سلامتك {{patient.first_name}} 🌷\nأول أسبوع بعد العملية:\n• لا تنفخ أنفك بقوة ولا ترفع أوزان\n• نم على وسادتين، والرأس أعلى من الجسم\n• أكل بارد وطري، وابتعد عن الحار والحامض\n• التزم بالبخاخ أو القطرات حسب الوصفة\n\nإذا صار نزف مستمر أو حرارة، اتصل فينا فوراً.",
        },
      },
    ],
  },
];

const cardiology: Recipe[] = [
  {
    key: "cardio_fasting_prep",
    name: "Fasting and medicines — sent at booking",
    name_ar: "الصيام والأدوية — عند الحجز",
    description:
      "A patient who ate before their lipid test, or stopped their heart pills, wastes the visit. When the appointment is booked: fasting if there are tests, keep taking your medicines, what to bring.",
    description_ar:
      "المريض الذي أكل قبل تحليل الدهون أو أوقف أدوية القلب يضيّع الزيارة. عند الحجز: الصيام إن وُجدت تحاليل، واستمر على أدويتك، وما تُحضره.",
    specialty: "cardiology",
    trigger_type: "appointment_created",
    trigger_config: {},
    sort: 48,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 10, unit: "minutes" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nقبل موعدك ({{appointment.date}}):\n• صائم ٨–١٢ ساعة إذا كان في تحاليل دهون أو سكر (الماء مسموح)\n• لا توقف أدوية القلب أو الضغط إلا إذا الطبيب قال غير هيك\n• أحضر معك قائمة أدويتك وآخر تقاريرك\n• البس ملابس مريحة وحذاء رياضي إذا في فحص جهد",
        },
      },
    ],
  },
  {
    key: "cardio_medication_review",
    name: "Three-month review — reply to book",
    name_ar: "مراجعة كل 3 أشهر — الحجز بالرد",
    description:
      "Chronic heart patients drift off their review and their medicines. Three months after the last visit, unless something is booked: a reply of 1 books the review with the same doctor.",
    description_ar:
      "مرضى القلب المزمنون يبتعدون عن المراجعة والأدوية. بعد 3 أشهر من آخر زيارة، إن لم يكن لديه موعد: الرد بـ1 يحجز المراجعة مع نفس الطبيب.",
    specialty: "cardiology",
    trigger_type: "after_last_visit",
    trigger_config: { days: 90 },
    sort: 49,
    steps: [
      UNLESS_BOOKED,
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمرّت ثلاثة أشهر على آخر مراجعة لك في {{clinic.name}}.\nوقت مراجعة الأدوية وقياس الضغط والاطمئنان على التحاليل. أرسل 1 ونحجزلك أول موعد متاح.",
        },
      },
      replyToBook({ like: "last", waitDays: 3 }),
    ],
  },
];

const nutrition: Recipe[] = [
  {
    key: "nutrition_weekly_checkin",
    name: "Weekly check-in",
    name_ar: "متابعة أسبوعية",
    description:
      "Most diet plans are abandoned in week one, quietly. A week after the consultation: how is it going, and the plan can change — any answer goes to the team.",
    description_ar: "أغلب الأنظمة الغذائية تُترك بصمت في الأسبوع الأول. بعد أسبوع من الاستشارة: كيف تسير، والبرنامج يمكن تعديله — وأي رد يصل للفريق.",
    specialty: "nutrition",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 50,
    steps: [
      { step_type: "wait", config: { mode: "until_time", amount: 7, unit: "days", time: "10:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🌟\nكيف ماشي معك البرنامج هذا الأسبوع؟\nإذا في صنف صعب عليك أو موعد وجبة مش مناسب لدوامك، راسلنا وبنعدّله — البرنامج اللي بينفّذ أهم من البرنامج المثالي.",
        },
      },
      {
        step_type: "wait_for_reply",
        config: { amount: 2, unit: "days", options: [] },
        children: {
          replied: [
            { step_type: "flag_conversation", config: { reason: "ردّ على المتابعة الأسبوعية" } },
            { step_type: "notify_staff", config: { title: "{{patient.name}} ردّ على المتابعة الأسبوعية", body: "«{{reply.text}}»", roles: ["doctor"] } },
          ],
        },
      },
    ],
  },
  {
    key: "nutrition_followup_recall",
    name: "Next weigh-in — reply to book",
    name_ar: "موعد القياس القادم — الحجز بالرد",
    description:
      "Progress stalls when weigh-ins stop. Two weeks after the last visit, unless something is booked: a reply of 1 books the next weigh-in.",
    description_ar: "التقدم يتوقف حين تتوقف المتابعة. بعد أسبوعين من آخر زيارة، إن لم يكن لديه موعد: الرد بـ1 يحجز موعد القياس التالي.",
    specialty: "nutrition",
    trigger_type: "after_last_visit",
    trigger_config: { days: 14 },
    sort: 51,
    steps: [
      UNLESS_BOOKED,
      {
        step_type: "send_whatsapp",
        config: {
          message: "مرحباً {{patient.first_name}} 👋\nصار وقت موعد القياس والمتابعة في {{clinic.name}}.\nأرسل 1 ونحجزلك أول موعد متاح.",
        },
      },
      replyToBook({ like: "last" }),
    ],
  },
];

const psychiatry: Recipe[] = [
  {
    key: "psych_discreet_reminder",
    name: "Discreet reminder — reply to confirm",
    name_ar: "تذكير متحفّظ — التأكيد بالرد",
    description:
      "A reminder that names a psychiatry clinic can be read on a lock screen by someone else. The day before: only the time, 1 to confirm, 2 to change. A psychiatry clinic gets this instead of the standard reminder.",
    description_ar:
      "التذكير الذي يذكر اسم عيادة نفسية قد يقرؤه غير المريض على شاشة الهاتف. قبل يوم: الوقت فقط، و1 للتأكيد، و2 للتغيير. العيادة النفسية تحصل على هذا بدل التذكير العادي.",
    specialty: "psychiatry",
    trigger_type: "before_appointment",
    trigger_config: { hours: 24 },
    sort: 52,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          // Deliberately says almost nothing: no clinic, no service. The time is what they need.
          message: "مرحباً {{patient.first_name}}، تذكير بموعدك {{appointment.day}} الساعة {{appointment.time}}.\nللتأكيد أرسل 1، ولتغيير الموعد أرسل 2.",
        },
      },
      {
        step_type: "wait_for_reply",
        config: {
          amount: 12,
          unit: "hours",
          options: [
            { label: "تأكيد", keywords: ["1", "نعم", "اكيد", "تمام", "موافق", "ok", "yes"] },
            { label: "تغيير", keywords: ["2", "تغيير", "تأجيل", "الغاء", "change", "cancel"] },
          ],
        },
        children: {
          "opt:0": [
            { step_type: "update_appointment", config: { status: "confirmed" } },
            { step_type: "send_whatsapp", config: { message: "تم ✅ بانتظارك." } },
          ],
          "opt:1": [
            { step_type: "flag_conversation", config: { reason: "يريد تغيير موعده" } },
            ...callTask("اتصل بـ{{patient.name}} لتغيير موعده", "{{appointment.date}} — {{appointment.time}}"),
            { step_type: "send_whatsapp", config: { message: "ولا يهمك 🙏 سنتواصل معك لترتيب وقت آخر." } },
          ],
          other: [{ step_type: "flag_conversation", config: { reason: "ردّ على تذكير الموعد" } }],
        },
      },
    ],
  },
  {
    key: "psych_missed_session_care",
    name: "A missed session, handled gently",
    name_ar: "متابعة جلسة فائتة",
    description:
      "A missed session can be the first sign of a patient struggling. A message without pressure, and a task for a personal contact within a day.",
    description_ar: "الجلسة الفائتة قد تكون أول إشارة لمريض يمر بوقت صعب. رسالة دون ضغط، ومهمة لتواصل شخصي خلال يوم.",
    specialty: "psychiatry",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "no_show" },
    sort: 53,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🌸\nما شفناك اليوم، ونحنا موجودين وقت ما تكون جاهز.\nإذا حاب نأجّل أو نغيّر وقت الجلسة، راسلنا وبنرتبها بدون أي ضغط.",
        },
      },
      ...callTask("متابعة جلسة فائتة: {{patient.name}}", "لم يحضر الجلسة. تواصل شخصي خفيف خلال ٢٤ ساعة."),
    ],
  },
  {
    key: "psych_followup_recall",
    name: "Three weeks since the last session",
    name_ar: "متابعة بعد ثلاثة أسابيع",
    description:
      "Patients who stop coming rarely say so. Three weeks after the last session, unless something is booked: a quiet door left open — a reply of 1 books the next session, no pressure either way.",
    description_ar:
      "المرضى الذين يتوقفون نادراً ما يخبرون. بعد ثلاثة أسابيع من آخر جلسة، إن لم يكن لديه موعد: باب يبقى مفتوحاً بهدوء — الرد بـ1 يحجز الجلسة التالية، دون ضغط.",
    specialty: "psychiatry",
    trigger_type: "after_last_visit",
    trigger_config: { days: 21 },
    sort: 54,
    steps: [
      UNLESS_BOOKED,
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمرّت فترة على آخر جلسة، وحبينا نطمّن عليك.\nإذا حاب نكمّل أرسل 1 ونحجزلك. وإذا حاب تاخد وقتك، هذا كمان تمام.",
        },
      },
      replyToBook({ like: "last", waitDays: 3 }),
    ],
  },
];

const plasticSurgery: Recipe[] = [
  {
    key: "plastic_pre_op_instructions",
    name: "Before surgery — when it is scheduled",
    name_ar: "تعليمات ما قبل العملية — عند تحديدها",
    description:
      "Surgeries are cancelled on the day for smoking, eating or blood thinners. Tag the patient 'موعد عملية' when surgery is scheduled: the preparation in writing, days ahead — medicines only as the surgeon instructs.",
    description_ar:
      "العمليات تُلغى يومها بسبب التدخين أو الأكل أو مميعات الدم. ضع وسم «موعد عملية» عند تحديد العملية: التحضير مكتوب قبل أيام — والأدوية حسب تعليمات الجراح فقط.",
    specialty: "plastic_surgery",
    /*
      On a tag, not "48 hours before every appointment": that sent fasting and
      blood-thinner instructions to every consultation, and two days is too
      late to stop smoking a week ahead.
    */
    trigger_type: "tag_added",
    trigger_config: { tag: "موعد عملية" },
    sort: 55,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🌷\nتعليمات ما قبل العملية:\n• لا تدخين من الآن وحتى أسبوعين بعد العملية\n• أخبرنا إذا كنت تأخذ أسبرين أو مميعات دم أو مكمّلات — الطبيب يحدد إن ومتى توقفها، فلا توقف أي دواء من نفسك\n• صيام تام ٨ ساعات قبل العملية (بما فيها الماء)\n• تعال بدون مكياج ولا مجوهرات، والبس ملابس واسعة تفتح من الأمام\n• رتّب شخصاً يوصّلك ويرجّعك ويبقى معك أول ليلة",
        },
      },
    ],
  },
  {
    key: "plastic_post_op_day1",
    name: "Day one after surgery",
    name_ar: "اليوم الأول بعد العملية",
    description:
      "The first night brings the most frightened calls. Tag the patient 'عملية' after surgery: the next morning, a check-in with what is expected and what is not.",
    description_ar: "الليلة الأولى تأتي بأكثر المكالمات قلقاً. ضع وسم «عملية» بعد العملية: صباح اليوم التالي، اطمئنان مع ما هو متوقع وما ليس كذلك.",
    specialty: "plastic_surgery",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 56,
    steps: [
      { step_type: "remove_tag", config: { tag: "موعد عملية" } },
      { step_type: "wait", config: { mode: "until_time", amount: 1, unit: "days", time: "11:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "سلامتك {{patient.first_name}} 🌷\nكيف كانت أول ليلة؟\nتذكير: نم ورأسك مرفوع، التزم بالمشد أو الضماد، خذ المضاد الحيوي بمواعيده، ولا تبلّ الجرح.\nانتفاخ وكدمات أول أيام شي متوقع. إذا صار ألم شديد، حرارة، أو نزف — اتصل فينا فوراً.",
        },
      },
    ],
  },
  {
    key: "plastic_post_op_week",
    name: "One-week review — reply to book",
    name_ar: "مراجعة الأسبوع الأول — الحجز بالرد",
    description:
      "Stitches and the first look at the result need a visit in week one. Seven days after the 'عملية' tag, unless something is booked: a reply of 1 books it with the same surgeon; no answer becomes a call.",
    description_ar:
      "الغرز والنظرة الأولى للنتيجة تحتاج زيارة في الأسبوع الأول. بعد 7 أيام من وسم «عملية»، إن لم يكن لديه موعد: الرد بـ1 يحجزها مع نفس الجراح، وعدم الرد يصبح مهمة اتصال.",
    specialty: "plastic_surgery",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 57,
    steps: [
      { step_type: "wait", config: { mode: "until_time", amount: 7, unit: "days", time: "10:00" } },
      UNLESS_BOOKED,
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nصار وقت مراجعة الأسبوع الأول في {{clinic.name}} — بنطمّن على الجرح ونشيل الغرز إذا لزم.\nأرسل 1 ونحجزلك أول موعد متاح.",
        },
      },
      replyToBook({
        like: "last",
        onSilence: callTask("مراجعة أسبوع بعد العملية: {{patient.name}}", "لم يحجز مراجعة الأسبوع الأول ولم يرد على الرسالة."),
      }),
    ],
  },
];

const urology: Recipe[] = [
  {
    key: "uro_scan_prep",
    name: "Full bladder for your scan — sent at booking",
    name_ar: "تحضير السونار — عند الحجز",
    description:
      "An empty bladder means a repeat scan. When the appointment is booked: how to prepare if it includes an ultrasound, and what to bring.",
    description_ar: "المثانة الفارغة تعني إعادة السونار. عند الحجز: كيف تتحضّر إن تضمّن الموعد سونار، وما تُحضره.",
    specialty: "urology",
    trigger_type: "appointment_created",
    trigger_config: {},
    sort: 58,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 10, unit: "minutes" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nإذا كان موعدك ({{appointment.date}}) يتضمن سونار:\n• اشرب ٤ أكواب ماء قبل الموعد بساعة ولا تفرّغ المثانة\n• أحضر معك تقارير وتحاليل الفحوصات السابقة",
        },
      },
    ],
  },
  {
    key: "uro_post_op_care",
    name: "After a urological procedure",
    name_ar: "تعليمات بعد العملية",
    description:
      "Too little water or heavy lifting after a procedure brings patients back. Tag the patient 'عملية' after it: fluids, lifting, and the signs that cannot wait.",
    description_ar: "قلة الماء أو رفع الأوزان بعد العملية يعيدان المريض. ضع وسم «عملية» بعدها: السوائل، والأوزان، والعلامات التي لا تحتمل الانتظار.",
    specialty: "urology",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 59,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "سلامتك {{patient.first_name}} 🌷\nبعد العملية:\n• اشرب ٢–٣ لتر ماء يومياً إلا إذا الطبيب قال غير هيك\n• لا ترفع أوزان ولا تمارس رياضة عنيفة أسبوعين\n• التزم بالمضاد الحيوي كامل المدة\n\nحرقة خفيفة أو دم بسيط أول أيام متوقع. إذا صار حرارة، ألم شديد، أو احتباس بول — اتصل فينا فوراً.",
        },
      },
    ],
  },
];

const internalMedicine: Recipe[] = [
  {
    key: "internal_fasting_labs",
    name: "Fasting and medicines — sent at booking",
    name_ar: "الصيام والأدوية — عند الحجز",
    description:
      "Labs drawn after breakfast have to be repeated. When the appointment is booked: fast if there are tests, keep taking chronic medicines, bring the list.",
    description_ar: "التحاليل المسحوبة بعد الفطور تُعاد. عند الحجز: الصيام إن وُجدت تحاليل، والاستمرار على الأدوية المزمنة، وإحضار قائمتها.",
    specialty: "internal_medicine",
    trigger_type: "appointment_created",
    trigger_config: {},
    sort: 60,
    steps: [
      { step_type: "wait", config: { mode: "duration", amount: 10, unit: "minutes" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nقبل موعدك ({{appointment.date}}):\n• صائم ٨–١٢ ساعة إذا كان في تحاليل (الماء مسموح)\n• لا توقف أدويتك المزمنة إلا إذا الطبيب قال غير هيك\n• أحضر معك قائمة أدويتك وآخر تقاريرك",
        },
      },
    ],
  },
  {
    key: "internal_chronic_recall",
    name: "Chronic follow-up — reply to book",
    name_ar: "متابعة الأمراض المزمنة — الحجز بالرد",
    description:
      "Diabetic and hypertensive patients slip out of review. Three months after the last visit, for patients tagged 'مزمن' with nothing booked: a reply of 1 books the review with the same doctor.",
    description_ar:
      "مرضى السكري والضغط يبتعدون عن المراجعة. بعد 3 أشهر من آخر زيارة، لمن يحمل وسم «مزمن» وليس لديه موعد: الرد بـ1 يحجز المراجعة مع نفس الطبيب.",
    specialty: "internal_medicine",
    trigger_type: "after_last_visit",
    trigger_config: { days: 90 },
    sort: 61,
    steps: [
      only([tagged("مزمن"), notBooked]),
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمرّت ثلاثة أشهر على آخر مراجعة لك في {{clinic.name}}.\nوقت مراجعة الأدوية والتحاليل الدورية. أرسل 1 ونحجزلك أول موعد متاح.",
        },
      },
      replyToBook({ like: "last", waitDays: 3 }),
    ],
  },
];

export const SPECIALTY_RECIPES: Recipe[] = [
  ...dental,
  ...dermatology,
  ...ophthalmology,
  ...obgyn,
  ...pediatrics,
  ...orthopedics,
  ...physiotherapy,
  ...ent,
  ...cardiology,
  ...nutrition,
  ...psychiatry,
  ...plasticSurgery,
  ...urology,
  ...internalMedicine,
];
