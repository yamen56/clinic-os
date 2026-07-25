/**
 * RLS tenant-isolation proof.
 * Creates two clinics with a row in every clinic-scoped table (as superuser),
 * then connects as the app role and asserts each clinic context can never see
 * or write the other clinic's rows.
 */
import { Client, Pool, type PoolClient } from "pg";

const PG_PORT = Number(process.env.PG_PORT || 5544);
const SUPER_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/clinicos`;
const APP_URL = `postgres://clinicos_app:clinicos_app@127.0.0.1:${PG_PORT}/clinicos`;

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", label);
  }
}

type Fixture = {
  clinic: string;
  user: string;
  member: string;
  patient: string;
  service: string;
  appointment: string;
  conversation: string;
  invoice: string;
  automation: string;
  step: string;
  run: string;
};

async function buildFixture(su: Client, tag: string, seq: number): Promise<Fixture> {
  const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows[0];
  const clinic = (
    await q(`insert into clinics (name, slug) values ($1, $2) returning id`, [
      `RLS Test ${tag}`,
      `rls-test-${tag}`,
    ])
  ).id;
  const user = (
    await q(
      `insert into users (email, password_hash, full_name) values ($1, 'x', $2) returning id`,
      [`rls-${tag}@test.local`, `RLS ${tag}`]
    )
  ).id;
  const member = (
    await q(
      `insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'owner') returning id`,
      [clinic, user]
    )
  ).id;
  const patient = (
    await q(
      `insert into patients (clinic_id, full_name, phone_e164) values ($1, $2, $3) returning id`,
      [clinic, `Patient ${tag}`, `+96279000000${seq}`]
    )
  ).id;
  await q(`insert into custom_field_defs (clinic_id, key, label) values ($1, 'k', 'K') returning id`, [clinic]);
  await q(`insert into patient_notes (clinic_id, patient_id, body) values ($1, $2, 'note') returning id`, [clinic, patient]);
  await q(
    `insert into patient_files (clinic_id, patient_id, file_name, mime_type, storage_path) values ($1, $2, 'f.png', 'image/png', 'x') returning id`,
    [clinic, patient]
  );
  const service = (
    await q(`insert into services (clinic_id, name) values ($1, 'Cleaning') returning id`, [clinic])
  ).id;
  await q(`insert into service_doctors (service_id, member_id, clinic_id) values ($1, $2, $3) returning service_id`, [service, member, clinic]);
  const appointment = (
    await q(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at)
       values ($1, $2, $3, $4, now(), now() + interval '30 min') returning id`,
      [clinic, patient, member, service]
    )
  ).id;
  await q(`insert into booking_links (clinic_id, slug) values ($1, $2) returning id`, [clinic, `rls-bl-${tag}`]);
  const conversation = (
    await q(
      `insert into conversations (clinic_id, patient_id, phone_e164) values ($1, $2, $3) returning id`,
      [clinic, patient, `+96279000000${seq}`]
    )
  ).id;
  await q(
    `insert into messages (clinic_id, conversation_id, direction, body) values ($1, $2, 'in', 'hi') returning id`,
    [clinic, conversation]
  );
  await q(`insert into quick_replies (clinic_id, title, body) values ($1, 't', 'b') returning id`, [clinic]);
  await q(`insert into whatsapp_sessions (clinic_id) values ($1) returning clinic_id`, [clinic]);
  await q(`insert into whatsapp_auth_state (clinic_id, key, value) values ($1, 'creds', '{}') returning clinic_id`, [clinic]);
  const invoice = (
    await q(
      `insert into invoices (clinic_id, patient_id, seq, number) values ($1, $2, 1, $3) returning id`,
      [clinic, patient, `RLS-${tag}-1`]
    )
  ).id;
  await q(`insert into invoice_items (clinic_id, invoice_id, description) values ($1, $2, 'item') returning id`, [clinic, invoice]);
  await q(
    `insert into payments (clinic_id, invoice_id, patient_id, amount, method) values ($1, $2, $3, 10, 'cash') returning id`,
    [clinic, invoice, patient]
  );
  const automation = (
    await q(
      `insert into automations (clinic_id, name, trigger_type) values ($1, 'a', 'appointment_created') returning id`,
      [clinic]
    )
  ).id;
  const step = (
    await q(
      `insert into automation_steps (clinic_id, automation_id, step_type) values ($1, $2, 'stop') returning id`,
      [clinic, automation]
    )
  ).id;
  const run = (
    await q(
      `insert into automation_runs (clinic_id, automation_id, patient_id) values ($1, $2, $3) returning id`,
      [clinic, automation, patient]
    )
  ).id;
  await q(`insert into automation_run_logs (clinic_id, run_id, step_id, status) values ($1, $2, $3, 'ok') returning id`, [clinic, run, step]);
  await q(`insert into tasks (clinic_id, title) values ($1, 'task') returning id`, [clinic]);
  await q(`insert into ai_agents (clinic_id) values ($1) returning clinic_id`, [clinic]);
  await q(`insert into ai_knowledge_items (clinic_id, title) values ($1, 'k') returning id`, [clinic]);
  await q(`insert into ai_conversation_state (conversation_id, clinic_id) values ($1, $2) returning conversation_id`, [conversation, clinic]);
  await q(`insert into ai_usage (clinic_id, day) values ($1, current_date) returning id`, [clinic]);
  await q(`insert into jobs (clinic_id, kind) values ($1, 'noop') returning id`, [clinic]);
  await q(`insert into audit_log (clinic_id, user_id, action) values ($1, $2, 'rls.test') returning id`, [clinic, user]);
  await q(`insert into notifications (clinic_id, user_id, kind, title) values ($1, $2, 'test', 'T') returning id`, [clinic, user]);
  await q(
    `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day') returning id`,
    [`rls-hash-${tag}`, user]
  );
  await q(
    `insert into push_subscriptions (user_id, endpoint, keys) values ($1, $2, '{}') returning id`,
    [user, `https://push.test/${tag}`]
  );
  return { clinic, user, member, patient, service, appointment, conversation, invoice, automation, step, run };
}

