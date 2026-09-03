/**
 * Clinicti's own workspace.
 *
 * The product is sold to clinics; this is the tenant where Clinicti sells it.
 * Its records are the clinics it is talking to, its meetings are demos and
 * onboarding calls, and its public booking link is where a clinic owner picks a
 * time to be shown the software.
 *
 * The idea was already half-built — `clinics.vocabulary` and the `agency` patch
 * in `src/lib/i18n/vocab.ts` have existed since migration 0030 — but nothing
 * ever created the workspace, so the flag was set by hand-written SQL against
 * production and the content had to be typed in by somebody. This is that
 * missing half.
 *
 * ## Idempotent, not destructive
 *
 * Everything here is `where not exists` or `on conflict do nothing`. Run it
 * twice and the second run changes nothing; run it after six months of real use
 * and it adds only what is genuinely missing. That matters because this points
 * at production — `scripts/seed.ts` may delete and rebuild its demo clinic
 * because that clinic is fictional, and this one is not.
 *
 *     npm run seed:clinicti
 */
import { Client } from "pg";
import { provisionClinic } from "../src/lib/clinic-provision";
import type { PoolClient } from "pg";

const SLUG = "clinicti";

/**
 * The meeting types, as `services`.
 *
 * Priced at zero and with prices hidden on the link: what a clinic pays is a
 * conversation, not a number on a booking page. `duration_min` is doing real
 * work here — it is what the slot engine steps through — so the numbers are the
 * ones a rep should actually be blocked out for.
 */
const MEETING_TYPES = [
  {
    key: "demo",
    name: "Product demo",
    nameAr: "عرض توضيحي",
    description: "A walkthrough of Clinicti for your clinic, and time for questions.",
    durationMin: 30,
    bufferAfterMin: 10,
    locationKind: "online",
    color: "#0f6e5c",
    sort: 1,
  },
  {
    key: "onboarding",
    name: "Onboarding session",
    nameAr: "جلسة تهيئة",
    description: "Setting your clinic up: staff, services, hours, WhatsApp.",
    durationMin: 60,
    bufferAfterMin: 10,
    locationKind: "online",
    color: "#0b1220",
    sort: 2,
  },
  {
    key: "support",
    name: "Support call",
    nameAr: "مكالمة دعم",
    description: "A call with us about something that is not working as you expect. We ring you.",
    durationMin: 20,
    bufferAfterMin: 5,
    locationKind: "in_person",
    color: "#8a6d3b",
    sort: 3,
  },
];

/**
 * What the booking page asks a clinic owner.
 *
 * None of this needed new code: `booking_questions` (migration 0036) already
 * supports typed, optionally-required, per-service questions with help text, and
 * freezes the answers onto the appointment. The demo funnel is a data problem,
 * and this is the data.
 *
 * Kept short on purpose. Every extra field on a booking form is somewhere a
 * prospect can decide this is too much effort — name, size and what they use
 * today is enough to prepare for the call, and the rest is what the call is for.
 */
const QUESTIONS = [
  {
    label: "Clinic name",
    labelAr: "اسم العيادة",
    help: "So we can have your workspace ready before we speak.",
    helpAr: "لنحضّر مساحة العمل قبل موعدنا.",
    fieldType: "text",
    required: true,
    order: 1,
  },
  {
    label: "City",
    labelAr: "المدينة",
    help: "",
    helpAr: "",
    fieldType: "text",
    required: false,
    order: 2,
  },
  {
    label: "How many doctors?",
    labelAr: "كم عدد الأطباء؟",
    help: "It changes what we show you — a single practice and a six-chair clinic use this differently.",
    helpAr: "يغيّر ما سنعرضه — العيادة الفردية والعيادة الكبيرة تستخدمان النظام بشكل مختلف.",
    fieldType: "number",
    required: false,
    order: 3,
  },
  {
    label: "What do you use today?",
    labelAr: "ما الذي تستخدمونه حالياً؟",
    help: "Paper, Excel, another system — no wrong answer.",
    helpAr: "ورق، إكسل، نظام آخر — لا توجد إجابة خاطئة.",
    fieldType: "text",
    required: false,
    order: 4,
  },
];

const LINK_COPY = {
  headline: "See Clinicti with your own clinic in mind",
  headlineAr: "شاهد كلينيكتي بعين عيادتك",
  intro:
    "Pick a time that suits you. We will walk through the parts that matter for a clinic your size — booking, WhatsApp, reminders and billing — and answer whatever you ask.",
  introAr:
    "اختر الوقت المناسب لك. سنستعرض ما يهم عيادة بحجمك — الحجز وواتساب والتذكيرات والفوترة — ونجيب عن أسئلتك.",
  successNote:
    "We sent the details to your WhatsApp, with the link to join. If the time stops working for you, message us on the same number and we will move it.",
  successNoteAr:
    "أرسلنا التفاصيل ورابط الانضمام إلى واتساب. إن لم يعد الوقت مناسباً، راسلنا على الرقم نفسه وسننقله.",
};

