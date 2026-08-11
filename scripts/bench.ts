/**
 * Scale benchmark.
 *
 * The demo clinic is too small to expose slow queries. This builds a clinic at
 * the size of a busy multi-year practice and times the queries behind each
 * screen, so regressions show up as numbers rather than as a customer
 * complaining that the patient list got sluggish.
 *
 *   npm run bench          # build data if missing, then time queries
 *   npm run bench -- --rebuild
 */
import { Client } from "pg";

try {
  process.loadEnvFile?.();
} catch {}

const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const SLUG = "bench-clinic";

const PATIENTS = 5_000;
const APPTS = 25_000;
const INVOICES = 8_000;
const CONVOS = 3_000;
const MESSAGES = 40_000;

async function build(c: Client): Promise<string> {
  const existing = await c.query("select id from clinics where slug = $1", [SLUG]);
  if (existing.rowCount) return existing.rows[0].id;

  console.log("[bench] building dataset…");
  const clinic = await c.query(
    `insert into clinics (name, name_ar, slug, timezone, default_locale, subscription_status)
     values ('Bench Clinic', 'عيادة القياس', $1, 'Asia/Amman', 'ar', 'active') returning id`,
    [SLUG]
  );
  const id = clinic.rows[0].id;

  // generate_series keeps this to a handful of round trips instead of 80k inserts.
  await c.query(
    `insert into patients (clinic_id, full_name, phone_e164, gender, status, tags, created_at, last_visit_at)
     select $1,
            'مريض ' || g,
            '+9627' || lpad((10000000 + g)::text, 8, '0'),
            case when g % 2 = 0 then 'male' else 'female' end,
            case when g % 20 = 0 then 'lead' else 'active' end,
            case when g % 7 = 0 then array['تأمين'] else '{}'::text[] end,
            now() - (g % 900) * interval '1 day',
            now() - (g % 400) * interval '1 day'
     from generate_series(1, $2) g`,
    [id, PATIENTS]
  );

  const svc = await c.query(
    `insert into services (clinic_id, name, name_ar, duration_min, price, color, bookable_online)
     values ($1, 'Checkup', 'كشفية', 30, 20, '#0b1220', true) returning id`,
    [id]
  );

  await c.query(
    `insert into appointments (clinic_id, patient_id, service_id, starts_at, ends_at, status, source)
     select $1,
            p.id,
            $2,
            ts, ts + interval '30 minutes',
            (array['scheduled','confirmed','completed','no_show','cancelled'])[1 + (g % 5)],
            'staff'
     from generate_series(1, $3) g
     cross join lateral (
       select now() - (g % 700) * interval '1 day' + ((g % 16) + 8) * interval '1 hour' as ts
     ) t
     join lateral (
       select id from patients where clinic_id = $1 offset (g % $4) limit 1
     ) p on true`,
    [id, svc.rows[0].id, APPTS, PATIENTS]
  );

  await c.query(
    `insert into invoices (clinic_id, patient_id, number, seq, status, subtotal, total, created_at, sent_at)
     select $1, p.id, 'BENCH-' || g, g,
            (array['draft','sent','partially_paid','paid','void'])[1 + (g % 5)],
            100, 100,
            now() - (g % 600) * interval '1 day',
            now() - (g % 600) * interval '1 day'
     from generate_series(1, $2) g
     join lateral (select id from patients where clinic_id = $1 offset (g % $3) limit 1) p on true`,
    [id, INVOICES, PATIENTS]
  );

  await c.query(
    `insert into conversations (clinic_id, phone_e164, patient_id, last_message_at, unread_count)
     select $1, p.phone_e164, p.id, now() - (g % 500) * interval '1 hour', g % 4
     from generate_series(1, $2) g
     join lateral (select id, phone_e164 from patients where clinic_id = $1 offset (g % $3) limit 1) p on true
     on conflict do nothing`,
    [id, CONVOS, PATIENTS]
  );

  await c.query(
    `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body, status, created_at)
     select $1, cv.id,
            case when g % 2 = 0 then 'in' else 'out' end,
            case when g % 3 = 0 then 'ai' when g % 2 = 0 then 'patient' else 'staff' end,
            'text', 'رسالة اختبار رقم ' || g, 'delivered',
            now() - (g % 2000) * interval '1 hour'
     from generate_series(1, $2) g
     join lateral (select id from conversations where clinic_id = $1 offset (g % $3) limit 1) cv on true`,
    [id, MESSAGES, CONVOS]
  );

  await c.query("analyze");
  console.log("[bench] dataset ready");
  return id;
}

