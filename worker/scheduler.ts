import { DateTime } from "luxon";
import { withSystem } from "./db";
import { startRun } from "./automations";
import { sweepExpiredDocuments, sweepUnsignedDocuments, sendPendingDigest } from "./esign";
import { backupDatabase } from "../src/lib/backup";
import { usingObjectStore } from "../src/lib/storage";

/**
 * Time-based triggers. Runs every minute; every enqueue is keyed by a
 * dedupe_key so a restart (or a second worker) can never double-fire.
 */

async function wakeSleepingRuns() {
  await withSystem(async (c) => {
    const due = await c.query(
      `select id, clinic_id from automation_runs
       where status = 'waiting' and wake_at is not null and wake_at <= now()
       limit 200`
    );
    for (const r of due.rows) {
      await c.query(`update automation_runs set status = 'running', wake_at = null where id = $1`, [r.id]);
      await c.query(
        `insert into jobs (clinic_id, kind, payload, dedupe_key) values ($1, 'automation:advance', $2, $3)
         on conflict (dedupe_key) do nothing`,
        [r.clinic_id, JSON.stringify({ runId: r.id }), `wake:${r.id}:${Date.now()}`]
      );
    }
  });
}

/** "X hours before appointment" — fires inside a one-minute window. */
async function appointmentReminders() {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, a.trigger_config from automations a
       where a.active and a.trigger_type = 'before_appointment'`
    );
    for (const auto of autos.rows) {
      const hours = Number((auto.trigger_config ?? {}).hours ?? 24);
      const appts = await c.query(
        `select ap.id, ap.patient_id from appointments ap
         where ap.clinic_id = $1
           and ap.status in ('scheduled', 'confirmed')
           and ap.starts_at > now()
           and ap.starts_at - ($2 * interval '1 hour') <= now()
           and ap.starts_at - ($2 * interval '1 hour') > now() - interval '90 seconds'`,
        [auto.clinic_id, hours]
      );
      for (const ap of appts.rows) {
        const runId = await startRun(c, auto.clinic_id, auto.id, {
          patientId: ap.patient_id,
          appointmentId: ap.id,
        });
        if (runId) {
          await c.query(
            `insert into jobs (clinic_id, kind, payload, dedupe_key)
             values ($1, 'automation:advance', $2, $3) on conflict (dedupe_key) do nothing`,
            [auto.clinic_id, JSON.stringify({ runId }), `reminder:${auto.id}:${ap.id}`]
          );
        }
      }
    }
  });
}

/** "X days after last visit" (recall) — evaluated once per clinic-local day. */
async function recallReminders() {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, a.trigger_config, cl.timezone
       from automations a join clinics cl on cl.id = a.clinic_id
       where a.active and a.trigger_type = 'after_last_visit'`
    );
    for (const auto of autos.rows) {
      const localNow = DateTime.now().setZone(auto.timezone);
      if (localNow.hour !== 10 || localNow.minute > 2) continue; // once daily at ~10:00 local
      const days = Number((auto.trigger_config ?? {}).days ?? 180);
      const patients = await c.query(
        `select id from patients
         where clinic_id = $1 and merged_into is null and status = 'active'
           and last_visit_at is not null
           and last_visit_at::date = (current_date - ($2::text || ' days')::interval)::date
         limit 200`,
        [auto.clinic_id, days]
      );
      for (const p of patients.rows) {
        const runId = await startRun(c, auto.clinic_id, auto.id, { patientId: p.id });
        if (runId) {
          await c.query(
            `insert into jobs (clinic_id, kind, payload, dedupe_key)
             values ($1, 'automation:advance', $2, $3) on conflict (dedupe_key) do nothing`,
            [
              auto.clinic_id,
              JSON.stringify({ runId }),
              `recall:${auto.id}:${p.id}:${localNow.toISODate()}`,
            ]
          );
        }
      }
    }
  });
}

