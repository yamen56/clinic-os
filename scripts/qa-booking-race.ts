/**
 * Concurrency QA: one slot, many simultaneous bookings, exactly one appointment.
 *
 * Every booking path checks the slot is free and then inserts. Those are two
 * statements; without something holding the slot between them, concurrent
 * requests all see it free and all write, and two patients turn up for the same
 * time. This drives the public booking endpoint in parallel and asserts the
 * calendar can only ever contain one of them.
 */
import { Client } from "pg";
import { DateTime } from "luxon";

try {
  process.loadEnvFile?.();
} catch {}

const BASE = "http://localhost:3000";
const PG = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const CONCURRENCY = 8;

let passed = 0;
const ok = (m: string) => {
  passed++;
  console.log(`✓ ${m}`);
};
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const db = new Client({ connectionString: PG });
  await db.connect();

  const slug = `qarace${Date.now().toString(36)}`;
  // Open every day, so whichever day the slot lands on is bookable.
  const hours = JSON.stringify({
    mon: [["00:00", "23:59"]], tue: [["00:00", "23:59"]], wed: [["00:00", "23:59"]],
    thu: [["00:00", "23:59"]], fri: [["00:00", "23:59"]], sat: [["00:00", "23:59"]],
    sun: [["00:00", "23:59"]],
  });
  const clinic = (
    await db.query(
      `insert into clinics (name, slug, timezone, working_hours) values ('QA Race', $1, 'Asia/Amman', $2)
       returning id, timezone`,
      [slug, hours]
    )
  ).rows[0];
  // No whatsapp_sessions row -> the clinic reads as offline, so booking skips
  // the OTP and finalises inline. That is the path under test.
  await db.query(`insert into booking_links (clinic_id, slug, min_notice_min) values ($1, $2, 0)`, [
    clinic.id,
    slug,
  ]);
  const docUser = (
    await db.query(
      `insert into users (email, password_hash, full_name) values ($1, 'x', 'Dr Race') returning id`,
      [`race-doc-${slug}@test.local`]
    )
  ).rows[0];
  const member = (
    await db.query(
      `insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'doctor') returning id`,
      [clinic.id, docUser.id]
    )
  ).rows[0];
  const service = (
    await db.query(
      `insert into services (clinic_id, name, duration_min, price) values ($1, 'Checkup', 30, 10) returning id`,
      [clinic.id]
    )
  ).rows[0];
  await db.query(
    `insert into service_doctors (service_id, member_id, clinic_id) values ($1, $2, $3)`,
    [service.id, member.id, clinic.id]
  );

  const cleanup = async () => {
    await db.query(`delete from clinics where id = $1`, [clinic.id]);
    await db.query(`delete from users where id = $1`, [docUser.id]);
  };

  try {
    // A single slot, comfortably in the future, on a whole half-hour boundary.
    const slot = DateTime.now()
      .setZone(clinic.timezone)
      .plus({ days: 1 })
      .set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    const startISO = slot.toUTC().toISO()!;

    // Fire them together — each a different patient wanting the same time.
    const attempts = Array.from({ length: CONCURRENCY }, (_, i) =>
      fetch(`${BASE}/api/public/book/${slug}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: service.id,
          doctorId: member.id,
          startISO,
          fullName: `Racer ${i}`,
          phone: `+9627${String(90000000 + i)}`,
          locale: "en",
        }),
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
    );
    const results = await Promise.all(attempts);

    const booked = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status === 409);
    const other = results.filter((r) => r.status !== 200 && r.status !== 409);

    assert(
      other.length === 0,
      `unexpected responses: ${JSON.stringify(other.map((o) => [o.status, o.body]))}`
    );
    ok(`${CONCURRENCY} simultaneous bookings all answered cleanly (no 500s)`);

    const rows = await db.query(
      `select count(*)::int as n from appointments
       where clinic_id = $1 and doctor_member_id = $2 and status in ('pending_approval','scheduled','confirmed')`,
      [clinic.id, member.id]
    );
    assert(
      rows.rows[0].n === 1,
      `expected exactly 1 appointment on the slot, found ${rows.rows[0].n} — the slot was double booked`
    );
    ok("exactly one appointment exists on the contested slot");

    assert(booked.length === 1, `expected 1 success, got ${booked.length}`);
    assert(rejected.length === CONCURRENCY - 1, `expected ${CONCURRENCY - 1} rejections, got ${rejected.length}`);
    ok(`the other ${CONCURRENCY - 1} were told the slot was taken, not silently dropped`);

    // And no overlaps anywhere in this clinic, by the same definition the app uses.
    const overlaps = await db.query(
      `select count(*)::int as n from appointments a
       join appointments b on b.clinic_id = a.clinic_id and b.doctor_member_id = a.doctor_member_id
         and b.id <> a.id and b.starts_at < a.ends_at and b.ends_at > a.starts_at
       where a.clinic_id = $1 and a.doctor_member_id is not null
         and a.status in ('pending_approval','scheduled','confirmed')
         and b.status in ('pending_approval','scheduled','confirmed')`,
      [clinic.id]
    );
    assert(overlaps.rows[0].n === 0, `found ${overlaps.rows[0].n} overlapping pairs`);
    ok("no overlapping appointments for the doctor");

    console.log(`\n  ${passed} checks passed\n`);
  } finally {
    await cleanup();
    await db.end();
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