type Case = { name: string; sql: string; params: (string | number)[] };

async function time(c: Client, cs: Case): Promise<{ ms: number; scan: boolean }> {
  await c.query(cs.sql, cs.params); // warm cache
  const t0 = process.hrtime.bigint();
  await c.query(cs.sql, cs.params);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const plan = await c.query(`explain (format json) ${cs.sql}`, cs.params);
  const scan = JSON.stringify(plan.rows[0]["QUERY PLAN"]).includes("Seq Scan");
  return { ms, scan };
}

async function main() {
  const c = new Client({ connectionString: PG });
  await c.connect();

  if (process.argv.includes("--rebuild")) {
    await c.query("delete from clinics where slug = $1", [SLUG]);
  }
  const id = await build(c);

  const cases: Case[] = [
    {
      name: "patients list (page 1)",
      sql: `select id, full_name, phone_e164, tags, last_visit_at from patients
            where clinic_id = $1 and merged_into is null
            order by created_at desc limit 50`,
      params: [id],
    },
    {
      name: "patient search by name",
      sql: `select id, full_name from patients
            where clinic_id = $1 and merged_into is null and full_name ilike $2 limit 50`,
      params: [id, "%مريض 4%"],
    },
    {
      name: "patient lookup by phone",
      sql: `select id from patients where clinic_id = $1 and phone_e164 = $2`,
      params: [id, "+96271000500"],
    },
    {
      name: "calendar week window",
      sql: `select ap.id, ap.starts_at, ap.status, p.full_name
            from appointments ap join patients p on p.id = ap.patient_id
            where ap.clinic_id = $1 and ap.starts_at >= now() - interval '3 days'
              and ap.starts_at < now() + interval '4 days'`,
      params: [id],
    },
    {
      name: "inbox thread list",
      sql: `select cv.id, cv.phone_e164, cv.last_message_at, cv.unread_count, p.full_name
            from conversations cv left join patients p on p.id = cv.patient_id
            where cv.clinic_id = $1 order by cv.last_message_at desc nulls last limit 40`,
      params: [id],
    },
    {
      name: "thread messages (latest 50)",
      sql: `select m.id, m.body, m.direction, m.created_at from messages m
            where m.conversation_id = (
              select id from conversations where clinic_id = $1 order by last_message_at desc limit 1
            ) order by m.created_at desc limit 50`,
      params: [id],
    },
    {
      name: "invoices list",
      sql: `select i.id, i.number, i.total, i.status, p.full_name from invoices i
            join patients p on p.id = i.patient_id
            where i.clinic_id = $1 order by i.created_at desc limit 50`,
      params: [id],
    },
    {
      name: "dashboard revenue this week",
      sql: `select coalesce(sum(amount), 0) from payments
            where clinic_id = $1 and paid_at >= date_trunc('week', now())`,
      params: [id],
    },
    {
      name: "dashboard no-show rate",
      sql: `select count(*) filter (where status = 'no_show')::float
                 / greatest(count(*), 1) from appointments
            where clinic_id = $1 and starts_at >= date_trunc('month', now())`,
      params: [id],
    },
  ];

  console.log(
    `\n  Scale: ${PATIENTS} patients · ${APPTS} appointments · ${MESSAGES} messages\n` +
      "  " + "─".repeat(58)
  );
  let worst = 0;
  for (const cs of cases) {
    const { ms, scan } = await time(c, cs);
    worst = Math.max(worst, ms);
    const flag = ms > 100 ? "\x1b[31mSLOW\x1b[0m" : scan ? "\x1b[33mscan\x1b[0m" : "\x1b[32m  ok\x1b[0m";
    console.log(`  ${flag}  ${cs.name.padEnd(30)} ${ms.toFixed(1).padStart(7)} ms`);
  }
  console.log("  " + "─".repeat(58));
  console.log(`  slowest ${worst.toFixed(1)} ms\n`);

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
