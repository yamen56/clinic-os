/**
 * Seed: agency super admin + a realistic demo clinic (Arabic data) for
 * development and sales demos. Idempotent — safe to run repeatedly.
 */
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { seedAgencyDefaults } from "./seed-recipes";

const PG_PORT = Number(process.env.PG_PORT || 5544);
const url = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/clinicos`;

export const SEED = {
  adminEmail: "admin@makan.agency",
  adminPassword: "admin1234",
  ownerEmail: "rima@clinic.jo",
  doctorEmail: "dr.omar@clinic.jo",
  doctor2Email: "dr.lina@clinic.jo",
  receptionEmail: "reception@clinic.jo",
  password: "clinic1234",
  clinicSlug: "rima-dental",
};

const FIRST_M = ["أحمد", "محمد", "عمر", "خالد", "يوسف", "زيد", "سامي", "طارق", "مراد", "بشار", "رامي", "فادي"];
const FIRST_F = ["رنا", "ليلى", "سارة", "هبة", "دانا", "منى", "ريم", "لمى", "نور", "سلمى", "ديمة", "جنى"];
const LAST = ["العمري", "الخطيب", "حداد", "الزعبي", "النجار", "الشريف", "أبو غزالة", "المصري", "الرواشدة", "بني هاني", "السعدي", "الطراونة"];

function pick<T>(a: T[], i: number): T {
  return a[i % a.length];
}

async function main() {
  const c = new Client({ connectionString: url });
  await c.connect();

  const hash = (pw: string) => bcrypt.hashSync(pw, 10);

  async function upsertUser(
    email: string,
    password: string,
    name: string,
    opts: { superAdmin?: boolean; locale?: string; phone?: string } = {}
  ) {
    const r = await c.query(
      `insert into users (email, password_hash, full_name, is_super_admin, locale, phone_e164)
       values ($1, $2, $3, $4, $5, $6)
       on conflict ((lower(email))) do update set full_name = excluded.full_name
       returning id`,
      [email, hash(password), name, opts.superAdmin ?? false, opts.locale ?? "ar", opts.phone ?? null]
    );
    return r.rows[0].id as string;
  }

  // ---- Agency defaults + super admin
  await seedAgencyDefaults(c);
  const adminId = await upsertUser(SEED.adminEmail, SEED.adminPassword, "Makan Admin", {
    superAdmin: true,
    locale: "en",
  });

  // ---- Demo clinic (recreated fresh each run so demos are predictable)
  await c.query(`delete from clinics where slug = $1`, [SEED.clinicSlug]);
  const clinic = (
    await c.query(
      `insert into clinics (name, name_ar, slug, phone_e164, address, address_ar, google_maps_url,
                            brand_color, invoice_prefix, invoice_tax_rate, invoice_tax_label,
                            payment_instructions, invoice_footer, subscription_status, plan, plan_price)
       values ('Rima Dental Center', 'مركز ريما لطب الأسنان', $1, '+96264616161',
               'Amman, 7th Circle, Zahran St. 42', 'عمان، الدوار السابع، شارع زهران ٤٢',
               'https://maps.google.com/?q=31.9539,35.8656',
               '#0f6e5c', 'RIMA', 16, 'ضريبة المبيعات',
               'الدفع نقداً في العيادة، أو عبر كليك: RIMADENTAL',
               'شكراً لثقتكم بمركز ريما لطب الأسنان', 'active', 'standard', 149)
       returning id, timezone`,
      [SEED.clinicSlug]
    )
  ).rows[0];
  const clinicId = clinic.id as string;
  const tz = clinic.timezone as string;

  await c.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinicId]);
  await c.query(
    `insert into ai_agents (clinic_id, enabled, agent_name, instructions, language_mode, hours_mode, escalation_notes)
     values ($1, false, 'سارة',
       'كوني ودودة ومختصرة. استخدمي اسم المريض الأول. لا تكتبي رسائل طويلة.',
       'match', 'after_hours',
       'حوّلي أي سؤال عن نتائج علاج أو ألم شديد إلى الطبيب مباشرة.')`,
    [clinicId]
  );

  // ---- Staff
  const ownerId = await upsertUser(SEED.ownerEmail, SEED.password, "ريما العمري", { phone: "+962790000001" });
  const doc1Id = await upsertUser(SEED.doctorEmail, SEED.password, "د. عمر الخطيب", { phone: "+962790000002" });
  const doc2Id = await upsertUser(SEED.doctor2Email, SEED.password, "د. لينا حداد", { phone: "+962790000003" });
  const recId = await upsertUser(SEED.receptionEmail, SEED.password, "هبة النجار", { phone: "+962790000004" });

  const mkMember = async (userId: string, role: string, extra: Record<string, unknown> = {}) => {
    const r = await c.query(
      `insert into clinic_members (clinic_id, user_id, role, title, specialty, color, reminder_minutes)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        clinicId, userId, role,
        (extra.title as string) ?? null,
        (extra.specialty as string) ?? null,
        (extra.color as string) ?? "#0f6e5c",
        (extra.reminder as number) ?? 30,
      ]
    );
    return r.rows[0].id as string;
  };

  await mkMember(ownerId, "owner");
  const m1 = await mkMember(doc1Id, "doctor", { title: "د.", specialty: "تقويم الأسنان", color: "#6d28d9" });
  const m2 = await mkMember(doc2Id, "doctor", { title: "د.", specialty: "طب أسنان الأطفال", color: "#b45309" });
  await mkMember(recId, "receptionist", { color: "#26866d" });

  // ---- Services
  const services: { id: string; name: string; dur: number; price: number }[] = [];
  const svcDefs = [
    ["Consultation", "كشفية", 20, 15, "#0f6e5c"],
    ["Cleaning & Polish", "تنظيف وتلميع", 45, 35, "#26866d"],
    ["Filling", "حشوة", 45, 40, "#6d28d9"],
    ["Root Canal", "علاج عصب", 90, 180, "#b45309"],
    ["Extraction", "خلع", 30, 45, "#b91c1c"],
    ["Teeth Whitening", "تبييض الأسنان", 60, 220, "#4aa389"],
    ["Orthodontic Follow-up", "مراجعة تقويم", 20, 25, "#365314"],
  ] as const;
  for (const [name, nameAr, dur, price, color] of svcDefs) {
    const r = await c.query(
      `insert into services (clinic_id, name, name_ar, duration_min, price, color, sort)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [clinicId, name, nameAr, dur, price, color, services.length]
    );
    services.push({ id: r.rows[0].id, name, dur, price });
  }
  for (const s of services) {
    await c.query(
      `insert into service_doctors (service_id, member_id, clinic_id) values ($1, $2, $3), ($1, $4, $3)`,
      [s.id, m1, clinicId, m2]
    );
  }

  // ---- Custom patient fields
  await c.query(
    `insert into custom_field_defs (clinic_id, key, label, label_ar, field_type, options, sort) values
      ($1, 'insurance', 'Insurance', 'شركة التأمين', 'select', $2, 1),
      ($1, 'allergies', 'Allergies', 'الحساسية', 'text', '[]', 2),
      ($1, 'referred_by', 'Referred by', 'من حوّله', 'text', '[]', 3)`,
    [clinicId, JSON.stringify(["بدون", "الأردنية للتأمين", "ميدغلف", "الشرق العربي"])]
  );

  await c.query(`insert into booking_links (clinic_id, slug, name) values ($1, $2, 'الرابط العام')`, [
    clinicId, SEED.clinicSlug,
  ]);

  await c.query(
    `insert into quick_replies (clinic_id, title, body, sort) values
      ($1, 'ترحيب', 'أهلاً وسهلاً فيك في مركز ريما لطب الأسنان! كيف بقدر أساعدك؟', 1),
      ($1, 'العنوان', 'عنواننا: عمان، الدوار السابع، شارع زهران ٤٢. الموقع على الخريطة: https://maps.google.com/?q=31.9539,35.8656', 2),
      ($1, 'ساعات العمل', 'دوامنا من الأحد للخميس ٩ صباحاً - ٥ مساءً، والسبت ١٠ - ٤. الجمعة عطلة.', 3)`,
    [clinicId]
  );

  // ---- Knowledge base (filled in, so the AI demo works)
  const knowledge: [string, string, string][] = [
    ["services_prices", "الخدمات والأسعار", "الكشفية ١٥ ديناراً، التنظيف والتلميع ٣٥، الحشوة ٤٠، علاج العصب ١٨٠، الخلع ٤٥، التبييض ٢٢٠، مراجعة التقويم ٢٥."],
    ["doctors", "الأطباء والتخصصات", "د. عمر الخطيب — تقويم الأسنان. د. لينا حداد — طب أسنان الأطفال."],
    ["hours", "ساعات العمل", "الأحد إلى الخميس ٩ صباحاً حتى ٥ مساءً، السبت ١٠ صباحاً حتى ٤ مساءً، الجمعة مغلق."],
    ["location", "الموقع والوصول", "عمان، الدوار السابع، شارع زهران ٤٢، مقابل بنك الإسكان. يوجد موقف سيارات مجاني."],
    ["insurance", "شركات التأمين المقبولة", "نقبل الأردنية للتأمين وميدغلف والشرق العربي. التأمين يغطي الكشفية والتنظيف."],
    ["preparation", "تعليمات ما قبل الزيارة", "لا حاجة لصيام. لعلاج العصب يُفضل تناول وجبة خفيفة قبل الموعد. أحضر بطاقة التأمين إن وجدت."],
    ["faq", "أسئلة شائعة", "الحجز المسبق ضروري. التأخر أكثر من ١٥ دقيقة قد يتطلب إعادة جدولة الموعد. نستقبل الأطفال من عمر ٣ سنوات."],
  ];
  for (const [cat, title, content] of knowledge) {
    await c.query(
      `insert into ai_knowledge_items (clinic_id, category, title, content, sort)
       values ($1, $2, $3, $4, (select coalesce(max(sort),0)+1 from ai_knowledge_items where clinic_id = $1))`,
      [clinicId, cat, title, content]
    );
  }

  // ---- Automation recipes copied in (two enabled for the demo)
  const recipes = await c.query(`select * from recipe_templates where active order by sort`);
  for (const r of recipes.rows) {
    const enable = r.key === "confirm_on_booking" || r.key === "reminder_24h";
    const a = await c.query(
      `insert into automations (clinic_id, name, description, trigger_type, trigger_config, active, recipe_key)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [clinicId, r.name_ar || r.name, r.description, r.trigger_type, r.trigger_config, enable, r.key]
    );
    const writeSteps = async (
      steps: { step_type: string; config?: Record<string, unknown>; children?: { yes?: unknown[]; no?: unknown[] } }[],
      parentId: string | null,
      branch: string | null
    ) => {
      let sort = 0;
      for (const st of steps) {
        const s = await c.query(
          `insert into automation_steps (clinic_id, automation_id, parent_step_id, branch, sort, step_type, config)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [clinicId, a.rows[0].id, parentId, branch, sort++, st.step_type, JSON.stringify(st.config ?? {})]
        );
        if (st.children?.yes?.length) await writeSteps(st.children.yes as never[], s.rows[0].id, "yes");
        if (st.children?.no?.length) await writeSteps(st.children.no as never[], s.rows[0].id, "no");
      }
    };
    await writeSteps(Array.isArray(r.steps) ? r.steps : [], null, null);
  }

  // ---- Patients
  const now = DateTime.now().setZone(tz);
  const patientIds: string[] = [];
  const tagPool = [["vip"], ["تقويم"], ["أطفال"], [], ["تأمين"], ["vip", "تقويم"], []];
  for (let i = 0; i < 28; i++) {
    const female = i % 2 === 0;
    const name = `${female ? pick(FIRST_F, i) : pick(FIRST_M, i)} ${pick(LAST, i * 3 + 1)}`;
    const phone = `+9627${(90000000 + i * 137711).toString().slice(0, 8)}`;
    const lastVisit =
      i % 4 === 0 ? null : now.minus({ days: 10 + i * 11 }).toUTC().toISO();
    const r = await c.query(
      `insert into patients (clinic_id, full_name, phone_e164, birth_date, gender, tags, source, status,
                             notes_summary, custom_fields, last_visit_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        clinicId, name, phone,
        now.minus({ years: 20 + (i % 45), days: i * 9 }).toISODate(),
        female ? "female" : "male",
        pick(tagPool, i),
        ["staff", "booking_link", "whatsapp", "ai_agent"][i % 4],
        i % 9 === 0 ? "lead" : "active",
        i % 5 === 0 ? "يفضّل المواعيد الصباحية." : "",
        JSON.stringify(
          i % 3 === 0
            ? { insurance: "الأردنية للتأمين", allergies: i % 6 === 0 ? "بنسلين" : "" }
            : { insurance: "بدون" }
        ),
        lastVisit,
      ]
    );
    patientIds.push(r.rows[0].id);
  }

  // Patient notes
  for (let i = 0; i < 12; i++) {
    await c.query(
      `insert into patient_notes (clinic_id, patient_id, author_id, kind, body, created_at)
       values ($1, $2, $3, $4, $5, now() - ($6::text || ' days')::interval)`,
      [
        clinicId, patientIds[i], i % 2 ? doc1Id : doc2Id,
        i % 3 === 0 ? "admin" : "clinical",
        i % 3 === 0
          ? "اتصلنا لتأكيد الموعد، لم يرد. سنعيد المحاولة."
          : "فحص دوري. لا توجد تسوسات جديدة. يُنصح بالتنظيف كل ٦ أشهر.",
        String(i * 4 + 2),
      ]
    );
  }

  // ---- Appointments: last 3 weeks + next 2 weeks
  const statuses = ["completed", "completed", "completed", "no_show", "cancelled"];
  let apptCount = 0;
  for (let d = -21; d <= 14; d++) {
    const day = now.plus({ days: d }).startOf("day");
    if (day.weekday === 5) continue; // Friday closed
    const perDay = day < now ? 3 + (Math.abs(d) % 3) : 2 + (d % 4);
    for (let k = 0; k < perDay; k++) {
      const hour = 9 + ((k * 2 + Math.abs(d)) % 7);
      const start = day.set({ hour, minute: (k % 2) * 30 });
      if (start < now.minus({ days: 21 })) continue;
      const svc = services[(k + Math.abs(d)) % services.length];
      const end = start.plus({ minutes: svc.dur });
      const past = start < now;
      const status = past
        ? statuses[(k + Math.abs(d)) % statuses.length]
        : k % 3 === 0
          ? "confirmed"
          : "scheduled";
      await c.query(
        `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          clinicId,
          patientIds[(k * 5 + Math.abs(d) * 3) % patientIds.length],
          k % 2 ? m1 : m2,
          svc.id,
          start.toUTC().toISO(),
          end.toUTC().toISO(),
          status,
          ["staff", "booking_link", "ai_agent"][(k + Math.abs(d)) % 3],
        ]
      );
      apptCount++;
    }
  }

  // ---- Invoices + payments for completed visits
  const completed = await c.query(
    `select a.id, a.patient_id, a.service_id, a.starts_at, s.name, s.name_ar, s.price
     from appointments a join services s on s.id = a.service_id
     where a.clinic_id = $1 and a.status = 'completed' order by a.starts_at`,
    [clinicId]
  );
  let seq = 0;
  for (const [i, ap] of completed.rows.entries()) {
    seq++;
    const year = DateTime.fromJSDate(new Date(ap.starts_at)).setZone(tz).year;
    const number = `RIMA-${year}-${String(seq).padStart(4, "0")}`;
    const price = Number(ap.price);
    const discount = i % 7 === 0 ? 5 : 0;
    const taxRate = 0;
    const subtotal = price;
    const total = subtotal - discount;
    const status = i % 6 === 0 ? "sent" : i % 11 === 0 ? "partially_paid" : "paid";
    const paid = status === "paid" ? total : status === "partially_paid" ? Math.round(total / 2) : 0;

    const inv = await c.query(
      `insert into invoices (clinic_id, patient_id, appointment_id, seq, number, status, subtotal,
                             discount_amount, tax_rate, tax_amount, total, amount_paid, sent_at, created_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $12, $13) returning id`,
      [
        clinicId, ap.patient_id, ap.id, seq, number, status, subtotal, discount, taxRate,
        total, paid, ap.starts_at, ownerId,
      ]
    );
    await c.query(
      `insert into invoice_items (clinic_id, invoice_id, service_id, description, qty, unit_price, amount, sort)
       values ($1, $2, $3, $4, 1, $5, $5, 0)`,
      [clinicId, inv.rows[0].id, ap.service_id, ap.name_ar || ap.name, price]
    );
    if (paid > 0) {
      await c.query(
        `insert into payments (clinic_id, invoice_id, patient_id, amount, method, paid_at, recorded_by)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          clinicId, inv.rows[0].id, ap.patient_id, paid,
          ["cash", "cliq", "card", "transfer"][i % 4], ap.starts_at, recId,
        ]
      );
    }
  }
  await c.query(`update clinics set invoice_counter = $2 where id = $1`, [clinicId, seq]);

  // ---- Conversations with realistic WhatsApp threads
  const threads: [number, { dir: "in" | "out"; kind: string; body: string }[]][] = [
    [0, [
      { dir: "in", kind: "patient", body: "مرحبا، بدي أحجز موعد تنظيف أسنان" },
      { dir: "out", kind: "staff", body: "أهلاً وسهلاً! متوفر عندنا يوم الأحد ١١ صباحاً أو الاثنين ٢ ظهراً. أي وقت يناسبك؟" },
      { dir: "in", kind: "patient", body: "الأحد ١١ تمام" },
      { dir: "out", kind: "automation", body: "تم تأكيد موعدك في مركز ريما لطب الأسنان 🦷\n📅 الأحد\n🕐 ١١:٠٠ ص\nتنظيف وتلميع" },
    ]],
    [1, [
      { dir: "in", kind: "patient", body: "كم سعر التبييض؟" },
      { dir: "out", kind: "ai", body: "سعر تبييض الأسنان ٢٢٠ ديناراً، والجلسة بتاخذ حوالي ساعة. بتحب أحجزلك موعد؟" },
      { dir: "in", kind: "patient", body: "طيب خليني أفكر، شكراً" },
    ]],
    [2, [
      { dir: "in", kind: "patient", body: "عندي ألم شديد بالضرس ومش قادر أنام" },
      { dir: "out", kind: "ai", body: "أنا آسفة لسماع هيك 😔 رح أحوّل رسالتك لفريق العيادة حالاً عشان يتواصلوا معك بأسرع وقت." },
      { dir: "out", kind: "staff", body: "أهلاً، معك هبة من العيادة. بنقدر نستقبلك اليوم الساعة ٤. بتقدر تجي؟" },
    ]],
    [3, [
      { dir: "out", kind: "automation", body: "تذكير بموعدك غداً في مركز ريما لطب الأسنان 🦷\n🕐 ١٠:٣٠ ص\nمراجعة تقويم" },
      { dir: "in", kind: "patient", body: "تمام، بكون موجود" },
    ]],
    [4, [
      { dir: "in", kind: "patient", body: "بتقبلوا تأمين ميدغلف؟" },
      { dir: "out", kind: "staff", body: "نعم بنقبل ميدغلف. التأمين بيغطي الكشفية والتنظيف. احضر بطاقة التأمين معك." },
    ]],
  ];

  for (const [pi, msgs] of threads) {
    const conv = await c.query(
      `insert into conversations (clinic_id, patient_id, phone_e164, ai_enabled, unread_count,
                                  last_message_at, last_message_preview, last_message_direction, flagged, flag_reason)
       select $1, p.id, p.phone_e164, $3, $4, now() - ($5::text || ' hours')::interval, $6, $7, $8, $9
       from patients p where p.id = $2 returning id`,
      [
        clinicId, patientIds[pi], pi !== 2, pi === 0 || pi === 4 ? 1 : 0,
        String(pi * 5 + 1), msgs[msgs.length - 1].body.slice(0, 120),
        msgs[msgs.length - 1].dir,
        pi === 2, pi === 2 ? "🚨 عاجل: المريض يشكو من ألم شديد" : null,
      ]
    );
    for (const [mi, m] of msgs.entries()) {
      await c.query(
        `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body, status, sent_at, created_at)
         values ($1, $2, $3, $4, 'text', $5, $6, $7, $7)`,
        [
          clinicId, conv.rows[0].id, m.dir, m.kind, m.body,
          m.dir === "in" ? "delivered" : "sent",
          now.minus({ hours: pi * 5 + (msgs.length - mi) }).toUTC().toISO(),
        ]
      );
    }
  }

  // ---- A couple of notifications so the center isn't empty
  await c.query(
    `insert into notifications (clinic_id, user_id, kind, title, body, url, push_sent) values
      ($1, $2, 'booking', 'حجز جديد من الرابط العام', 'تنظيف وتلميع · غداً ١١:٠٠ ص', $3, true),
      ($1, $2, 'ai_escalation', 'المساعد الذكي يحتاج تدخلك', 'المريض يشكو من ألم شديد', $4, true)`,
    [clinicId, ownerId, `/c/${SEED.clinicSlug}/calendar`, `/c/${SEED.clinicSlug}/conversations`]
  );

  await c.query(
    `insert into audit_log (clinic_id, user_id, action, entity, entity_id, detail)
     values ($1, $2, 'seed.demo', 'clinic', $3, '{"source":"seed"}')`,
    [clinicId, adminId, clinicId]
  );

  const counts = (
    await c.query(
      `select
        (select count(*) from patients where clinic_id = $1)::int as patients,
        (select count(*) from appointments where clinic_id = $1)::int as appointments,
        (select count(*) from invoices where clinic_id = $1)::int as invoices,
        (select count(*) from payments where clinic_id = $1)::int as payments,
        (select count(*) from conversations where clinic_id = $1)::int as conversations,
        (select count(*) from messages where clinic_id = $1)::int as messages,
        (select count(*) from automations where clinic_id = $1)::int as automations`,
      [clinicId]
    )
  ).rows[0];

  await c.end();

  console.log("\n  Demo data ready\n");
  console.log(`  Agency admin   ${SEED.adminEmail} / ${SEED.adminPassword}`);
  console.log(`  Clinic owner   ${SEED.ownerEmail} / ${SEED.password}`);
  console.log(`  Doctor         ${SEED.doctorEmail} / ${SEED.password}`);
  console.log(`  Receptionist   ${SEED.receptionEmail} / ${SEED.password}`);
  console.log(`\n  Workspace      /c/${SEED.clinicSlug}`);
  console.log(`  Booking page   /book/${SEED.clinicSlug}`);
  console.log(
    `\n  ${counts.patients} patients · ${counts.appointments} appointments · ${counts.invoices} invoices · ` +
      `${counts.payments} payments · ${counts.conversations} threads (${counts.messages} messages) · ${counts.automations} automations\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
