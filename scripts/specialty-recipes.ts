import type { Recipe } from "./seed-recipes";

/**
 * Automation recipes for one field of medicine.
 *
 * The generic library — confirm, remind, thank, recall, chase an invoice — is
 * the same everywhere, and it is also the least interesting half of what a
 * clinic wants. The messages that actually save a phone call are specific: tell
 * an eye patient they will not be able to drive home, tell a dental patient what
 * to do with the gauze, tell a laser patient to stay out of the sun. None of
 * those generalise, which is exactly why nobody was writing them.
 *
 * All of these arrive switched **off**, like the rest of the library. A clinic
 * reads one, edits the wording to sound like itself, and turns it on. The
 * specialty decides what is on the shelf, never what is running.
 *
 * Tag-triggered recipes name the tag in Arabic because that is what reception
 * types. A clinic that spells it differently changes the trigger in the builder,
 * or renames its own tag — either way it is one field, in the open.
 */

const dental: Recipe[] = [
  {
    key: "dental_post_extraction",
    name: "After an extraction",
    name_ar: "تعليمات بعد الخلع",
    description: "Aftercare the moment a patient is tagged as having had a tooth out, then a check-in the next day.",
    specialty: "dental",
    trigger_type: "tag_added",
    trigger_config: { tag: "خلع" },
    sort: 20,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🦷\nتعليمات بعد الخلع:\n• اعضّ على الشاش نصف ساعة ولا تبدّله كل شوي\n• لا تمضمض ولا تبصق اليوم، ولا تشرب بشفّاطة\n• كمّادات باردة على الخد ١٠ دقائق كل ساعة\n• لا تدخين ولا أكل ساخن اليوم\n\nإذا استمر النزف أو زاد الألم بعد بكرا، راسلنا فوراً.",
        },
      },
      { step_type: "wait", config: { minutes: 1440, until_time: "11:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message: "كيف حالك اليوم {{patient.first_name}}؟ 🌸\nإذا في نزف أو ألم مستمر أو انتفاخ زايد، خبّرنا وبنشوفك.",
        },
      },
    ],
  },
  {
    key: "dental_whitening_aftercare",
    name: "After whitening",
    name_ar: "تعليمات بعد التبييض",
    description: "The 48-hour food and drink list, sent as soon as the patient is tagged.",
    specialty: "dental",
    trigger_type: "tag_added",
    trigger_config: { tag: "تبييض" },
    sort: 21,
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
    key: "dental_ortho_recall",
    name: "Orthodontic adjustment due",
    name_ar: "موعد شد التقويم",
    description: "Four weeks after the last visit — the usual gap between adjustments.",
    specialty: "dental",
    trigger_type: "after_last_visit",
    trigger_config: { days: 28 },
    sort: 22,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nصار وقت موعد شد التقويم في {{clinic.name}}.\nحاب نحجزلك هذا الأسبوع؟ راسلنا وبنرتبلك أنسب وقت.",
        },
      },
    ],
  },
];

const dermatology: Recipe[] = [
  {
    key: "derm_pre_session_prep",
    name: "Before a session — how to prepare",
    name_ar: "تحضير ما قبل الجلسة",
    description: "Sun, retinoids and shaving, a day before the appointment.",
    specialty: "dermatology",
    trigger_type: "before_appointment",
    trigger_config: { hours: 24 },
    sort: 23,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "تذكير بجلستك غداً في {{clinic.name}} 🕐 {{appointment.time}}\nقبل الجلسة:\n• تجنّب الشمس والتسمير آخر أسبوع\n• أوقف كريمات الريتينول والتقشير قبل ٣ أيام\n• احلق المنطقة قبل الجلسة بيوم (بدون شمع أو نتف)\n• تعالَ بدون مكياج أو عطور على المنطقة",
        },
      },
    ],
  },
  {
    key: "derm_post_session_care",
    name: "After a session — aftercare",
    name_ar: "العناية بعد الجلسة",
    description: "Goes out a couple of hours after the visit is marked completed.",
    specialty: "dermatology",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 24,
    steps: [
      { step_type: "wait", config: { minutes: 120 } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "شكراً لزيارتك {{clinic.name}} اليوم 🌟\nبعد الجلسة:\n• واقي شمس SPF 50 كل ساعتين، حتى داخل البيت\n• لا مياه ساخنة ولا بخار ولا رياضة عنيفة ٤٨ ساعة\n• رطّب المنطقة ولا تفرك ولا تقشّر\n\nاحمرار خفيف أول يومين شي طبيعي.",
        },
      },
    ],
  },
  {
    key: "derm_laser_series_recall",
    name: "Next session in the course",
    name_ar: "موعد الجلسة التالية",
    description: "A month after the last visit, for patients partway through a course.",
    specialty: "dermatology",
    trigger_type: "after_last_visit",
    trigger_config: { days: 30 },
    sort: 25,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمرّ شهر على آخر جلسة لك في {{clinic.name}}، وهذا الوقت المثالي للجلسة التالية حتى تحافظ على النتيجة.\nحاب نحجزلك؟",
        },
      },
    ],
  },
];

