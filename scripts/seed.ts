/**
 * Seed: agency super admin + a realistic demo clinic (Arabic data) for
 * development and sales demos. Idempotent — safe to run repeatedly.
 */
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { DateTime } from "luxon";
import { seedAgencyDefaults } from "./seed-recipes";
import { seedStaffAlerts } from "../src/lib/staff-alerts";
import { ROLE_DEFAULTS, type MemberRole } from "../src/lib/permissions";

/*
  `--prod` reads the connection string out of the gitignored env file, the same
  way migrate-prod.ts and restore.ts do, so a production password never reaches
  a shell history or a process list. Without it this is local, which is the
  right default for a script whose first act is `delete from clinics`.
*/
if (process.argv.includes("--prod")) process.loadEnvFile(".env.production.local");

const PG_PORT = Number(process.env.PG_PORT || 5544);
/*
  Local by default. DATABASE_SUPER_URL points it at a hosted database, which is
  how the demo clinic gets built in production — the one prospective clinics are
  shown before they sign up.
*/
const url =
  process.env.DATABASE_SUPER_URL || `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/clinicos`;
const isRemote = !!process.env.DATABASE_SUPER_URL;

/*
  Against a real deployment only the demo clinic is built. The agency defaults
  and the super admin already exist there, and re-seeding them would overwrite
  the agency's own edits — seedAgencyDefaults clears knowledge_templates
  outright.
*/
const demoOnly = isRemote || process.argv.includes("--demo-only");

/**
 * Which clinic to build. `rima` is the original and its values are unchanged,
 * so the existing demo re-seeds exactly as before.
 *
 * A second profile exists because one demo cannot be two things at once. The
 * first is a clinic that has just opened — sparse, obviously new, which is the
 * right thing to show somebody deciding whether to start. A prospect asking
 * "what does this look like once you have been using it for a while" needs the
 * opposite: months of completed visits, invoices with a realistic mix of paid
 * and outstanding, patients who have been back three times. That is `bayan`.
 *
 *   DEMO_PROFILE=bayan DEMO_SLUG=demo2 npm run seed
 */
type Profile = {
  slug: string;
  name: string;
  nameAr: string;
  phone: string;
  address: string;
  addressAr: string;
  maps: string;
  brand: string;
  invoicePrefix: string;
  taxRate: number;
  payInstructions: string;
  footer: string;
  specialty: string;
  /** The AI receptionist's name, which patients see in the thread. */
  agentName: string;
  owner: { email: string; name: string; phone: string };
  doctors: { email: string; name: string; phone: string; specialty: string; color: string }[];
  reception: { email: string; name: string; phone: string };
  services: readonly (readonly [string, string, number, number, string])[];
  patients: number;
  /** How far back appointments reach. The difference between new and established. */
  historyDays: number;
  aheadDays: number;
  /** Generated inbox threads on top of the five hand-written ones. */
  extraThreads: number;
};

const RIMA_SERVICES = [
  ["Consultation", "كشفية", 20, 15, "#0b1220"],
  ["Cleaning & Polish", "تنظيف وتلميع", 45, 35, "#5bc6e3"],
  ["Filling", "حشوة", 45, 40, "#1e3a6b"],
  ["Root Canal", "علاج عصب", 90, 180, "#e4946b"],
  ["Extraction", "خلع", 30, 45, "#c24a4a"],
  ["Teeth Whitening", "تبييض الأسنان", 60, 220, "#8fa9c0"],
  ["Orthodontic Follow-up", "مراجعة تقويم", 20, 25, "#2a2d33"],
] as const;