/** Birthdays — clinic-local date comparison, so midnight boundaries are correct. */
async function birthdays() {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, cl.timezone from automations a
       join clinics cl on cl.id = a.clinic_id
       where a.active and a.trigger_type = 'birthday'`
    );
    for (const auto of autos.rows) {
      const localNow = DateTime.now().setZone(auto.timezone);
      if (localNow.hour !== 9 || localNow.minute > 2) continue;
      const patients = await c.query(
        `select id from patients
         where clinic_id = $1 and merged_into is null and status <> 'archived' and birth_date is not null
           and extract(month from birth_date) = $2 and extract(day from birth_date) = $3
         limit 200`,
        [auto.clinic_id, localNow.month, localNow.day]
      );
      for (const p of patients.rows) {
        const runId = await startRun(c, auto.clinic_id, auto.id, { patientId: p.id });
        if (runId) {
          await c.query(
            `insert into jobs (clinic_id, kind, payload, dedupe_key)
             values ($1, 'automation:advance', $2, $3) on conflict (dedupe_key) do nothing`,
            [auto.clinic_id, JSON.stringify({ runId }), `bday:${auto.id}:${p.id}:${localNow.year}`]
          );
        }
      }
    }
  });
}

/** "Invoice unpaid after X days". */
async function unpaidInvoices() {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, a.trigger_config, cl.timezone from automations a
       join clinics cl on cl.id = a.clinic_id
       where a.active and a.trigger_type = 'invoice_unpaid'`
    );
    for (const auto of autos.rows) {
      const localNow = DateTime.now().setZone(auto.timezone);
      if (localNow.hour !== 11 || localNow.minute > 2) continue;
      const days = Number((auto.trigger_config ?? {}).days ?? 3);
      const invoices = await c.query(
        `select id, patient_id from invoices
         where clinic_id = $1 and status in ('sent', 'partially_paid')
           and sent_at is not null
           and sent_at::date = (current_date - ($2::text || ' days')::interval)::date
         limit 200`,
        [auto.clinic_id, days]
      );
      for (const inv of invoices.rows) {
        const runId = await startRun(c, auto.clinic_id, auto.id, {
          patientId: inv.patient_id,
          invoiceId: inv.id,
        });
        if (runId) {
          await c.query(
            `insert into jobs (clinic_id, kind, payload, dedupe_key)
             values ($1, 'automation:advance', $2, $3) on conflict (dedupe_key) do nothing`,
            [auto.clinic_id, JSON.stringify({ runId }), `unpaid:${auto.id}:${inv.id}`]
          );
        }
      }
    }
  });
}

/**
 * A logical backup, once a day.
 *
 * The database lives on a volume we own now, so recovery is ours to arrange.
 * This runs at a quiet hour rather than on the minute-by-minute tick, and skips
 * entirely unless object storage is configured — a backup written to a
 * container's own disk would vanish with the container that failed.
 *
 * Deliberately not wrapped in a job row: if the job system itself is what broke,
 * the backup is exactly the thing that still needs to happen.
 */
async function dailyBackup() {
  if (!usingObjectStore()) return;
  const now = new Date();
  // 03:00 UTC, and only once — the tick runs every minute.
  if (now.getUTCHours() !== 3 || now.getUTCMinutes() !== 0) return;
  const started = Date.now();
  const r = await backupDatabase({ keep: Number(process.env.BACKUP_KEEP || 14) });
  console.log(
    `[backup] ${r.tables} tables, ${r.rows} rows, ${(r.bytes / 1048576).toFixed(1)} MB in ${Date.now() - started}ms -> ${r.path}`
  );
}

export function startScheduler() {
  const tick = async () => {
    for (const fn of [
      wakeSleepingRuns,
      appointmentReminders,
      recallReminders,
      birthdays,
      unpaidInvoices,
      sweepExpiredDocuments,
      sweepUnsignedDocuments,
      sendPendingDigest,
      dailyBackup,
    ]) {
      try {
        await fn();
      } catch (e) {
        console.error(`[scheduler ${fn.name}]`, (e as Error).message);
      }
    }
    setTimeout(tick, 60_000);
  };
  void tick();
}