const ophthalmology: Recipe[] = [
  {
    key: "ophtha_dilation_notice",
    name: "Bring someone to drive you",
    name_ar: "تنبيه توسيع البؤبؤ",
    description: "The warning that saves the phone call: dilated pupils mean no driving home.",
    specialty: "ophthalmology",
    trigger_type: "before_appointment",
    trigger_config: { hours: 24 },
    sort: 26,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "تذكير بموعدك غداً في {{clinic.name}} 👁 {{appointment.time}}\nقد يحتاج الفحص توسيع البؤبؤ، وبعدها بتكون الرؤية مشوّشة ٤–٦ ساعات.\n• رجاءً أحضر معك شخص يقود بدلاً عنك\n• جيب نظارة شمسية\n• إذا بتلبس عدسات لاصقة، أحضر نظارتك الطبية معك",
        },
      },
    ],
  },
  {
    key: "ophtha_post_op_care",
    name: "After eye surgery",
    name_ar: "تعليمات بعد عملية العيون",
    description: "Drops, water and rubbing — sent when the patient is tagged post-op.",
    specialty: "ophthalmology",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 27,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "سلامتك {{patient.first_name}} 🌷\nبعد العملية:\n• التزم بمواعيد القطرات بالضبط ولا توقفها من نفسك\n• لا تفرك عينك نهائياً، والبس الواقي وقت النوم\n• لا ماء ولا صابون على العين، ولا سباحة\n• لا رفع أوزان ولا انحناء للأمام\n\nإذا صار ألم شديد أو نقص مفاجئ بالنظر، اتصل فينا فوراً.",
        },
      },
      {
        step_type: "notify_staff",
        config: {
          title: "متابعة ما بعد العملية: {{patient.name}}",
          body: "أُرسلت تعليمات ما بعد العملية. تأكد من حجز موعد المراجعة.",
          roles: ["owner", "receptionist"],
        },
      },
    ],
  },
  {
    key: "ophtha_annual_exam",
    name: "Annual eye exam",
    name_ar: "الفحص السنوي للعيون",
    description: "A year after the last visit.",
    specialty: "ophthalmology",
    trigger_type: "after_last_visit",
    trigger_config: { days: 365 },
    sort: 28,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمرّت سنة على آخر فحص لعينيك في {{clinic.name}}.\nالفحص السنوي بيكشف تغيّرات النظر وضغط العين قبل ما تحسّ فيها. حاب نحجزلك موعد؟",
        },
      },
    ],
  },
];