const PROFILES: Record<string, Profile> = {
  rima: {
    slug: "rima-dental",
    name: "Rima Dental Center",
    nameAr: "مركز ريما لطب الأسنان",
    phone: "+96264616161",
    address: "Amman, 7th Circle, Zahran St. 42",
    addressAr: "عمان، الدوار السابع، شارع زهران ٤٢",
    maps: "https://maps.google.com/?q=31.9539,35.8656",
    brand: "#0b1220",
    invoicePrefix: "RIMA",
    taxRate: 16,
    payInstructions: "الدفع نقداً في العيادة، أو عبر كليك: RIMADENTAL",
    footer: "شكراً لثقتكم بمركز ريما لطب الأسنان",
    specialty: "dental",
    agentName: "سارة",
    owner: { email: "rima@clinic.jo", name: "ريما العمري", phone: "+962790000001" },
    doctors: [
      { email: "dr.omar@clinic.jo", name: "د. عمر الخطيب", phone: "+962790000002", specialty: "تقويم الأسنان", color: "#1e3a6b" },
      { email: "dr.lina@clinic.jo", name: "د. لينا حداد", phone: "+962790000003", specialty: "طب أسنان الأطفال", color: "#e4946b" },
    ],
    reception: { email: "reception@clinic.jo", name: "هبة النجار", phone: "+962790000004" },
    services: RIMA_SERVICES,
    patients: 28,
    historyDays: 21,
    aheadDays: 14,
    extraThreads: 0,
  },

  /*
    An established practice. Same product, a business three years in: more
    patients, eight months of visits behind it, and a fuller team — which is
    what makes the dashboard, the revenue chart and the patient histories say
    anything at all. A three-week-old clinic shows empty graphs, and an empty
    graph is not a demo of an analytics feature.
  */
  bayan: {
    slug: "bayan-dental",
    name: "Bayan Dental & Implant Center",
    nameAr: "مركز بيان لطب الأسنان والزراعة",
    phone: "+96265527700",
    address: "Amman, Abdoun, Al Sa'ada St. 18",
    addressAr: "عمان، عبدون، شارع السعادة ١٨",
    maps: "https://maps.google.com/?q=31.9391,35.8797",
    brand: "#14532d",
    invoicePrefix: "BAYAN",
    taxRate: 16,
    payInstructions: "الدفع نقداً أو بالبطاقة في العيادة، أو عبر كليك: BAYANDENTAL",
    footer: "شكراً لثقتكم بمركز بيان لطب الأسنان والزراعة",
    specialty: "dental",
    agentName: "ريم",
    owner: { email: "owner@bayan.jo", name: "د. سامر القيسي", phone: "+962791100001" },
    doctors: [
      { email: "dr.nadia@bayan.jo", name: "د. نادية الشريف", phone: "+962791100002", specialty: "زراعة الأسنان", color: "#14532d" },
      { email: "dr.tareq@bayan.jo", name: "د. طارق المصري", phone: "+962791100003", specialty: "تقويم الأسنان", color: "#b45309" },
      { email: "dr.huda@bayan.jo", name: "د. هدى الرواشدة", phone: "+962791100004", specialty: "طب أسنان الأطفال", color: "#0891b2" },
    ],
    reception: { email: "reception@bayan.jo", name: "لمى بني هاني", phone: "+962791100005" },
    services: [
      ["Consultation", "كشفية", 20, 20, "#14532d"],
      ["Cleaning & Polish", "تنظيف وتلميع", 45, 40, "#0891b2"],
      ["Filling", "حشوة", 45, 45, "#1e3a6b"],
      ["Root Canal", "علاج عصب", 90, 200, "#b45309"],
      ["Extraction", "خلع", 30, 50, "#c24a4a"],
      ["Dental Implant", "زراعة سن", 120, 650, "#166534"],
      ["Crown & Bridge", "تركيبات وتيجان", 75, 320, "#7c3aed"],
      ["Teeth Whitening", "تبييض الأسنان", 60, 240, "#8fa9c0"],
      ["Orthodontic Follow-up", "مراجعة تقويم", 20, 30, "#2a2d33"],
    ] as const,
    patients: 120,
    // Eight months. Long enough that the revenue chart, the recall list and a
    // patient's visit history all have something real in them.
    historyDays: 240,
    aheadDays: 21,
    // Enough that the inbox reads as eight months of use rather than a
    // demo with five example messages in it.
    extraThreads: 34,
  },
};

