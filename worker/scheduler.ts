import { DateTime } from "luxon";
import { dailyWindowOpen, rest, resting } from "./daily";
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
import { opsWatch } from "../src/lib/ops-alert";
import { postRecurringExpenses } from "./expenses";
import { unbookedTreatments } from "./treatments";
import { enquiriesNotBooked, treatmentSessionsDue } from "./coordinator";
import { stockAlerts } from "./stock-alerts";

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
      /*
        Conditional on still waiting: a reply may have woken this run a moment
        ago (resumeOnReply), and the clock must not wake it a second time and
        send it down "no reply" as well.
      */
      const woke = await c.query(
        `update automation_runs set status = 'running', wake_at = null, waiting_for = null
          where id = $1 and status = 'waiting'`,
        [r.id]
      );
      if (!woke.rowCount) continue;
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
export async function appointmentReminders() {
  await withSystem(async (c) => {
    const due = await c.query(
      `with reminder as (
         select a.id, a.clinic_id,
                case when a.trigger_config->>'hours' ~ '^[0-9]+(\\.[0-9]+)?$'
                     then (a.trigger_config->>'hours')::numeric else 24 end as hours,
                case when jsonb_typeof(a.trigger_config->'services') = 'array'
                     then a.trigger_config->'services' else '[]'::jsonb end as services,
                case when jsonb_typeof(a.trigger_config->'doctors') = 'array'
                     then a.trigger_config->'doctors' else '[]'::jsonb end as doctors
           from automations a
           join clinics cl on cl.id = a.clinic_id
          where a.active and a.trigger_type = 'before_appointment' and ${licensed("automations")}
       )
       select r.id as automation_id, r.clinic_id, ap.id as appointment_id, ap.patient_id
         from reminder r
         join appointments ap
           on ap.clinic_id = r.clinic_id
          /*
            Everything from now to the lead time ahead, as a range on
            starts_at so it stays an index range scan over
            appointments_clinic_time_idx (subtracting inside the comparison
            made Postgres read every future appointment on the platform).
          */
          and ap.starts_at > now()
          and ap.starts_at <= now() + (r.hours * interval '1 hour')
        where ap.status in ('scheduled', 'confirmed')
          -- Already in the waiting room: "see you in an hour" would be read there.
          and ap.arrived_at is null
          -- Only the services and doctors this reminder is for, when it names any.
          and (jsonb_array_length(r.services) = 0 or r.services ? ap.service_id::text)
          and (jsonb_array_length(r.doctors) = 0 or r.doctors ? ap.doctor_member_id::text)
          /*
            Which of them are due. This used to be a ninety-second window
            exactly the lead time ahead, and two kinds of appointment never
            passed through it:

            - One booked inside the lead time — at 3pm for ten tomorrow morning
              — which is a very ordinary booking and got no 24-hour reminder at
              all. It now gets it once an hour has passed since booking (so it
              does not land on top of the confirmation), while a quarter of the
              lead time is still ahead, for reminders of six hours or more.
            - One whose moment fell in a gap between ticks: the loop runs every
              minute *plus* however long the tick took, and a deploy restarts
              the worker. A reminder is now caught up to six hours late.
          */
          and (
            (ap.created_at < ap.starts_at - (r.hours * interval '1 hour')
               and ap.starts_at - (r.hours * interval '1 hour') > now() - interval '6 hours')
            or
            (r.hours >= 6
               and ap.created_at >= ap.starts_at - (r.hours * interval '1 hour')
               and ap.created_at <= now() - interval '1 hour'
               and ap.created_at >  now() - interval '6 hours'
               and ap.starts_at > now() + (r.hours * interval '15 minutes'))
          )
          /*
            And not reminded already for this time. A run counts if it began
            in the window leading up to the appointment's current time — from
            its reminder moment, or from when it was booked if that was later —
            so an appointment moved to next week is reminded again before its
            new time, and one moved by half an hour is not reminded twice.
          */
          and not exists (
            select 1 from automation_runs ar
             where ar.automation_id = r.id and ar.appointment_id = ap.id
               and ar.started_at > greatest(ap.created_at, ap.starts_at - (r.hours * interval '1 hour')) - interval '1 hour'
          )
        limit 500`
    );
    for (const row of due.rows) {
      const runId = await startRun(c, row.clinic_id, row.automation_id, {
        patientId: row.patient_id,
        appointmentId: row.appointment_id,
      });
      /*
        Keyed by the run. It used to be keyed by automation and appointment,
        and job keys are unique for ever: an appointment rescheduled after its
        reminder got a new run whose advance job was silently dropped, so the
        run sat "running" until the sweep marked it failed and the patient was
        never reminded of the new time.
      */
      if (runId) await advanceOnce(c, row.clinic_id, runId);
    }
  });
}