const obgyn: Recipe[] = [
  {
    key: "obgyn_scan_prep",
    name: "Before an ultrasound",
    name_ar: "تحضير ما قبل السونار",
    description: "A full bladder, and the paperwork worth bringing.",
    specialty: "obgyn",
    trigger_type: "before_appointment",
    trigger_config: { hours: 24 },
    sort: 29,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "تذكير بموعدك غداً في {{clinic.name}} 🕐 {{appointment.time}}\nإذا كان الموعد يتضمن سونار:\n• اشربي ٣–٤ أكواب ماء قبل الموعد بساعة ولا تفرّغي المثانة\n• أحضري تقارير وتحاليل الفحوصات السابقة إن وُجدت\n• البسي ملابس مريحة وواسعة",
        },
      },
    ],
  },
  {
    key: "obgyn_antenatal_recall",
    name: "Antenatal follow-up due",
    name_ar: "موعد متابعة الحمل",
    description: "Four weeks after the last visit — the routine antenatal interval.",
    specialty: "obgyn",
    trigger_type: "after_last_visit",
    trigger_config: { days: 28 },
    sort: 30,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🌸\nصار وقت موعد المتابعة في {{clinic.name}}.\nحابة نحجزلك هذا الأسبوع؟ راسلينا وبنرتبلك أنسب وقت.",
        },
      },
    ],
  },
  {
    key: "obgyn_postpartum_checkin",
    name: "Postpartum check",
    name_ar: "متابعة ما بعد الولادة",
    description: "Forty days after the patient is tagged, which is when this visit is expected here.",
    specialty: "obgyn",
    trigger_type: "tag_added",
    trigger_config: { tag: "ولادة" },
    sort: 31,
    steps: [
      { step_type: "wait", config: { minutes: 57600, until_time: "11:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "ألف سلامة عليكِ {{patient.first_name}} 🌷\nصار وقت فحص ما بعد الولادة في {{clinic.name}} — بنطمّن عليكِ وعلى التئام الجرح ونحكي بموضوع وسائل المباعدة إذا حابة.\nحابة نحجزلك موعد؟",
        },
      },
    ],
  },
];

const pediatrics: Recipe[] = [
  {
    key: "peds_vaccine_recall",
    name: "Next vaccination due",
    name_ar: "موعد المطعوم القادم",
    description: "Two months after the last visit, which is the usual spacing on the schedule.",
    specialty: "pediatrics",
    trigger_type: "after_last_visit",
    trigger_config: { days: 60 },
    sort: 32,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً 👋\nصار وقت المطعوم القادم لـ{{patient.first_name}} في {{clinic.name}}.\nأحضروا معكم دفتر المطاعيم. حابين نحجزلكم موعد؟",
        },
      },
    ],
  },
  {
    key: "peds_visit_checkin",
    name: "How is your child today?",
    name_ar: "اطمئنان بعد الزيارة",
    description: "A day after the visit — the message that catches a fever that did not settle.",
    specialty: "pediatrics",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 33,
    steps: [
      { step_type: "wait", config: { minutes: 1440, until_time: "11:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً 🌸\nكيف حال {{patient.first_name}} اليوم؟\nإذا الحرارة ما نزلت، أو صار خمول أو رفض شرب، راسلونا فوراً ولا تنتظروا الموعد.",
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
    description: "Wound, weight-bearing and the warning signs, sent when the patient is tagged.",
    specialty: "orthopedics",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 34,
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
    description: "Two days after a visit, when the enthusiasm has usually worn off.",
    specialty: "orthopedics",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 35,
    steps: [
      { step_type: "wait", config: { minutes: 2880, until_time: "17:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nتذكير بسيط: التمارين اللي وصفناها لك بتفرق أكتر من أي شي ثاني بسرعة تحسّنك.\nإذا في تمرين بيوجعك أو مش متأكد من طريقته، راسلنا.",
        },
      },
    ],
  },
  {
    key: "ortho_cast_removal",
    name: "Cast removal due",
    name_ar: "موعد فك الجبيرة",
    description: "Three weeks after the cast tag, with a task for reception so nobody is forgotten.",
    specialty: "orthopedics",
    trigger_type: "tag_added",
    trigger_config: { tag: "جبيرة" },
    sort: 36,
    steps: [
      { step_type: "wait", config: { minutes: 30240, until_time: "10:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nتقريباً صار وقت مراجعة الجبيرة في {{clinic.name}}.\nراسلنا وبنحجزلك موعد للتصوير والفحص قبل الفك.",
        },
      },
      {
        step_type: "create_task",
        config: {
          title: "متابعة جبيرة: {{patient.name}}",
          body: "مرّت ثلاثة أسابيع على التجبير. تأكد من حجز موعد التصوير والمراجعة.",
          due_in_minutes: 1440,
        },
      },
    ],
  },
];

const physiotherapy: Recipe[] = [
  {
    key: "physio_home_program",
    name: "Your home programme",
    name_ar: "برنامج تمارين البيت",
    description: "Sent right after a session, while it is still fresh.",
    specialty: "physiotherapy",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 37,
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
    name: "Two weeks without a session",
    name_ar: "انقطاع عن الجلسات",
    description: "Catches a course of treatment before it quietly ends halfway.",
    specialty: "physiotherapy",
    trigger_type: "after_last_visit",
    trigger_config: { days: 14 },
    sort: 38,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nصار أسبوعين على آخر جلسة لك في {{clinic.name}}.\nالانقطاع بمنتصف البرنامج بيرجّع التحسّن للوراء. حاب نكمّل؟ راسلنا وبنرتبلك موعد.",
        },
      },
      {
        step_type: "create_task",
        config: {
          title: "متابعة انقطاع: {{patient.name}}",
          body: "أسبوعان بدون جلسة. اتصل للاطمئنان وإعادة الجدولة.",
          due_in_minutes: 2880,
        },
      },
    ],
  },
];

