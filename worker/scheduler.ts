import { DateTime } from "luxon";
import { withSystem } from "./db";
import { startRun } from "./automations";
import { sweepExpiredDocuments, sweepUnsignedDocuments, sendPendingDigest } from "./esign";
import { backupDatabase, backupAgeHours } from "../src/lib/backup";
import { usingObjectStore } from "../src/lib/storage";
import { deliveryWatch } from "./delivery-watch";
import { expirePastWaitlist, requeueStaleOffers } from "./waitlist";
import { sessions } from "./wa/session";
import { resolvePendingLids } from "./wa/lid-mapping";
import { deleteClinicFiles } from "../src/lib/storage";
import { RESTORE_WINDOW_DAYS } from "../src/lib/clinic-lifecycle";
import { licensed } from "./features";
import { enqueueEinvoiceSubmit } from "../src/lib/einvoice/jobs";

/**
 * Threads that arrived addressed by identity rather than number, every ten
 * minutes. A patient who messages at noon should have a real number on their
 * file long before anybody opens it — waiting for the next reconnect could be
 * days.
 */
async function sweepLidNumbers() {
  const now = new Date();
  if (now.getUTCMinutes() % 10 !== 0) return;
  for (const [clinicId, s] of sessions) {
    if (!s.connected) continue;
    const n = await resolvePendingLids(clinicId, s.sock).catch(() => 0);
    if (n) console.log(`[lid-sweep ${clinicId}] looked up ${n} thread(s)`);
  }
}

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

/**
 * "X hours before appointment" — fires inside a one-minute window.
 *
 * Unlike recall, birthdays and unpaid invoices, this one cannot be gated to a
 * single hour of the day: a reminder falls due whenever its appointment happens
 * to be, so the window has to be checked every minute. What it can stop doing is
 * asking once per automation. That was one round trip per active reminder per
 * minute — at a few hundred clinics, a thousand queries a minute to discover
 * that almost always nothing is due.
 *
 * One join instead, with the lead time read out of each automation's own config
 * inside the query. The `~` guard is there because a `hours` value that is not a
 * number would abort the whole statement: before, a hand-edited config broke one
 * clinic's reminders, and it must not now break everybody's.
 */