async function withCtx<T>(
  pool: Pool,
  ctx: { userId?: string; clinicId?: string; role?: string; isAdmin?: boolean },
  fn: (c: PoolClient) => Promise<T>
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(
      `select set_config('app.user_id', $1, true), set_config('app.clinic_id', $2, true),
              set_config('app.role', $3, true), set_config('app.is_admin', $4, true)`,
      [ctx.userId ?? "", ctx.clinicId ?? "", ctx.role ?? "", ctx.isAdmin ? "true" : "false"]
    );
    const r = await fn(c);
    await c.query("rollback");
    return r;
  } finally {
    c.release();
  }
}

async function main() {
  const su = new Client({ connectionString: SUPER_URL });
  await su.connect();

  // Clean leftovers from previous runs
  await su.query(`delete from clinics where slug like 'rls-test-%'`);
  await su.query(`delete from users where email like 'rls-%@test.local'`);

  const A = await buildFixture(su, "a", 1);
  const B = await buildFixture(su, "b", 2);

  const clinicTables = (
    await su.query(`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'clinic_id'
        and table_name not in ('_migrations')
      order by table_name`)
  ).rows.map((r) => r.table_name as string);
  console.log(`[rls] testing ${clinicTables.length} clinic-scoped tables`);

  const app = new Pool({ connectionString: APP_URL, max: 2 });

  for (const t of clinicTables) {
    // A's context must see zero B rows and at least one A row
    const seesB = await withCtx(app, { userId: A.user, clinicId: A.clinic, role: "owner" }, async (c) => {
      const r = await c.query(`select count(*)::int as n from ${t} where clinic_id = $1`, [B.clinic]);
      return r.rows[0].n as number;
    });
    ok(seesB === 0, `${t}: clinic A must not see clinic B rows (saw ${seesB})`);

    const seesOwn = await withCtx(app, { userId: A.user, clinicId: A.clinic, role: "owner" }, async (c) => {
      const r = await c.query(`select count(*)::int as n from ${t} where clinic_id = $1`, [A.clinic]);
      return r.rows[0].n as number;
    });
    ok(seesOwn >= 1, `${t}: clinic A must see its own rows`);

    // No-context connection sees nothing at all
    const anon = await withCtx(app, {}, async (c) => {
      const r = await c.query(`select count(*)::int as n from ${t}`);
      return r.rows[0].n as number;
    });
    ok(anon === 0, `${t}: anonymous context must see zero rows (saw ${anon})`);
  }

  // Cross-tenant writes must be rejected
  const insertBlocked = await withCtx(app, { userId: A.user, clinicId: A.clinic, role: "owner" }, async (c) => {
    try {
      await c.query(`insert into patients (clinic_id, full_name) values ($1, 'intruder')`, [B.clinic]);
      return false;
    } catch {
      return true;
    }
  });
  ok(insertBlocked, "insert into another clinic must be rejected");

  const moveBlocked = await withCtx(app, { userId: A.user, clinicId: A.clinic, role: "owner" }, async (c) => {
    try {
      const r = await c.query(`update patients set clinic_id = $1 where clinic_id = $2`, [B.clinic, A.clinic]);
      return r.rowCount === 0;
    } catch {
      return true;
    }
  });
  ok(moveBlocked, "moving rows to another clinic must be rejected");

  // clinics table itself
  const clinicVisible = await withCtx(app, { userId: A.user, clinicId: A.clinic, role: "owner" }, async (c) => {
    const r = await c.query(`select count(*)::int as n from clinics where id = $1`, [B.clinic]);
    return r.rows[0].n as number;
  });
  ok(clinicVisible === 0, "clinic A must not see clinic B in clinics table");

  // users: A must not see B's staff
  const userVisible = await withCtx(app, { userId: A.user, clinicId: A.clinic, role: "owner" }, async (c) => {
    const r = await c.query(`select count(*)::int as n from users where id = $1`, [B.user]);
    return r.rows[0].n as number;
  });
  ok(userVisible === 0, "clinic A staff must not see clinic B staff");

  // sessions: only own
  const sessionLeak = await withCtx(app, { userId: A.user, clinicId: A.clinic, role: "owner" }, async (c) => {
    const r = await c.query(`select count(*)::int as n from sessions where user_id = $1`, [B.user]);
    return r.rows[0].n as number;
  });
  ok(sessionLeak === 0, "sessions of other users must be invisible");

  // notifications/push: only own
  const notifLeak = await withCtx(app, { userId: A.user, clinicId: A.clinic, role: "owner" }, async (c) => {
    const r = await c.query(`select count(*)::int as n from notifications where user_id = $1`, [B.user]);
    return r.rows[0].n as number;
  });
  ok(notifLeak === 0, "notifications of other users must be invisible");

  // admin context sees everything
  const adminSees = await withCtx(app, { isAdmin: true }, async (c) => {
    const r = await c.query(`select count(*)::int as n from patients where clinic_id in ($1, $2)`, [A.clinic, B.clinic]);
    return r.rows[0].n as number;
  });
  ok(adminSees === 2, "admin context must see both clinics");

  // announcements: readable, not writable from clinic ctx
  const annBlocked = await withCtx(app, { userId: A.user, clinicId: A.clinic, role: "owner" }, async (c) => {
    try {
      await c.query(`insert into announcements (title) values ('x')`);
      return false;
    } catch {
      return true;
    }
  });
  ok(annBlocked, "clinic context must not write announcements");

  // Cleanup
  await su.query(`delete from clinics where slug like 'rls-test-%'`);
  await su.query(`delete from users where email like 'rls-%@test.local'`);
  await su.end();
  await app.end();

  console.log(`rls tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