const ent: Recipe[] = [
  {
    key: "ent_post_op_care",
    name: "After ENT surgery",
    name_ar: "تعليمات بعد عملية الأنف والأذن",
    description: "The first week, sent when the patient is tagged post-op.",
    specialty: "ent",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 39,
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
  {
    key: "ent_seasonal_recall",
    name: "Before allergy season",
    name_ar: "مراجعة قبل موسم الحساسية",
    description: "Six months on from the last visit, which lands ahead of the next season.",
    specialty: "ent",
    trigger_type: "after_last_visit",
    trigger_config: { days: 180 },
    sort: 40,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nقرب موسم الحساسية، والمراجعة قبل ما تبدأ الأعراض بتوفّر عليك أسابيع تعب.\nحاب نحجزلك موعد في {{clinic.name}}؟",
        },
      },
    ],
  },
];

const cardiology: Recipe[] = [
  {
    key: "cardio_fasting_prep",
    name: "Fasting before your tests",
    name_ar: "الصيام قبل التحاليل",
    description: "A day ahead: what to fast from, and what not to stop.",
    specialty: "cardiology",
    trigger_type: "before_appointment",
    trigger_config: { hours: 24 },
    sort: 41,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "تذكير بموعدك غداً في {{clinic.name}} 🕐 {{appointment.time}}\n• صائم ٨–١٢ ساعة إذا كان في تحاليل دهون أو سكر (الماء مسموح)\n• لا توقف أدوية القلب أو الضغط إلا إذا الطبيب قال غير هيك\n• أحضر معك قائمة أدويتك وآخر تقاريرك\n• البس ملابس مريحة وحذاء رياضي إذا في فحص جهد",
        },
      },
    ],
  },
  {
    key: "cardio_medication_review",
    name: "Three-month review",
    name_ar: "مراجعة الأدوية والضغط",
    description: "The quarterly check that keeps a chronic patient on the books.",
    specialty: "cardiology",
    trigger_type: "after_last_visit",
    trigger_config: { days: 90 },
    sort: 42,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمرّت ثلاثة أشهر على آخر مراجعة لك في {{clinic.name}}.\nوقت مراجعة الأدوية وقياس الضغط والاطمئنان على التحاليل. حاب نحجزلك موعد؟",
        },
      },
    ],
  },
  {
    key: "cardio_results_ready",
    name: "Results are ready",
    name_ar: "النتائج جاهزة",
    description: "Tag the file and the patient hears about it the same minute.",
    specialty: "cardiology",
    trigger_type: "tag_added",
    trigger_config: { tag: "نتائج جاهزة" },
    sort: 43,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nنتائج فحوصاتك وصلت إلى {{clinic.name}}.\nراسلنا لنحجزلك موعد لمراجعتها مع الطبيب.",
        },
      },
    ],
  },
];