/** The advance job for a run the scheduler just started, keyed by the run so it is queued exactly once. */
async function advanceOnce(c: import("pg").PoolClient, clinicId: string, runId: string) {
  await c.query(
    `insert into jobs (clinic_id, kind, payload, dedupe_key)
     values ($1, 'automation:advance', $2, $3) on conflict (dedupe_key) do nothing`,
    [clinicId, JSON.stringify({ runId }), `advance:${runId}`]
  );
}


/** "X days after last visit" (recall) — evaluated once per clinic-local day. */
/** `force`: ignore the hour and the rest — for QA, which cannot wait for ten o'clock. */
export async function recallReminders(opts: { force?: boolean } = {}) {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, a.trigger_config, cl.timezone
       from automations a join clinics cl on cl.id = a.clinic_id
       where a.active and a.trigger_type = 'after_last_visit' and ${licensed("automations")}`
    );
    for (const auto of autos.rows) {
      const localNow = DateTime.now().setZone(auto.timezone);
      if (!opts.force && (!dailyWindowOpen(localNow, 10) || resting(`recall:${auto.id}`))) continue;
      const days = Number((auto.trigger_config ?? {}).days ?? 180);
      /*
        The visit's date in the clinic's own calendar (a 1am visit in Amman is
        the previous day in UTC), and not already reached by this flow today.
      */
      const patients = await c.query(
        `select p.id from patients p
         where p.clinic_id = $1 and p.merged_into is null and p.status = 'active'
           and p.last_visit_at is not null
           and (p.last_visit_at at time zone $3)::date = $4::date - $2::int
           and not exists (
             select 1 from automation_runs ar
              where ar.automation_id = $5 and ar.patient_id = p.id and ar.started_at > now() - interval '20 hours')
         limit 200`,
        [auto.clinic_id, days, auto.timezone, localNow.toISODate(), auto.id]
      );
      let started = 0;
      for (const p of patients.rows) {
        const runId = await startRun(c, auto.clinic_id, auto.id, { patientId: p.id });
        if (runId) {
          started++;
          await advanceOnce(c, auto.clinic_id, runId);
        }
      }
      rest(`recall:${auto.id}`, started);
    }
  });
}

/**
 * The doctor's next visit, due (migration 0088's hand-off): the newest
 * finished visit per patient that asked for another, falling due `days_before`
 * from today in the clinic's calendar, with nothing booked for the patient
 * since — the same rule as the due-back list reception sees (lib/due-back).
 * The run is about that visit, so "same doctor" books the one the doctor named.
 */
export async function nextVisitsDue(opts: { force?: boolean } = {}) {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, a.trigger_config, cl.timezone
       from automations a join clinics cl on cl.id = a.clinic_id
       where a.active and a.trigger_type = 'next_visit_due' and ${licensed("automations")}`
    );
    for (const auto of autos.rows) {
      const localNow = DateTime.now().setZone(auto.timezone);
      if (!opts.force && (!dailyWindowOpen(localNow, 10) || resting(`next:${auto.id}`))) continue;
      const before = Math.max(0, Math.min(30, Number((auto.trigger_config ?? {}).days_before ?? 2) || 0));
      const due = await c.query(
        `with latest as (
           select distinct on (a.patient_id) a.id, a.patient_id, a.starts_at,
                  coalesce(a.finished_at, a.starts_at) + make_interval(days => a.next_visit_days) as due_at
             from appointments a
            where a.clinic_id = $1 and a.status = 'completed' and a.next_visit_days is not null
            order by a.patient_id, coalesce(a.finished_at, a.starts_at) desc
         )
         select l.id, l.patient_id from latest l
           join patients p on p.id = l.patient_id and p.merged_into is null and p.status <> 'archived'
          where (l.due_at at time zone $2)::date = $3::date + $4::int
            and not exists (
              select 1 from appointments b
               where b.clinic_id = $1 and b.patient_id = l.patient_id and b.starts_at > l.starts_at
                 and b.status not in ('cancelled', 'no_show'))
            and not exists (select 1 from automation_runs ar where ar.automation_id = $5 and ar.appointment_id = l.id)
          limit 200`,
        [auto.clinic_id, auto.timezone, localNow.toISODate(), before, auto.id]
      );
      let started = 0;
      for (const v of due.rows) {
        const runId = await startRun(c, auto.clinic_id, auto.id, { patientId: v.patient_id, appointmentId: v.id });
        if (runId) {
          started++;
          await advanceOnce(c, auto.clinic_id, runId);
        }
      }
      rest(`next:${auto.id}`, started);
    }
  });
}