async function appointmentReminders() {
  await withSystem(async (c) => {
    const due = await c.query(
      `with reminder as (
         select a.id, a.clinic_id,
                case when a.trigger_config->>'hours' ~ '^[0-9]+(\\.[0-9]+)?$'
                     then (a.trigger_config->>'hours')::numeric else 24 end as hours
           from automations a
           join clinics cl on cl.id = a.clinic_id
          where a.active and a.trigger_type = 'before_appointment' and ${licensed("automations")}
       )
       select r.id as automation_id, r.clinic_id, ap.id as appointment_id, ap.patient_id
         from reminder r
         join appointments ap
           on ap.clinic_id = r.clinic_id
          /*
            The window written as a range on starts_at rather than on
            starts_at - hours, which is the same arithmetic and a completely
            different query plan. Subtracting inside the comparison makes the
            column non-indexable, so Postgres read every future appointment on
            the platform and filtered them one by one; this way each reminder
            does a ninety-second index range scan over
            appointments_clinic_time_idx and touches nothing else.
          */
          and ap.starts_at >  now() + (r.hours * interval '1 hour') - interval '90 seconds'
          and ap.starts_at <= now() + (r.hours * interval '1 hour')
        where ap.status in ('scheduled', 'confirmed')
          -- Redundant above unless somebody sets a lead time under 90 seconds.
          and ap.starts_at > now()
        limit 500`
    );
    for (const row of due.rows) {
      const runId = await startRun(c, row.clinic_id, row.automation_id, {
        patientId: row.patient_id,
        appointmentId: row.appointment_id,
      });
      if (runId) {
        await c.query(
          `insert into jobs (clinic_id, kind, payload, dedupe_key)
           values ($1, 'automation:advance', $2, $3) on conflict (dedupe_key) do nothing`,
          [
            row.clinic_id,
            JSON.stringify({ runId }),
            `reminder:${row.automation_id}:${row.appointment_id}`,
          ]
        );
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
       where a.active and a.trigger_type = 'after_last_visit' and ${licensed("automations")}`
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
       where a.active and a.trigger_type = 'birthday' and ${licensed("automations")}`
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

/**
 * The backstop for invoices ISTD never heard about.
 *
 * Filing is triggered by payment, and again by delivery. Both are the ordinary
 * path and both are usually enough — but an invoice that was raised, never
 * settled and never sent would fall through both, and "we forgot to report it"
 * is not a defence anyone wants to make to a tax authority. So once a day,
 * anything issued and still unfiled gets queued.
 *
 * It also rescues invoices left mid-flight. A worker killed between claiming the
 * job and finishing it leaves the job row `running` and the invoice `pending`
 * forever; nothing else in the system would ever look at it again.
 */
async function sweepEinvoices() {
  await withSystem(async (c) => {
    const now = DateTime.now();
    // Once a day, at a quiet hour, rather than on every minute's tick.
    if (now.hour !== 4 || now.minute > 2) return;

    const due = await c.query(
      `select i.id, i.clinic_id
         from invoices i
         join clinics cl on cl.id = i.clinic_id
         join clinic_einvoice_settings s on s.clinic_id = i.clinic_id
        where s.enabled and ${licensed("einvoicing")}
          and i.status not in ('draft', 'void')
          and i.einvoice_status = 'not_required'
          -- An invoice the clinic said not to file is not "unfiled", it is
          -- finished. Without this the sweep would quietly undo every opt-out
          -- twenty-four hours after it was made.
          and i.file_einvoice
          and i.created_at < now() - interval '24 hours'
        limit 500`
    );
    for (const inv of due.rows) {
      await enqueueEinvoiceSubmit(c, inv.clinic_id as string, inv.id as string, "sweep");
    }
    if (due.rowCount) console.log(`[einvoice] swept ${due.rowCount} unfiled invoice(s)`);

    const stranded = await c.query(
      `select i.id, i.clinic_id from invoices i
        where i.einvoice_status = 'pending' and i.updated_at < now() - interval '1 hour'
        limit 200`
    );
    for (const inv of stranded.rows) {
      // Clear the key first: a stale row would swallow the new job silently.
      await c.query(`delete from jobs where dedupe_key = $1`, [`einvoice:submit:${inv.id}`]);
      await c.query(
        `insert into jobs (clinic_id, kind, payload, dedupe_key)
         values ($1, 'einvoice:submit', $2, $3) on conflict (dedupe_key) do nothing`,
        [inv.clinic_id, JSON.stringify({ invoiceId: inv.id, reason: "sweep" }), `einvoice:submit:${inv.id}`]
      );
    }
    if (stranded.rowCount) console.log(`[einvoice] requeued ${stranded.rowCount} stranded submission(s)`);
  });
}

/** "Invoice unpaid after X days". */
async function unpaidInvoices() {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, a.trigger_config, cl.timezone from automations a
       join clinics cl on cl.id = a.clinic_id
       where a.active and a.trigger_type = 'invoice_unpaid' and ${licensed("automations")}`
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

  /*
    Driven by how old the newest archive is, not by the clock reading exactly
    03:00.

    The old test was `getUTCHours() === 3 && getUTCMinutes() === 0`, which
    assumed the tick lands on every minute of the day. It does not: the loop
    schedules the next run 60s *after* the previous one finishes, so the period
    is 60s plus however long fourteen jobs took and the phase walks forward all
    day. Minutes get skipped, and a skipped minute was a skipped day — with a
    deploy, a slow tick or a restart anywhere near the hour costing another one.

    Asking storage how old the last archive is makes the job idempotent instead
    of instantaneous: it can be attempted on any tick, it will do nothing when a
    recent archive exists, and a missed window is made up on the next tick
    rather than next week.
  */
  const ageHours = await backupAgeHours();
  const hour = new Date().getUTCHours();
  // The quiet window, or — if a day has already been missed — whenever.
  const due = ageHours >= 20 && (hour >= 3 && hour < 6);
  const overdue = ageHours >= 36;
  if (!due && !overdue) return;

  const started = Date.now();
  const r = await backupDatabase({
    keep: Number(process.env.BACKUP_KEEP || 14),
    keepMonthly: Number(process.env.BACKUP_KEEP_MONTHLY || 12),
  });
  console.log(
    `[backup] ${r.tables} tables, ${r.rows} rows, ${(r.bytes / 1048576).toFixed(1)} MB in ${Date.now() - started}ms -> ${r.path}`
  );
}

/**
 * Says out loud when there is no recent backup.
 *
 * The reason the five-week outage went unnoticed is that failure was silent:
 * `copyStreams()` threw, the scheduler's catch logged one line among thousands,
 * and nothing anywhere said "this database is not backed up". A job that
 * protects you only if someone reads the logs is not protection.
 *
 * Once an hour, loudly, and it is also what the admin monitoring page reads.
 */
async function backupHealth() {
  if (!usingObjectStore()) return;
  const now = new Date();
  if (now.getUTCMinutes() > 4) return;
  const ageHours = await backupAgeHours();
  if (ageHours < 30) return;
  console.error(
    ageHours === Infinity
      ? "[backup] ALARM: this database has never been backed up"
      : `[backup] ALARM: newest backup is ${Math.floor(ageHours)}h old`
  );
}

/**
 * Destroys clinics whose restore window has closed.
 *
 * This is the only place in the product that performs an irreversible delete of
 * a tenant, and it deliberately lives in the worker rather than behind a button.
 * A deletion that happens on a schedule is one nobody has to remember to do, and
 * — more to the point — one that cannot be done in anger: sixty days pass, with
 * the clinic sitting visibly in the deleted list and a countdown on its page,
 * before anything is destroyed.
 *
 * Once an hour, not once a minute. Nothing about a sixty-day deadline needs
 * minute precision, and the query would otherwise scan for work 1,440 times a
 * day to find none.
 *
 * Files first, then the row. The row is the only record that this clinic ever
 * existed, so losing it before the bucket is cleared strands a folder of patient
 * scans that nobody can attribute or find. The other order costs at worst a
 * retry an hour later: the clinic is still deleted, still due, still here.
 */
async function purgeDeletedClinics() {
  const now = new Date();
  if (now.getUTCMinutes() !== 7) return;

  const due = await withSystem(async (c) => {
    const r = await c.query(
      `select id, slug, name from clinics
        where deleted_at is not null
          and deleted_at < now() - ($1 || ' days')::interval
        limit 5`,
      [String(RESTORE_WINDOW_DAYS)]
    );
    return r.rows as { id: string; slug: string; name: string }[];
  });

  for (const clinic of due) {
    // One at a time, and never inside a shared transaction: a cascade across
    // forty-nine tables is a long-running statement, and batching several would
    // hold locks over rows other clinics' requests are reading.
    const files = await deleteClinicFiles(clinic.id).catch((e) => {
      console.error(`[purge ${clinic.slug}] storage`, (e as Error).message);
      return -1;
    });
    // A storage failure stops the row from going: deleting it now would lose
    // the only handle on those files forever. Next hour tries again.
    if (files < 0) continue;

    await withSystem(async (c) => {
      await c.query(`delete from clinics where id = $1`, [clinic.id]);
      // clinic_id stays null — audit_log cascades with the clinic, so an entry
      // filed against it would be destroyed by the delete it records.
      await c.query(
        `insert into audit_log (action, entity, entity_id, detail)
         values ('admin.clinic.purge.auto', 'clinic', $1, $2)`,
        [clinic.id, JSON.stringify({ slug: clinic.slug, name: clinic.name, filesDeleted: files })]
      );
    });
    console.log(`[purge] destroyed ${clinic.slug} (${files} files)`);
  }
}

export function startScheduler() {
  const tick = async () => {
    for (const fn of [
      wakeSleepingRuns,
      appointmentReminders,
      recallReminders,
      birthdays,
      unpaidInvoices,
      sweepEinvoices,
      sweepExpiredDocuments,
      sweepUnsignedDocuments,
      sendPendingDigest,
      dailyBackup,
      purgeDeletedClinics,
      sweepLidNumbers,
      deliveryWatch,
      requeueStaleOffers,
      expirePastWaitlist,
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