export async function seedClinicti(c: PoolClient): Promise<{ created: boolean; slug: string }> {
  const existing = await c.query(`select id from clinics where slug = $1`, [SLUG]);
  let clinicId: string;
  let created = false;

  if (existing.rowCount) {
    clinicId = existing.rows[0].id as string;
  } else {
    const p = await provisionClinic(c, {
      name: "Clinicti",
      nameAr: "كلينيكتي",
      slug: SLUG,
      specialty: "general",
      ownerEmail: process.env.CLINICTI_OWNER_EMAIL || "team@clinicti.app",
      ownerName: "Clinicti",
      // The whole point of the workspace.
      vocabulary: "agency",
      defaultLocale: "ar",
    });
    clinicId = p.clinicId;
    created = true;
  }

  /*
    Set every time rather than only on creation. If somebody has flipped this row
    back to `medical` by hand, running the seed should put it right — that is the
    one field whose whole purpose is to be this workspace's.
  */
  await c.query(`update clinics set vocabulary = 'agency' where id = $1`, [clinicId]);

  // Meeting types. Matched by name so a re-run does not create a second "Product
  // demo" beside the one whose duration somebody has since adjusted.
  for (const m of MEETING_TYPES) {
    await c.query(
      `insert into services (clinic_id, name, name_ar, description, duration_min, price,
                             color, bookable_online, buffer_after_min, sort, location_kind)
       select $1, $2, $3, $4, $5, 0, $6, true, $7, $8, $9
        where not exists (select 1 from services where clinic_id = $1 and name = $2)`,
      [clinicId, m.name, m.nameAr, m.description, m.durationMin, m.color, m.bufferAfterMin, m.sort, m.locationKind]
    );
  }

  /*
    The booking link. Only the copy is written, and only when it is still blank:
    the slug, the notice period and the approval mode are things the team will
    tune, and a seed that reset them on every run would be a seed nobody dares
    execute.
  */
  /*
    `coalesce(...) = ''`, not `= ''`. These columns are nullable and a link
    created by `provisionClinic` has never been written to, so they are NULL
    rather than empty — a plain equality check quietly matched nothing and the
    copy never landed. Found by running this against production and reading the
    row back.
  */
  await c.query(
    `update booking_links
        set headline = case when coalesce(headline, '') = '' then $2 else headline end,
            headline_ar = case when coalesce(headline_ar, '') = '' then $3 else headline_ar end,
            intro = case when coalesce(intro, '') = '' then $4 else intro end,
            intro_ar = case when coalesce(intro_ar, '') = '' then $5 else intro_ar end,
            success_note = case when coalesce(success_note, '') = '' then $6 else success_note end,
            success_note_ar = case when coalesce(success_note_ar, '') = '' then $7 else success_note_ar end,
            show_prices = false
      where clinic_id = $1`,
    [
      clinicId,
      LINK_COPY.headline,
      LINK_COPY.headlineAr,
      LINK_COPY.intro,
      LINK_COPY.introAr,
      LINK_COPY.successNote,
      LINK_COPY.successNoteAr,
    ]
  );

  for (const q of QUESTIONS) {
    await c.query(
      `insert into booking_questions (clinic_id, label, label_ar, help, help_ar,
                                      field_type, required, active, display_order)
       select $1, $2, $3, $4, $5, $6, $7, true, $8
        where not exists (select 1 from booking_questions where clinic_id = $1 and label = $2)`,
      [clinicId, q.label, q.labelAr, q.help, q.helpAr, q.fieldType, q.required, q.order]
    );
  }

  /*
    Somebody has to be bookable, or the demo link renders a page nobody can book.

    `role = 'doctor'` is not a mistake here. Migration 0014 defines the column as
    the job and defines `doctor` as the one job that has working hours, can be
    booked and owns appointments — which is exactly what a person who runs demos
    is. The value is never shown to anybody: every screen reads it through
    `t.staff.roles[...]`, which this workspace's vocabulary renames. Relaxing the
    CHECK to add a synonym would mean touching four SQL predicates in the slot
    engine to gain a word nobody sees.

    Only when the workspace has no bookable host at all — so a real team, set up
    properly later, is never rearranged by re-running the seed.
  */
  const hosts = await c.query(
    `select count(*)::int n from clinic_members where clinic_id = $1 and role = 'doctor' and active`,
    [clinicId]
  );
  if (hosts.rows[0].n === 0) {
    await c.query(
      `update clinic_members
          set role = 'doctor',
              title = coalesce(nullif(title, ''), $2),
              working_hours = case
                when working_hours is null or working_hours = '{}'::jsonb then $3::jsonb
                else working_hours end
        where clinic_id = $1 and is_owner`,
      [
        clinicId,
        "Account manager",
        JSON.stringify({
          sun: [["09:00", "17:00"]],
          mon: [["09:00", "17:00"]],
          tue: [["09:00", "17:00"]],
          wed: [["09:00", "17:00"]],
          thu: [["09:00", "17:00"]],
        }),
      ]
    );
  }

  return { created, slug: SLUG };
}

if (process.argv[1]?.includes("seed-clinicti")) {
  // Targets DATABASE_SUPER_URL when set, so the same script seeds production.
  const url =
    process.env.DATABASE_SUPER_URL ??
    `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
  const c = new Client({
    connectionString: url,
    ssl: /@(localhost|127\.0\.0\.1)/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  c.connect()
    .then(async () => {
      await c.query("begin");
      try {
        const r = await seedClinicti(c as unknown as PoolClient);
        await c.query("commit");
        console.log(
          r.created
            ? `[seed] created the ${r.slug} workspace`
            : `[seed] ${r.slug} already existed — topped up what was missing`
        );
        /*
          The one thing this cannot seed. An online meeting takes the host's
          standing room, and there is no sensible default for somebody else's
          Zoom link — so it is said out loud rather than left as a booking that
          confirms and then tells the customer nothing about where to go.
        */
        const missing = await c.query(
          `select u.full_name from clinic_members cm join users u on u.id = cm.user_id
            where cm.clinic_id = (select id from clinics where slug = $1)
              and cm.role = 'doctor' and cm.active
              and coalesce(cm.meeting_url, '') = ''`,
          [r.slug]
        );
        if (missing.rowCount) {
          console.log(
            `[seed] set a meeting room for ${missing.rows
              .map((x) => x.full_name)
              .join(", ")} in Settings → Staff, or online bookings arrive with no link.`
          );
        }
      } catch (e) {
        await c.query("rollback");
        throw e;
      }
      return c.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