const PROFILE_KEY = process.env.DEMO_PROFILE || "rima";
const P = PROFILES[PROFILE_KEY];
if (!P) {
  console.error(`Unknown DEMO_PROFILE "${PROFILE_KEY}". Known: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(1);
}

/** Overridable, so a demo can be rebuilt without colliding with a live clinic. */
const SLUG = process.env.DEMO_SLUG || P.slug;

export const SEED = {
  adminEmail: "admin@makan.agency",
  adminPassword: "admin1234",
  ownerEmail: P.owner.email,
  doctorEmail: P.doctors[0].email,
  doctor2Email: P.doctors[1].email,
  receptionEmail: P.reception.email,
  password: "clinic1234",
  clinicSlug: SLUG,
};

const FIRST_M = ["أحمد", "محمد", "عمر", "خالد", "يوسف", "زيد", "سامي", "طارق", "مراد", "بشار", "رامي", "فادي"];
const FIRST_F = ["رنا", "ليلى", "سارة", "هبة", "دانا", "منى", "ريم", "لمى", "نور", "سلمى", "ديمة", "جنى"];
const LAST = ["العمري", "الخطيب", "حداد", "الزعبي", "النجار", "الشريف", "أبو غزالة", "المصري", "الرواشدة", "بني هاني", "السعدي", "الطراونة"];

function pick<T>(a: T[], i: number): T {
  return a[i % a.length];
}

async function main() {
  const c = new Client({
    connectionString: url,
    ssl: /@(localhost|127\.0\.0\.1)/.test(url) ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
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
  if (!demoOnly) await seedAgencyDefaults(c);
  /*
    The agency super admin is created for local development only. Against a
    real deployment this would mint an account with a published password and
    full access to every clinic — the demo is not worth that. There, the seed
    attributes its audit entry to whichever super admin already exists.
  */
  const adminId = demoOnly
    ? ((await c.query(`select id from users where is_super_admin order by created_at limit 1`))
        .rows[0]?.id as string | undefined) ?? null
    : await upsertUser(SEED.adminEmail, SEED.adminPassword, "Clinicti Admin", {
        superAdmin: true,
        locale: "en",
      });

  // ---- Demo clinic (recreated fresh each run so demos are predictable)
  await c.query(`delete from clinics where slug = $1`, [SLUG]);
  const clinic = (
    await c.query(
      `insert into clinics (name, name_ar, slug, phone_e164, address, address_ar, google_maps_url,
                            brand_color, invoice_prefix, invoice_tax_rate, invoice_tax_label,
                            payment_instructions, invoice_footer, subscription_status, plan, plan_price, specialty,
                            created_at)
       values ($2, $3, $1, $4, $5, $6, $7, $8, $9, $10, 'ضريبة المبيعات', $11, $12,
               'active', 'standard', 149, $13,
               -- Dated to just before its own history, so "customer since" and
               -- the admin list agree with the visits inside the workspace.
               now() - ($14::text || ' days')::interval)
       returning id, timezone`,
      [
        SLUG, P.name, P.nameAr, P.phone, P.address, P.addressAr, P.maps, P.brand,
        P.invoicePrefix, P.taxRate, P.payInstructions, P.footer, P.specialty,
        String(P.historyDays + 14),
      ]
    )
  ).rows[0];
  const clinicId = clinic.id as string;
  const tz = clinic.timezone as string;

  await c.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinicId]);
  await c.query(
    `insert into ai_agents (clinic_id, enabled, agent_name, instructions, language_mode, hours_mode, escalation_notes)
     values ($1, false, $2,
       'كوني ودودة ومختصرة. استخدمي اسم المريض الأول. لا تكتبي رسائل طويلة.',
       'match', 'after_hours',
       'حوّلي أي سؤال عن نتائج علاج أو ألم شديد إلى الطبيب مباشرة.')`,
    [clinicId, P.agentName]
  );

  // ---- Staff
  const ownerId = await upsertUser(P.owner.email, SEED.password, P.owner.name, { phone: P.owner.phone });
  const doctorIds: string[] = [];
  for (const d of P.doctors) {
    doctorIds.push(await upsertUser(d.email, SEED.password, d.name, { phone: d.phone }));
  }
  const doc1Id = doctorIds[0];
  const doc2Id = doctorIds[1];
  const recId = await upsertUser(P.reception.email, SEED.password, P.reception.name, {
    phone: P.reception.phone,
  });

  const mkMember = async (userId: string, role: string, extra: Record<string, unknown> = {}) => {
    const isOwner = !!extra.owner;
    const r = await c.query(
      `insert into clinic_members
         (clinic_id, user_id, role, is_owner, permissions, title, specialty, color, reminder_minutes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        clinicId, userId, role, isOwner,
        // Ownership carries full access; everyone else gets the set their job
        // implies, which is what the settings screen would have offered.
        JSON.stringify(
          isOwner
            ? { level: "full" }
            : {
                level: "custom",
                caps: Object.fromEntries(
                  (ROLE_DEFAULTS[role as MemberRole] ?? []).map((cap) => [cap, true])
                ),
              }
        ),
        (extra.title as string) ?? null,
        (extra.specialty as string) ?? null,
        (extra.color as string) ?? "#0b1220",
        (extra.reminder as number) ?? 30,
      ]
    );
    return r.rows[0].id as string;
  };

  // The owner is a receptionist who also owns the place — which is the point of
  // splitting the two: ownership is not a job.
  await mkMember(ownerId, "receptionist", { owner: true });
  /*
    Every doctor in the profile becomes a bookable member. Appointments below
    round-robin across this list, so a three-doctor practice actually looks like
    one on the calendar rather than like two people working very hard.
  */
  const doctorMemberIds: string[] = [];
  for (const [i, d] of P.doctors.entries()) {
    doctorMemberIds.push(
      await mkMember(doctorIds[i], "doctor", { title: "د.", specialty: d.specialty, color: d.color })
    );
  }
  const m1 = doctorMemberIds[0];
  const m2 = doctorMemberIds[1];
  await mkMember(recId, "receptionist", { color: "#5bc6e3" });

  // ---- Services
  const services: { id: string; name: string; dur: number; price: number }[] = [];
  const svcDefs = P.services;
  for (const [name, nameAr, dur, price, color] of svcDefs) {
    const r = await c.query(
      `insert into services (clinic_id, name, name_ar, duration_min, price, color, sort)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [clinicId, name, nameAr, dur, price, color, services.length]
    );
    services.push({ id: r.rows[0].id, name, dur, price });
  }
  for (const s of services) {
    // Every doctor offers every service — a demo where half the services have
    // no bookable doctor looks broken on the public booking page.
    await c.query(
      `insert into service_doctors (service_id, member_id, clinic_id)
       select $1, m, $3 from unnest($2::uuid[]) as m`,
      [s.id, doctorMemberIds, clinicId]
    );
  }

  // ---- Patient field definitions: the built-in set, then this clinic's own.
  // These same rows are the merge variables every document template can use.
  await c.query(`select seed_esign_defaults($1)`, [clinicId]);
  await c.query(
    `insert into patient_field_definitions
       (clinic_id, scope, key, label, label_ar, field_type, options, storage_key, display_order) values
      ($1, 'patient', 'patient.insurance', 'Insurance', 'شركة التأمين', 'select', $2, 'insurance', 210),
      ($1, 'patient', 'patient.allergies', 'Allergies', 'الحساسية', 'longtext', '[]', 'allergies', 220),
      ($1, 'patient', 'patient.referred_by', 'Referred by', 'من حوّله', 'text', '[]', 'referred_by', 230)
     on conflict (clinic_id, key) do nothing`,
    [clinicId, JSON.stringify(["بدون", "الأردنية للتأمين", "ميدغلف", "الشرق العربي"])]
  );

  await c.query(`insert into booking_links (clinic_id, slug, name) values ($1, $2, 'الرابط العام')`, [
    clinicId, SLUG,
  ]);

  await c.query(
    `insert into quick_replies (clinic_id, title, body, sort) values
      ($1, 'ترحيب', 'أهلاً وسهلاً فيك في ' || $2 || '! كيف بقدر أساعدك؟', 1),
      ($1, 'العنوان', 'عنواننا: ' || $3 || '. الموقع على الخريطة: ' || $4, 2),
      ($1, 'ساعات العمل', 'دوامنا من الأحد للخميس ٩ صباحاً - ٥ مساءً، والسبت ١٠ - ٤. الجمعة عطلة.', 3)`,
    [clinicId, P.nameAr, P.addressAr, P.maps]
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

  // ---- Doctor and team alerts (what the worker used to hardcode)
  await seedStaffAlerts(c as never, clinicId);

  // ---- Automation recipes copied in (two enabled for the demo)
  // The demo is a dental clinic, so it gets the general library plus dental.
  const recipes = await c.query(
    `select * from recipe_templates where active and specialty in ('general', 'dental') order by sort`
  );
  for (const r of recipes.rows) {
    const enable = r.key === "confirm_on_booking" || r.key === "reminder_24h";
    const a = await c.query(
      `insert into automations (clinic_id, name, description, trigger_type, trigger_config, active, recipe_key, recipe_specialty)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        clinicId, r.name_ar || r.name, r.description, r.trigger_type,
        JSON.stringify(r.trigger_config ?? {}), enable, r.key, r.specialty ?? "general",
      ]
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
  for (let i = 0; i < P.patients; i++) {
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
        clinicId, patientIds[i], doctorIds[i % doctorIds.length],
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
  /** What each doctor already has, so overlaps are caught without a query. */
  const booked = new Map<string, { start: number; end: number }[]>();
  const pendingAppts: (string | number)[][] = [];
  for (let d = -P.historyDays; d <= P.aheadDays; d++) {
    const day = now.plus({ days: d }).startOf("day");
    if (day.weekday === 5) continue; // Friday closed
    const perDay = day < now ? 3 + (Math.abs(d) % 3) : 2 + (d % 4);
    for (let k = 0; k < perDay; k++) {
      const hour = 9 + ((k * 2 + Math.abs(d)) % 7);
      const start = day.set({ hour, minute: (k % 2) * 30 });
      if (start < now.minus({ days: P.historyDays })) continue;
      const svc = services[(k + Math.abs(d)) % services.length];
      const end = start.plus({ minutes: svc.dur });
      const past = start < now;
      const status = past
        ? statuses[(k + Math.abs(d)) % statuses.length]
        : k % 3 === 0
          ? "confirmed"
          : "scheduled";
      // Slot times are generated arithmetically while durations vary per
      // service, so two of them can land on the same doctor. The product never
      // allows that, and demo data showing an impossible calendar is a bug in
      // the demo — skip rather than seed a double booking.
      // Round-robin across the whole team; a three-doctor practice should look
      // like one on the calendar rather than like two people working very hard.
      const doctor = doctorMemberIds[(k + Math.abs(d)) % doctorMemberIds.length];

      /*
        Checked in memory, not with a query per appointment.

        The clinic is deleted and rebuilt at the top of this script, so every
        appointment that could possibly clash is one this same loop just made —
        which makes the local check exactly equivalent to the round trip it
        replaces, and eight hundred round trips cheaper. That mattered: against
        the production database the query-per-appointment version was slow
        enough for the connection to be reset half way through, leaving a
        half-built demo behind.
      */
      const startMs = start.toMillis();
      const endMs = end.toMillis();
      const taken = booked.get(doctor) ?? [];
      if (taken.some((b) => b.start < endMs && b.end > startMs)) continue;
      /*
        A cancelled appointment does not hold its slot — the query this replaced
        listed the blocking statuses explicitly and left `cancelled` out, and
        dropping that detail quietly cost seventeen appointments on the first
        run of the rewrite.
      */
      if (status !== "cancelled") {
        taken.push({ start: startMs, end: endMs });
        booked.set(doctor, taken);
      }

      pendingAppts.push([
        clinicId,
        patientIds[(k * 5 + Math.abs(d) * 3) % patientIds.length],
        doctor,
        svc.id,
        start.toUTC().toISO()!,
        end.toUTC().toISO()!,
        status,
        ["staff", "booking_link", "ai_agent"][(k + Math.abs(d)) % 3],
      ]);
      apptCount++;
    }
  }

  /*
    One statement per few hundred rows instead of one per row. Same rows, and
    the difference between a seed that finishes over a home connection and one
    that does not.
  */
  for (let i = 0; i < pendingAppts.length; i += 200) {
    const chunk = pendingAppts.slice(i, i + 200);
    const values = chunk
      .map((_, n) => {
        const b = n * 8;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::timestamptz,$${b + 6}::timestamptz,$${b + 7},$${b + 8})`;
      })
      .join(",");
    await c.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source)
       values ${values}`,
      chunk.flat()
    );
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
    const number = `${P.invoicePrefix}-${year}-${String(seq).padStart(4, "0")}`;
    const price = Number(ap.price);
    const discount = i % 7 === 0 ? 5 : 0;
    const taxRate = 0;
    const subtotal = price;
    const total = subtotal - discount;
    const status = i % 6 === 0 ? "sent" : i % 11 === 0 ? "partially_paid" : "paid";
    const paid = status === "paid" ? total : status === "partially_paid" ? Math.round(total / 2) : 0;

    const inv = await c.query(
      `insert into invoices (clinic_id, patient_id, appointment_id, seq, number, status, subtotal,
                             discount_amount, tax_rate, tax_amount, total, amount_paid, sent_at, created_at, created_by,
                             issue_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $12, $13,
               (($12::timestamptz at time zone $14))::date) returning id`,
      [
        clinicId, ap.patient_id, ap.id, seq, number, status, subtotal, discount, taxRate,
        total, paid, ap.starts_at, ownerId, tz,
      ]
    );
    /*
      The discount goes on the line, not just in the header. Tax and discount are
      per line now, and a fixture whose header says 5 while its only line says 0
      is an invoice that does not foot — exactly the thing the e-invoice checks
      reject, discovered in QA rather than at a tax authority.
    */
    await c.query(
      `insert into invoice_items (clinic_id, invoice_id, service_id, description, qty, unit_price, amount,
                                  discount_amount, tax_category, tax_rate, tax_amount, sort)
       values ($1, $2, $3, $4, 1, $5, $5, $6, 'O', 0, 0, 0)`,
      [clinicId, inv.rows[0].id, ap.service_id, ap.name_ar || ap.name, price, discount]
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
      { dir: "out", kind: "automation", body: "تم تأكيد موعدك في ${P.nameAr} 🦷\n📅 الأحد\n🕐 ١١:٠٠ ص\nتنظيف وتلميع" },
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
      { dir: "out", kind: "automation", body: "تذكير بموعدك غداً في ${P.nameAr} 🦷\n🕐 ١٠:٣٠ ص\nمراجعة تقويم" },
      { dir: "in", kind: "patient", body: "تمام، بكون موجود" },
    ]],
    [4, [
      { dir: "in", kind: "patient", body: "بتقبلوا تأمين ميدغلف؟" },
      { dir: "out", kind: "staff", body: "نعم بنقبل ميدغلف. التأمين بيغطي الكشفية والتنظيف. احضر بطاقة التأمين معك." },
    ]],
  ];

  /*
    A months-old practice with five conversations in its inbox does not look
    like a months-old practice. The five above are the hand-written ones worth
    reading in a demo — a booking, an escalation, an insurance question — and
    these are the volume behind them, so the list has something to scroll.

    **Deliberately two-sided.** `whatsapp-health.ts` alerts when more than half
    a clinic's outbound goes into threads the patient never replied in, because
    that is the shape that gets a number reported. Seeding a demo full of
    one-way blasts would be both unrealistic and a standing false alarm in the
    operator's own inbox.
  */
  const filler: { dir: "in" | "out"; kind: string; body: string }[][] = [
    [
      { dir: "out", kind: "automation", body: `تذكير بموعدك غداً في ${P.nameAr} 🦷\n🕐 ١٠:٠٠ ص` },
      { dir: "in", kind: "patient", body: "تمام، شكراً إلك" },
    ],
    [
      { dir: "in", kind: "patient", body: "بدي أأجل موعدي لأسبوع الجاي إذا ممكن" },
      { dir: "out", kind: "staff", body: "أكيد، حوّلناه للأحد الجاي نفس الوقت. بنشوفك 👋" },
      { dir: "in", kind: "patient", body: "يسلمو" },
    ],
    [
      { dir: "in", kind: "patient", body: "قديش سعر التبييض؟" },
      { dir: "out", kind: "staff", body: "التبييض ٢٤٠ دينار للجلسة الكاملة، وبتشمل الكشف قبلها." },
      { dir: "in", kind: "patient", body: "تمام بحجز الأسبوع الجاي إن شاء الله" },
    ],
    [
      { dir: "out", kind: "automation", body: "مرّت ٦ شهور على آخر تنظيف. بتحب نحجزلك موعد؟" },
      { dir: "in", kind: "patient", body: "آه لو سمحت" },
      { dir: "out", kind: "staff", body: "تم، حجزنالك الخميس ١٢:٣٠." },
    ],
    [
      { dir: "in", kind: "patient", body: "الحشوة بتوجعني شوي من امبارح، هاد طبيعي؟" },
      { dir: "out", kind: "staff", body: "حساسية خفيفة أول يومين طبيعية. إذا زاد الألم تواصل معنا فوراً." },
      { dir: "in", kind: "patient", body: "أوكي منيح، شكراً دكتورة" },
    ],
    [
      { dir: "in", kind: "patient", body: "وين بتوقف السيارة عندكم؟" },
      { dir: "out", kind: "staff", body: "في موقف مجاني تحت المبنى، والمدخل من الشارع الخلفي." },
    ],
    [
      { dir: "out", kind: "automation", body: `تم تأكيد موعدك في ${P.nameAr} 🦷\n📅 الثلاثاء ٣:٠٠ م` },
      { dir: "in", kind: "patient", body: "تمام" },
    ],
    [
      { dir: "in", kind: "patient", body: "بدي استشارة عن زراعة سن" },
      { dir: "out", kind: "ai", body: "أهلاً فيك 😊 الزراعة بتبدأ بكشف وصورة أشعة. بتحب أحجزلك موعد استشارة؟" },
      { dir: "in", kind: "patient", body: "آه بليز" },
      { dir: "out", kind: "staff", body: "حجزناك مع د. نادية الأحد ١١:٣٠." },
    ],
  ];

  /*
    Spread across the last few weeks rather than the last few hours, so the
    inbox reads as a history and not as a burst that all arrived this morning.
    Patients are taken from the far end of the list, leaving the first five for
    the hand-written threads above.
  */
  for (let n = 0; n < P.extraThreads; n++) {
    const msgs = filler[n % filler.length];
    const pi = 5 + (n % Math.max(1, patientIds.length - 5));
    threads.push([pi, msgs]);
  }

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
    [clinicId, ownerId, `/c/${SLUG}/calendar`, `/c/${SLUG}/conversations`]
  );

  if (adminId) {
    await c.query(
      `insert into audit_log (clinic_id, user_id, action, entity, entity_id, detail)
       values ($1, $2, 'seed.demo', 'clinic', $3, '{"source":"seed"}')`,
      [clinicId, adminId, clinicId]
    );
  }

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
  console.log(`\n  Workspace      /c/${SLUG}`);
  console.log(`  Booking page   /book/${SLUG}`);
  console.log(
    `\n  ${counts.patients} patients · ${counts.appointments} appointments · ${counts.invoices} invoices · ` +
      `${counts.payments} payments · ${counts.conversations} threads (${counts.messages} messages) · ${counts.automations} automations\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