const nutrition: Recipe[] = [
  {
    key: "nutrition_weekly_checkin",
    name: "Weekly check-in",
    name_ar: "متابعة أسبوعية",
    description: "A week after a consultation — the point where most plans are abandoned.",
    specialty: "nutrition",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "completed" },
    sort: 44,
    steps: [
      { step_type: "wait", config: { minutes: 10080, until_time: "10:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🌟\nكيف ماشي معك البرنامج هذا الأسبوع؟\nإذا في صنف صعب عليك أو موعد وجبة مش مناسب لدوامك، راسلنا وبنعدّله — البرنامج اللي بينفّذ أهم من البرنامج المثالي.",
        },
      },
    ],
  },
  {
    key: "nutrition_followup_recall",
    name: "Next weigh-in due",
    name_ar: "موعد القياس القادم",
    description: "Two weeks after the last visit.",
    specialty: "nutrition",
    trigger_type: "after_last_visit",
    trigger_config: { days: 14 },
    sort: 45,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nصار وقت موعد القياس والمتابعة في {{clinic.name}}.\nحاب نحجزلك هذا الأسبوع؟",
        },
      },
    ],
  },
];

const psychiatry: Recipe[] = [
  {
    key: "psych_discreet_reminder",
    name: "Discreet appointment reminder",
    name_ar: "تذكير متحفّظ بالموعد",
    description: "Names no clinic and no service — a reminder that is safe on a shared phone.",
    specialty: "psychiatry",
    trigger_type: "before_appointment",
    trigger_config: { hours: 24 },
    sort: 46,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          /*
            Deliberately says almost nothing. A reminder that names a psychiatry
            clinic can appear on a lock screen in front of somebody else, and
            that is a disclosure the patient never agreed to. The time is what
            they need; the rest they already know.
          */
          message:
            "مرحباً {{patient.first_name}}، تذكير بموعدك غداً الساعة {{appointment.time}}.\nإذا احتجت تعديل الموعد راسلنا هنا.",
        },
      },
    ],
  },
  {
    key: "psych_missed_session_care",
    name: "A missed session, handled gently",
    name_ar: "متابعة جلسة فائتة",
    description: "Reaches out without pressure, and puts it in front of a person the same day.",
    specialty: "psychiatry",
    trigger_type: "appointment_status_changed",
    trigger_config: { status: "no_show" },
    sort: 47,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 🌸\nما شفناك اليوم، ونحنا موجودين وقت ما تكون جاهز.\nإذا حاب نأجّل أو نغيّر وقت الجلسة، راسلنا وبنرتبها بدون أي ضغط.",
        },
      },
      {
        step_type: "create_task",
        config: {
          title: "متابعة جلسة فائتة: {{patient.name}}",
          body: "لم يحضر الجلسة. تواصل شخصي خفيف خلال ٢٤ ساعة.",
          due_in_minutes: 1440,
        },
      },
    ],
  },
  {
    key: "psych_followup_recall",
    name: "Three weeks since the last session",
    name_ar: "متابعة بعد ثلاثة أسابيع",
    description: "A quiet door left open for someone who stopped coming.",
    specialty: "psychiatry",
    trigger_type: "after_last_visit",
    trigger_config: { days: 21 },
    sort: 48,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمرّت فترة على آخر جلسة، وحبينا نطمّن عليك.\nإذا حاب نكمّل، راسلنا وبنرتبلك موعد. وإذا حاب تاخد وقتك، هذا كمان تمام.",
        },
      },
    ],
  },
];