/** Birthdays — clinic-local date comparison, so midnight boundaries are correct. */
export async function birthdays(opts: { force?: boolean } = {}) {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, cl.timezone from automations a
       join clinics cl on cl.id = a.clinic_id
       where a.active and a.trigger_type = 'birthday' and ${licensed("automations")}`
    );
    for (const auto of autos.rows) {
      const localNow = DateTime.now().setZone(auto.timezone);
      if (!opts.force && (!dailyWindowOpen(localNow, 9) || resting(`bday:${auto.id}`))) continue;
      const patients = await c.query(
        `select p.id from patients p
         where p.clinic_id = $1 and p.merged_into is null and p.status <> 'archived' and p.birth_date is not null
           and extract(month from p.birth_date) = $2 and extract(day from p.birth_date) = $3
           and not exists (
             select 1 from automation_runs ar
              where ar.automation_id = $4 and ar.patient_id = p.id and ar.started_at > now() - interval '20 hours')
         limit 200`,
        [auto.clinic_id, localNow.month, localNow.day, auto.id]
      );
      let started = 0;
      for (const p of patients.rows) {
        const runId = await startRun(c, auto.clinic_id, auto.id, { patientId: p.id });
        if (runId) {
          started++;
          await advanceOnce(c, auto.clinic_id, runId);
        }
      }
      rest(`bday:${auto.id}`, started);
    }
  });
}

/**
 * "A patient has been waiting N minutes for a reply."
 *
 * Every minute, for each such flow: threads whose last message is the
 * patient's, older than the flow's N minutes but by no more than ten more — a
 * missed tick is made up, a thread from last week is not news. At any hour:
 * automations work 24/7 (Yamen, 2026-11-10), and a patient writing at 2am is
 * exactly the one nobody else is answering.
 * Once per message: a run already started since that message counts.
 */
async function unansweredConversations() {
  await withSystem(async (c) => {
    const due = await c.query(
      `with flow as (
         select a.id, a.clinic_id,
                case when a.trigger_config->>'minutes' ~ '^[0-9]+$'
                     then (a.trigger_config->>'minutes')::int else 15 end as minutes
           from automations a
           join clinics cl on cl.id = a.clinic_id
          where a.active and a.trigger_type = 'conversation_unanswered' and ${licensed("automations")}
       )
       select f.id as automation_id, f.clinic_id, cv.id as conversation_id, cv.patient_id
         from flow f
         join conversations cv on cv.clinic_id = f.clinic_id
        where cv.status = 'open' and cv.last_message_direction = 'in'
          and cv.last_message_at <= now() - (f.minutes * interval '1 minute')
          and cv.last_message_at >  now() - (f.minutes * interval '1 minute') - interval '10 minutes'
          and not exists (
            select 1 from automation_runs r
             where r.automation_id = f.id and r.conversation_id = cv.id and r.started_at >= cv.last_message_at
          )
        limit 500`
    );
    for (const row of due.rows) {
      const runId = await startRun(c, row.clinic_id, row.automation_id, {
        patientId: row.patient_id,
        conversationId: row.conversation_id,
      });
      if (runId) {
        await c.query(`insert into jobs (clinic_id, kind, payload) values ($1, 'automation:advance', $2)`, [
          row.clinic_id,
          JSON.stringify({ runId }),
        ]);
      }
    }
  });
}

/**
 * Runs stuck "running" with nothing left to move them.
 *
 * A run is only ever running while an advance job for it is queued or in hand.
 * One that has sat there for six hours with no such job lost it — a worker
 * killed at the wrong moment — and would otherwise hold its place in the
 * dedupe index for ever, quietly keeping this flow from that patient. Marked
 * failed so the history says so. Hourly.
 */
async function sweepStalledRuns() {
  if (new Date().getUTCMinutes() !== 37) return;
  await withSystem(async (c) => {
    const r = await c.query(
      `update automation_runs r set status = 'failed', error = 'stalled', finished_at = now()
        where r.status = 'running' and r.updated_at < now() - interval '6 hours'
          and not exists (
            select 1 from jobs j
             where j.kind = 'automation:advance' and j.status in ('pending', 'running')
               and j.payload->>'runId' = r.id::text
          )
        returning r.id`
    );
    if (r.rowCount) console.log(`[automations] marked ${r.rowCount} stalled run(s) failed`);
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
          -- Covered in full by an insurer: nothing for the patient to file, and
          -- left in, these would fill the 500 every night for ever.
          and (coalesce(i.insurer_amount, 0) = 0 or i.total > i.insurer_amount)
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
export async function unpaidInvoices(opts: { force?: boolean } = {}) {
  await withSystem(async (c) => {
    const autos = await c.query(
      `select a.id, a.clinic_id, a.trigger_config, cl.timezone from automations a
       join clinics cl on cl.id = a.clinic_id
       where a.active and a.trigger_type = 'invoice_unpaid' and ${licensed("automations")}`
    );
    for (const auto of autos.rows) {
      const localNow = DateTime.now().setZone(auto.timezone);
      if (!opts.force && (!dailyWindowOpen(localNow, 11) || resting(`unpaid:${auto.id}`))) continue;
      const days = Number((auto.trigger_config ?? {}).days ?? 3);
      const invoices = await c.query(
        `select i.id, i.patient_id from invoices i
         where i.clinic_id = $1 and i.status in ('sent', 'partially_paid')
           and i.sent_at is not null
           and (i.sent_at at time zone $3)::date = $4::date - $2::int
           and not exists (select 1 from automation_runs ar where ar.automation_id = $5 and ar.invoice_id = i.id)
         limit 200`,
        [auto.clinic_id, days, auto.timezone, localNow.toISODate(), auto.id]
      );
      let started = 0;
      for (const inv of invoices.rows) {
        const runId = await startRun(c, auto.clinic_id, auto.id, {
          patientId: inv.patient_id,
          invoiceId: inv.id,
        });
        if (runId) {
          started++;
          await advanceOnce(c, auto.clinic_id, runId);
        }
      }
      rest(`unpaid:${auto.id}`, started);
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
 * Looks for anything wrong with the platform and emails whoever runs it.
 *
 * This replaces a `backupHealth()` that wrote "ALARM" to the log once an hour
 * — and which, it turned out, was **never registered in the tick list below**,
 * so it had not run once since it was written. That is worth recording rather
 * than quietly deleting: the whole reason backups were lost for five weeks is a
 * safeguard that existed in the source and did nothing at runtime, and the
 * replacement for it reproduced the same bug in the same file.
 *
 * A log line was never going to be enough anyway. `src/lib/ops-alert.ts` sends
 * mail, remembers what it has already said so a six-hour outage is not 360
 * emails, and says so again when the problem clears.
 *
 * Every five minutes: it makes a handful of queries and one HTTP call, which is
 * far too much to repeat every minute and far more often than any of these
 * conditions actually change.
 */
async function opsHealth() {
  if (new Date().getUTCMinutes() % 5 !== 0) return;
  await opsWatch();
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
/**
 * Deletes sessions that can no longer authorise anything.
 *
 * A row survives being unusable: expiry and the idle window both stop a session
 * working without removing it, so the table only ever grows — 271 rows for 215
 * live sessions within days of the idle window shipping. That is not a
 * performance problem at this size, and it is still a table of credentials kept
 * long after they mean anything, which is the sort of thing that only ever
 * looks worse in a breach report.
 *
 * Written because migration 0043's index comment claimed this sweep existed
 * when it did not. A comment describing a job nobody wrote is the same failure
 * as the one that hid the broken backup for five weeks; the honest fix is to
 * make the comment true rather than to soften it.
 *
 * Once an hour, capped, and by age alone so it uses `sessions_last_seen_idx`.
 */
async function sweepDeadSessions() {
  if (new Date().getUTCMinutes() !== 22) return;
  const gone = await withSystem(async (c) => {
    const r = await c.query(
      `delete from sessions
        where id in (
          select id from sessions
           where expires_at < now() - interval '1 day'
              or last_seen_at < now() - interval '30 days'
           limit 5000
        )`
    );
    return r.rowCount ?? 0;
  });
  if (gone) console.log(`[sessions] swept ${gone} dead session(s)`);
}

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
      nextVisitsDue,
      birthdays,
      unpaidInvoices,
      unbookedTreatments,
      treatmentSessionsDue,
      enquiriesNotBooked,
      stockAlerts,
      unansweredConversations,
      sweepStalledRuns,
      sweepEinvoices,
      sweepExpiredDocuments,
      sweepUnsignedDocuments,
      sendPendingDigest,
      dailyBackup,
      opsHealth,
      sweepDeadSessions,
      purgeDeletedClinics,
      sweepLidNumbers,
      deliveryWatch,
      requeueStaleOffers,
      expirePastWaitlist,
      // Registering it here is the ship step: a job written and never added to
      // this array went unnoticed for five weeks once already.
      postRecurringExpenses,
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