const plasticSurgery: Recipe[] = [
  {
    key: "plastic_pre_op_instructions",
    name: "Two days before surgery",
    name_ar: "تعليمات ما قبل العملية",
    description: "Fasting, blood thinners, smoking, and who is driving you home.",
    specialty: "plastic_surgery",
    trigger_type: "before_appointment",
    trigger_config: { hours: 48 },
    sort: 49,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "تذكير بموعد عمليتك في {{clinic.name}} 🗓 {{appointment.date}} — {{appointment.time}}\nقبل العملية:\n• صيام تام ٨ ساعات (بما فيها الماء)\n• أوقف الأسبرين ومميعات الدم والمكمّلات حسب تعليمات الطبيب\n• لا تدخين قبل أسبوع على الأقل\n• تعال بدون مكياج ولا مجوهرات، والبس ملابس واسعة تفتح من الأمام\n• رتّب شخص يوصّلك ويرجّعك ويبقى معك أول ليلة",
        },
      },
    ],
  },
  {
    key: "plastic_post_op_day1",
    name: "Day one after surgery",
    name_ar: "اليوم الأول بعد العملية",
    description: "A check-in a day after the post-op tag goes on the file.",
    specialty: "plastic_surgery",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 50,
    steps: [
      { step_type: "wait", config: { minutes: 1440, until_time: "11:00" } },
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
    name: "One week after surgery",
    name_ar: "مراجعة بعد أسبوع",
    description: "Brings the patient back in for the first proper look at the result.",
    specialty: "plastic_surgery",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 51,
    steps: [
      { step_type: "wait", config: { minutes: 10080, until_time: "10:00" } },
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nصار وقت مراجعة الأسبوع الأول في {{clinic.name}} — بنطمّن على الجرح ونشيل الغرز إذا لزم.\nحاب نحجزلك موعد؟",
        },
      },
      {
        step_type: "create_task",
        config: {
          title: "مراجعة أسبوع بعد العملية: {{patient.name}}",
          body: "تأكد من حجز موعد المراجعة وتصوير النتيجة.",
          due_in_minutes: 1440,
        },
      },
    ],
  },
];

const urology: Recipe[] = [
  {
    key: "uro_scan_prep",
    name: "Full bladder for your scan",
    name_ar: "تحضير ما قبل السونار",
    description: "Sent half a day ahead, which is when it is actually actionable.",
    specialty: "urology",
    trigger_type: "before_appointment",
    trigger_config: { hours: 12 },
    sort: 52,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "تذكير بموعدك في {{clinic.name}} 🕐 {{appointment.time}}\nإذا كان الموعد يتضمن سونار:\n• اشرب ٤ أكواب ماء قبل الموعد بساعة ولا تفرّغ المثانة\n• أحضر معك تقارير وتحاليل الفحوصات السابقة",
        },
      },
    ],
  },
  {
    key: "uro_post_op_care",
    name: "After a urological procedure",
    name_ar: "تعليمات بعد العملية",
    description: "Fluids, lifting and the warning signs.",
    specialty: "urology",
    trigger_type: "tag_added",
    trigger_config: { tag: "عملية" },
    sort: 53,
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
    name: "Fasting before your labs",
    name_ar: "الصيام قبل التحاليل",
    description: "A day ahead, with the reminder not to stop chronic medication.",
    specialty: "internal_medicine",
    trigger_type: "before_appointment",
    trigger_config: { hours: 24 },
    sort: 54,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "تذكير بموعدك غداً في {{clinic.name}} 🕐 {{appointment.time}}\n• صائم ٨–١٢ ساعة إذا كان في تحاليل (الماء مسموح)\n• لا توقف أدويتك المزمنة إلا إذا الطبيب قال غير هيك\n• أحضر معك قائمة أدويتك وآخر تقاريرك",
        },
      },
    ],
  },
  {
    key: "internal_chronic_recall",
    name: "Chronic follow-up due",
    name_ar: "متابعة الأمراض المزمنة",
    description: "Three months on — the interval that keeps a diabetic or hypertensive patient reviewed.",
    specialty: "internal_medicine",
    trigger_type: "after_last_visit",
    trigger_config: { days: 90 },
    sort: 55,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nمرّت ثلاثة أشهر على آخر مراجعة لك في {{clinic.name}}.\nوقت مراجعة الأدوية والتحاليل الدورية. حاب نحجزلك موعد؟",
        },
      },
    ],
  },
  {
    key: "internal_results_ready",
    name: "Results are ready",
    name_ar: "النتائج جاهزة",
    description: "Tag the file and the patient hears about it the same minute.",
    specialty: "internal_medicine",
    trigger_type: "tag_added",
    trigger_config: { tag: "نتائج جاهزة" },
    sort: 56,
    steps: [
      {
        step_type: "send_whatsapp",
        config: {
          message:
            "مرحباً {{patient.first_name}} 👋\nنتائج فحوصاتك وصلت إلى {{clinic.name}}.\nراسلنا لنحجزلك موعد لمراجعتها مع الطبيب.",
        },
      },
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
