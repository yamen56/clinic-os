/**
 * Telling the operator when the platform itself is in trouble.
 *
 * Every other notification path in this product points at a clinic. This one
 * points at whoever runs Clinicti, and it exists because the failure that
 * matters most is the one nobody is looking at: the nightly backup stopped, and
 * five weeks passed with every screen green, because the only report of it was
 * a line in a log.
 *
 * The monitoring page was the first answer and it is not sufficient. A
 * dashboard that has been green for a month is a dashboard nobody opens, and a
 * safeguard that depends on somebody remembering to check it has the same
 * failure mode as no safeguard at all. This inverts that: the failure comes and
 * finds you.
 *
 * **Not being ignorable is the actual design goal.** An alerter that emails on
 * every tick gets filtered within a day, and a filtered alerter is worse than
 * none — it looks like protection and provides silence. So:
 *
 *   - an alert opens **once** per condition, keyed by the condition and not the
 *     occurrence, so a problem lasting six hours is one email and not 360;
 *   - only conditions that actually need a person are sent at all. This was the
 *     missing half and it cost the design its credibility for a while: between
 *     6 and 8 September 2026 the alerter sent seventeen emails in fifty-five
 *     hours, every one of them a WhatsApp session that dropped and reconnected
 *     by itself, none of them actionable. Dedupe was working perfectly; the
 *     problem was a condition that should never have been mail. See `Severity`;
 *   - it re-notifies on a slow cadence while it persists, so being ignored is
 *     itself escalated;
 *   - it says so explicitly when it **clears**, because "did that fix it?" is
 *     the question you have at 2am and an inbox that only ever complains cannot
 *     answer it;
 *   - and a periodic all-clear proves the alerter is alive, because an alerter
 *     that has quietly died is indistinguishable from a healthy platform. Both
 *     are an empty inbox.
 */
import { withSystem } from "@/lib/db";
import { sendEmail, emailConfigured } from "@/lib/email";
import { backupAgeHours, backupEngineReady } from "@/lib/backup";
import { usingObjectStore, usingBackupVault, backupVaultSharesCredentials } from "@/lib/storage";
import { appUrl } from "@/lib/urls";
import { silenceByClinic, concerning } from "@/lib/whatsapp-health";

/**
 * Whether a condition is worth interrupting somebody for.
 *
 * The distinction this file was missing. Everything above is written around
 * "not being ignorable", and the way an alerter actually becomes ignorable is
 * not sending too many emails about one problem — the dedupe already handles
 * that — but sending any email at all about something that never needed a
 * person. Seventeen in fifty-five hours, all of them a WhatsApp session
 * reconnecting by itself, is enough to teach anybody to filter the sender, and
 * once that rule exists the backup alarm is gone too.
 *
 * `urgent` means somebody has to do something now, and it goes to the inbox.
 * `notice` means it is true, it is worth seeing, and it can wait for whenever
 * the monitoring page is next open.
 */
export type Severity = "urgent" | "notice";

export type Finding = {
  /** Stable per condition, not per occurrence. Reusing it is what dedupes. */
  key: string;
  /** What is wrong, in a sentence somebody half awake can act on. */
  title: string;
  /**
   * The technical detail — what the check saw, the variable to change. Shown
   * last and small: it is for whoever fixes it, not for deciding to.
   */
  detail: string;
  /**
   * Who or what is affected, in plain words: "reminders are not reaching
   * this clinic's patients". Required since 2026-11-27 (Yamen: alerts must
   * "address the problem clearly"), for the same reason as `severity`.
   */
  impact: string;
  /** What to do, in order. One to three steps a person can take now. */
  steps: string[];
  /** The clinic it is about, when it is about one: named in the subject, its owner to call. */
  clinic?: { name: string; slug: string; owner?: string | null; phone?: string | null };
  /** The page that fixes it, under the app. Defaults to /admin/monitoring. */
  link?: string;
  /**
   * Required, and required on purpose.
   *
   * A default would be wrong in both directions: defaulting to `urgent` means a
   * check added later quietly re-noises the inbox, and defaulting to `notice`
   * means one added later is quietly never delivered. Neither failure announces
   * itself. Making it mandatory costs one line per check and forces the
   * question at the only moment anybody has the context to answer it.
   */
  severity: Severity;
};

/**
 * How long a continuing problem waits before it is raised again.
 *
 * Six hours: long enough that a bad night is four emails rather than a wall of
 * them, short enough that something broken on Friday evening has said so
 * several times before Monday.
 */
const RENOTIFY_MS = 6 * 3600_000;

/** How often the all-clear goes out while nothing is wrong. */
const HEARTBEAT_MS = 7 * 24 * 3600_000;

/**
 * Where alerts go.
 *
 * `OPS_ALERT_EMAIL` wins when set, but the fallback is the point: every
 * super-admin account, read from the database. An alerting system that silently
 * does nothing because an environment variable was never set would be the exact
 * failure it was built to prevent, so it is not possible to forget to configure
 * this — only to have no super admins at all.
 */
async function recipients(): Promise<string[]> {
  const configured = (process.env.OPS_ALERT_EMAIL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  return withSystem(async (c) => {
    const r = await c.query(
      `select email from users where is_super_admin and email is not null and email <> ''`
    );
    return r.rows.map((row) => row.email as string);
  });
}

/* ------------------------------------------------------------------ checks */

/**
 * Everything wrong right now, as a flat list.
 *
 * Each check is independent and each failure is contained: a check that throws
 * must not stop the others from reporting, or one broken probe silences the
 * whole system. That is this file's own failure mode, so it is guarded here
 * rather than trusted.
 */
export async function collectFindings(): Promise<Finding[]> {
  const found: Finding[] = [];
  const checks: (() => Promise<Finding[]>)[] = [
    backupChecks,
    jobChecks,
    outboxChecks,
    whatsappChecks,
    silenceChecks,
    storageChecks,
    webChecks,
    appErrorChecks,
    workerCapacityChecks,
  ];
  for (const check of checks) {
    try {
      found.push(...(await check()));
    } catch (e) {
      found.push({
        key: `probe_failed:${check.name}`,
        // Urgent whatever it was probing for: a check that throws is reporting
        // nothing, so the condition it covers is now unmonitored rather than
        // absent, and that is indistinguishable from healthy until it is not.
        severity: "urgent",
        title: `A health check stopped working: ${check.name}`,
        detail: (e as Error).message.slice(0, 300),
        impact: "While it is broken, the problem it watches for would not be reported to you.",
        steps: ["Open Monitoring and read the error below.", "Fix the check or what it reads; this clears on the next pass."],
      });
    }
  }
  return found;
}

/**
 * Whether the archives could survive losing the bucket they protect.
 *
 * DEPLOY.md called this "the gap that is left" and it stayed open: the nightly
 * archives sat in the same bucket as the patient files, and those files exist
 * *only* there — the database backup stores paths, not bytes. Object storage
 * survives hardware failure. It does not survive a deleted bucket or a leaked
 * key, and either one takes the uploads and every archive that could have
 * restored them in the same motion.
 *
 * A notice rather than urgent, deliberately. Nothing is broken today; this is a
 * posture one bad afternoon away from mattering, and it is fixed by setting a
 * variable rather than by waking anybody up.
 */
function vaultChecks(): Finding[] {
  if (!usingBackupVault()) {
    return [
      {
        key: "backup_same_bucket",
        severity: "notice" as const,
        title: "Backups are kept in the same storage bucket as the patient files",
        detail:
          "A deleted bucket or a leaked key would take the uploads and every archive that could " +
          "restore them at the same time. Set BACKUP_S3_BUCKET to keep them apart — see " +
          "DEPLOY.md, Backups.",
        impact: "Nothing is broken today. If that bucket were deleted or its key leaked, the files and the backups would be lost together.",
        steps: ["Create a separate bucket for backups and set BACKUP_S3_BUCKET on the worker (DEPLOY.md, Backups)."],
      },
    ];
  }
  if (backupVaultSharesCredentials()) {
    return [
      {
        key: "backup_shared_credentials",
        severity: "notice" as const,
        title: "The backup bucket uses the app's own storage key",
        detail:
          "That survives somebody emptying the wrong bucket. It does not survive the key itself " +
          "walking out of the running app. Give the vault its own key with " +
          "BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY.",
        impact: "Nothing is broken today. A leaked app key could reach the backups as well as the files.",
        steps: ["Give the backup bucket its own key: set BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY on the worker."],
      },
    ];
  }
  return [];
}

async function backupChecks(): Promise<Finding[]> {
  // Local disk in development is not a backup destination worth alerting on.
  if (!usingObjectStore()) return [];
  const out: Finding[] = [];
  if (!backupEngineReady()) {
    out.push({
      key: "backup_engine",
      severity: "urgent",
      title: "Backups have stopped: the backup engine cannot load",
      detail:
        "backupEngineReady() is false, so the nightly job throws on every tick and no archive " +
        "is being written. This is how backups were lost for five weeks: a runtime import " +
        "failing inside a worker image that installs with --omit=dev.",
      impact: "No nightly backup is being written. If the database were lost now, everything since the last backup would be gone.",
      steps: [
        "Open the worker's logs on Railway and find the import error at start-up.",
        "Fix it and redeploy, then check Monitoring → Database backups shows a new archive.",
      ],
    });
  }
  const age = await backupAgeHours();
  if (age >= 36) {
    out.push({
      key: "backup_stale",
      severity: "urgent",
      title: age === Infinity ? "This database has never been backed up" : `No backup for ${Math.floor(age)} hours`,
      detail: "A nightly archive should never be older than about 24 hours.",
      impact:
        age === Infinity
          ? "If the database were lost now, every clinic's records would be gone."
          : `If the database were lost now, the last ${Math.floor(age)} hours of patient records, appointments and invoices would be gone.`,
      steps: [
        "Check the worker is running (Monitoring → Workers).",
        "Check object storage is reachable, then run `npm run backup:list` to see the newest archive.",
        "This clears by itself once a new backup is written.",
      ],
    });
  }
  // Where the archives are kept, as opposed to whether they are being written.
  out.push(...vaultChecks());
  return out;
}

async function jobChecks(): Promise<Finding[]> {
  const row = await withSystem(async (c) =>
    (
      await c.query(
        `select
           count(*) filter (where status = 'failed' and updated_at > now() - interval '1 hour')::int as failed,
           count(*) filter (where status = 'pending' and run_at < now() - interval '15 minutes')::int as stale
         from jobs`
      )
    ).rows[0]
  );
  const out: Finding[] = [];
  if (Number(row.failed) >= 5) {
    out.push({
      key: "jobs_failing",
      severity: "urgent",
      title: `${row.failed} background jobs failed in the last hour`,
      detail: "AI replies, PDF renders and document filing all run through this queue.",
      impact: "Signed PDFs, AI replies and document filing may not be happening for clinics.",
      steps: ["Open Monitoring → Failed jobs and read the errors.", "Fix the cause, then watch that new jobs succeed."],
    });
  }
  /*
    Backlog, not failure. The slow lane is serial by default
    (`WORKER_SLOW_LANES` is 1), so a queue that stops draining is the shape a
    capacity problem takes here long before anything actually errors.
  */
  if (Number(row.stale) >= 20) {
    out.push({
      key: "jobs_stale",
      severity: "urgent",
      title: `${row.stale} jobs have been waiting more than 15 minutes`,
      detail:
        "The queue is not draining. Either the worker is not processing, or the slow lane is " +
        "saturated.",
      impact: "Reminders, PDFs and AI replies are running late for every clinic.",
      steps: [
        "Check the worker is running and not stuck (Monitoring → Workers).",
        "If it is running but slow, raise WORKER_SLOW_LANES on the worker and redeploy.",
      ],
    });
  }
  return out;
}

/**
 * Faults the application itself is throwing.
 *
 * Everything else in this file watches infrastructure, and infrastructure was
 * never the only way this platform breaks. A server action that throws for one
 * clinic on one screen leaves the database up, the worker breathing, the jobs
 * draining and `/api/health` answering 200 — so every existing check stays
 * green while a receptionist looks at an error page. The only thing that
 * noticed was the clinic.
 *
 * Two shapes, because they mean different things:
 *
 *   - **A new fault**, first seen in the last hour. Worth saying out loud even
 *     once: it almost always means something that just shipped.
 *   - **A fault that is happening a lot**, whatever its age. A slow leak nobody
 *     opened the page to see is the one that quietly costs a customer.
 *
 * Both are notices rather than urgent. An error page for one clinic is bad and
 * is not a dead platform, and the rule this codebase already settled on is that
 * urgent means mail — so wiring application errors to mail would, on the first
 * bad afternoon, teach somebody to ignore the address that also carries "the
 * backups have stopped". These live on /admin/monitoring, which is where the
 * WhatsApp notices already live.
 */
/**
 * How close a worker is to the limits that take its clinics down with it.
 *
 * The per-worker ceiling was an estimate — DEPLOY.md said 60–100 clinics and
 * said plainly that the figure was unmeasured. Worker instances publish what
 * they are actually holding now (0059), so this can be a warning instead of a
 * postmortem.
 *
 * The failure being headed off is specific: a worker that runs out of memory
 * takes every WhatsApp socket it holds down with it, and those come back only
 * when a *person* rescans a QR code for each affected clinic. The warning has
 * to arrive with room to act — which means at a fraction of the limit, not at
 * it.
 *
 * Both thresholds are ratios of numbers the operator sets, and are silent when
 * they are not set. A limit this code invented for itself would either cry wolf
 * on a big container or say nothing on a small one.
 */
async function workerCapacityChecks(): Promise<Finding[]> {
  const memLimit = Number(process.env.WORKER_MEMORY_LIMIT_MB || 0);
  const sessionLimit = Number(process.env.WA_MAX_SESSIONS_PER_WORKER || 0);
  if (!memLimit && !sessionLimit) return [];

  const rows = await withSystem(async (c) =>
    (
      await c.query(
        `select worker_id, sessions, rss_mb
           from worker_instances
          -- Only workers that are still reporting. A stale row is a container
          -- that is gone, and "the dead worker was nearly full" is not news.
          where updated_at > now() - interval '5 minutes'`
      )
    ).rows
  );

  const out: Finding[] = [];
  for (const w of rows) {
    const id = String(w.worker_id).slice(0, 12);
    if (memLimit && Number(w.rss_mb) >= memLimit * 0.8) {
      out.push({
        key: `worker_memory:${w.worker_id}`,
        /*
          Urgent, unlike the other capacity notices, because of what recovery
          costs. An out-of-memory worker drops every socket it holds, and a
          dropped socket is a clinic that needs somebody to stand at a phone and
          rescan a QR code. That is worth an email at 80%.
        */
        severity: "urgent",
        title: `The worker is nearly out of memory (${w.rss_mb} of ${memLimit} MB)`,
        detail: `Worker ${id}, holding ${w.sessions} WhatsApp session(s).`,
        impact: `If it is killed, the ${w.sessions} clinic(s) on it lose WhatsApp until each one scans a new code.`,
        steps: [
          "Raise the worker's memory on Railway,",
          "or set WA_MAX_SESSIONS_PER_WORKER and add a second worker (DEPLOY.md, running more than one worker).",
        ],
      });
    }
    if (sessionLimit && Number(w.sessions) >= sessionLimit * 0.9) {
      out.push({
        key: `worker_sessions:${w.worker_id}`,
        severity: "notice" as const,
        title: `The worker is nearly full (${w.sessions} of ${sessionLimit} WhatsApp numbers)`,
        detail: `Worker ${id}. Another replica picks up the excess within WA_LEASE_TTL_SECONDS.`,
        impact: "A new clinic connecting WhatsApp will have nowhere to go once it is full.",
        steps: ["Add a second worker replica before onboarding more clinics."],
      });
    }
  }
  return out;
}

async function appErrorChecks(): Promise<Finding[]> {
  const rows = await withSystem(async (c) =>
    (
      await c.query(
        `select fingerprint, message, route, count, first_seen
           from app_errors
          where resolved_at is null
            and (first_seen > now() - interval '1 hour' or count >= $1)
          order by count desc
          limit 5`,
        [APP_ERROR_VOLUME]
      )
    ).rows
  );
  return rows.map((r) => ({
    // Per fault, not one lump: two unrelated bugs are two things to fix, and a
    // combined alert would clear the moment either one did.
    key: `app_error:${r.fingerprint}`,
    severity: "notice" as const,
    title:
      Number(r.count) >= APP_ERROR_VOLUME
        ? `An error has fired ${r.count}× — ${String(r.message).slice(0, 80)}`
        : `A new error appeared — ${String(r.message).slice(0, 80)}`,
    detail: (r.route ? `At ${r.route}. ` : "") + String(r.message).slice(0, 300),
    impact: r.route ? `Somebody using ${r.route} may be seeing an error.` : "Somebody may be seeing an error page.",
    steps: ["Open Monitoring → App errors for the full fault and stack.", "Fix it, then mark it resolved there."],
  }));
}

/**
 * How many occurrences make a fault worth reporting on its own.
 *
 * Above the noise an ordinary week produces — a bot probing a public route, one
 * person's flaky connection — and far below what a genuine regression reaches
 * in an afternoon.
 */
const APP_ERROR_VOLUME = Number(process.env.APP_ERROR_VOLUME || 25);

async function outboxChecks(): Promise<Finding[]> {
  const failed = await withSystem(async (c) =>
    Number(
      (
        await c.query(
          `select count(*)::int n from messages
            where status = 'failed' and created_at > now() - interval '1 hour'`
        )
      ).rows[0].n
    )
  );
  if (failed < 10) return [];
  // Which clinics, so the email says whose patients are not being reached.
  const worst = await withSystem(async (c) =>
    (
      await c.query(
        `select coalesce(nullif(cl.name_ar, ''), cl.name) as name, cl.slug, count(*)::int as n
           from messages m join clinics cl on cl.id = m.clinic_id
          where m.status = 'failed' and m.created_at > now() - interval '1 hour'
          group by cl.id order by n desc limit 3`
      )
    ).rows as { name: string; slug: string; n: number }[]
  );
  return [
    {
      key: "outbox_failing",
      // Ten in an hour is not a flaky send, it is a number in trouble — and the
      // window in which anything can be done about that is short.
      severity: "urgent",
      title: `${failed} WhatsApp messages failed to send in the last hour`,
      detail: "Repeated failures also auto-pause a clinic's sending.",
      impact: worst.length
        ? `Reminders and confirmations are not reaching patients at ${worst.map((w) => `${w.name} (${w.n})`).join(", ")}.`
        : "Reminders and confirmations are not reaching patients.",
      steps: [
        "Open Monitoring → WhatsApp sessions and check the clinic(s) named above.",
        "If a number is logged out or restricted, call the clinic.",
      ],
      ...(worst.length === 1 ? { clinic: { name: worst[0].name, slug: worst[0].slug }, link: `/admin/clinics/${worst[0].slug}` } : {}),
    },
  ];
}

/**
 * A clinic whose WhatsApp is meant to be up and is not.
 *
 * Keyed per clinic on purpose. One shared "WhatsApp is down" alert would open
 * on the first clinic and then stay open, hiding every clinic that dropped
 * afterwards behind an alert that had already been sent.
 *
 * The thirty-minute rule this replaces was the single source of every alert
 * email this platform has ever sent in anger, and none of them were actionable.
 * The mistake was treating one status column as one condition when it is two:
 *
 *   - `logged_out` and `qr` **cannot** recover without a person. The session is
 *     gone, Baileys will not get it back, and somebody at the clinic has to scan
 *     a code. Every hour after that is a clinic silently not receiving patient
 *     messages, so a short fuse and an email is right.
 *
 *   - `disconnected` and `connecting` are Baileys being Baileys. It drops and
 *     reconnects by itself several times a day, and did so on every one of the
 *     seventeen occasions it was reported between 6 and 8 September 2026 — each
 *     time clearing within the hour, unaided.
 *
 * So a transient drop is recorded and not sent. What makes that safe rather than
 * merely quiet is the escalation: a socket still "reconnecting" a full day later
 * is not reconnecting, whatever the column says, and at that point it becomes an
 * email regardless of status. The quiet window is the difference between a blip
 * and an outage, which is the judgement the old check never made.
 */
/**
 * Ages are measured from `connected_at` — the last time a socket was actually
 * open — and never from `updated_at`, which cannot work and would have made
 * every threshold below unreachable.
 *
 * A `before update` trigger sets `updated_at := now()` on every write to the
 * row, and a session that is down writes constantly: the reconnect loop backs
 * off to a sixty-second ceiling and calls `setSession({status: "connecting"})`
 * on every attempt, and a displayed QR code rotates every twenty seconds and
 * writes on each rotation. So `updated_at` on a broken session is never more
 * than a minute old, and "down for six hours" measured against it is a
 * condition that can never be true. The old thirty-minute rule only ever fired
 * at all because two of the five statuses happen to go quiet after they are
 * written.
 *
 * `connected_at` is written in exactly one place — the `connection === "open"`
 * handler — and cleared in one, an explicit logout, which also drops `desired`
 * and so leaves the row outside this check entirely.
 */
/** `qr` / `logged_out`: will not recover without a person, so the fuse is short. */
const WA_NEEDS_A_PERSON_HOURS = 1;
/** `disconnected` / `connecting`: below this it is noise, not news. */
const WA_TRANSIENT_HOURS = 6;
/** Above this, "still reconnecting" has stopped being a credible explanation. */
const WA_ESCALATE_HOURS = 24;

// Exported for qa-ops-alert, which drives a real session row through each
// status and age. Going via `collectFindings` would work and would also make
// five HTTP calls to the web app per case; the classification is the part worth
// testing, and it is worth testing directly.
export async function whatsappChecks(): Promise<Finding[]> {
  const rows = await withSystem(async (c) =>
    (
      await c.query(
        `select ws.clinic_id, ws.status, coalesce(nullif(cl.name_ar, ''), cl.name) as name, cl.slug,
                extract(epoch from (now() - ws.connected_at)) / 3600 as hours, ws.connected_at,
                coalesce(cl.phone_e164, ou.phone_e164) as phone, ou.full_name as owner
           from whatsapp_sessions ws
           join clinics cl on cl.id = ws.clinic_id
           -- Who to call: the owner, and the clinic's own number before theirs.
           left join lateral (
             select u.full_name, u.phone_e164 from clinic_members m join users u on u.id = m.user_id
              where m.clinic_id = cl.id and m.is_owner and m.active order by m.created_at limit 1
           ) ou on true
          where ws.desired
            and ws.status <> 'connected'
            -- Never connected is an onboarding state, not an outage: the clinic
            -- has asked for WhatsApp and not finished setting it up, and there
            -- is no "down since" to measure. That is a conversation with them,
            -- not an alarm about the platform.
            and ws.connected_at is not null
            and cl.deleted_at is null
            and cl.subscription_status <> 'suspended'`
      )
    ).rows
  );
  const out: Finding[] = [];
  for (const r of rows) {
    const hours = Number(r.hours);
    const stuck = r.status === "logged_out" || r.status === "qr";
    if (stuck && hours < WA_NEEDS_A_PERSON_HOURS) continue;
    if (!stuck && hours < WA_TRANSIENT_HOURS) continue;
    out.push({
      key: `whatsapp_down:${r.clinic_id}`,
      severity: stuck || hours >= WA_ESCALATE_HOURS ? "urgent" : "notice",
      title: stuck
        ? `${r.name}: WhatsApp is logged out`
        : `${r.name}: WhatsApp disconnected for ${Math.floor(hours)} hours`,
      detail: stuck
        ? `Session status is "${r.status}". It will not recover on its own.`
        : `Session status is "${r.status}". Drops that reconnect by themselves are recorded, not sent; ` +
          `this becomes an email at ${WA_ESCALATE_HOURS} hours, by which point it is not reconnecting.`,
      impact:
        `Since ${fmtWhen(r.connected_at)}, ${r.name} is neither sending nor receiving WhatsApp: ` +
        "reminders, confirmations and patients' messages have stopped.",
      steps: stuck
        ? [
            r.phone ? `Call ${r.owner ?? "the clinic"} on ${r.phone}.` : `Contact ${r.owner ?? "the clinic"}.`,
            "Ask them to open Settings → WhatsApp in Clinicti and scan the code with the clinic's phone.",
            "This clears by itself once it reconnects.",
          ]
        : [
            r.phone ? `Call ${r.owner ?? "the clinic"} on ${r.phone}.` : `Contact ${r.owner ?? "the clinic"}.`,
            "Ask them to check the clinic's phone has internet and WhatsApp open; if it still does not connect, scan the code again from Settings → WhatsApp.",
          ],
      clinic: { name: r.name, slug: r.slug, owner: r.owner, phone: r.phone },
      link: `/admin/clinics/${r.slug}`,
    });
  }
  return out;
}

/**
 * A clinic messaging people who never write back.
 *
 * The closest thing to an early warning for a ban that this system can see.
 * WhatsApp bans on reports and blocks, which Baileys is never told about, so
 * the proxy is outbound going into threads that stay one-sided — the population
 * that reports. See lib/whatsapp-health for why it is thirty days and why it is
 * gated on volume.
 *
 * Worth an alert rather than only a dashboard column because the moment it
 * moves is the moment somebody has started using campaigns on an imported list,
 * and that is a conversation to have before the number is gone rather than
 * after.
 */
async function silenceChecks(): Promise<Finding[]> {
  const rows = await withSystem((c) => silenceByClinic(c, 30));
  return concerning(rows).map((r) => ({
    key: `whatsapp_cold:${r.clinicId}`,
    // A thirty-day trend, and the comment above already says the response is a
    // conversation on a Tuesday. Nothing about it is improved by arriving at 3am.
    severity: "notice" as const,
    title: `${r.name} is messaging people who never reply (${Math.round(r.ratio * 100)}%)`,
    detail: `${r.cold} of ${r.out} outbound messages in the last 30 days went into conversations the patient has never written in.`,
    impact: "Those are the people who report a number, and reports are what get it banned.",
    steps: ["Check whether a campaign or an import is sending to people who never contacted the clinic, and talk to the clinic about it."],
    clinic: { name: r.name, slug: r.slug },
    link: `/admin/clinics/${r.slug}`,
  }));
}

/**
 * A table growing towards being a problem, while there is still time.
 *
 * Measured on 2026-09-06: `whatsapp_auth_state` was 23 MB of a 43 MB database —
 * more than half of everything — for **two** connected clinics. It is Signal
 * protocol material that Baileys writes as it goes: pre-keys, sender keys, LID
 * mappings. Nothing here is a bug and none of it can safely be deleted from
 * outside, because guessing wrong means a clinic rescanning a QR code.
 *
 * What it *is* is a number that scales with clinics and never comes down, and
 * it lands in the nightly archive along with everything else — so the first
 * symptom would be a backup that stopped finishing, discovered on the day it
 * was needed.
 *
 * Reported rather than acted on. The right response is a judgement call about
 * Baileys and retention, and this exists so that call happens on a Tuesday
 * rather than during an incident.
 */
async function storageChecks(): Promise<Finding[]> {
  const rows = await withSystem(async (c) =>
    (
      await c.query(
        `select relname as name, pg_total_relation_size(relid) as bytes
           from pg_stat_user_tables
          where pg_total_relation_size(relid) > $1
          order by bytes desc limit 5`,
        [Number(process.env.TABLE_ALERT_BYTES || 2_000_000_000)]
      )
    ).rows
  );
  return rows.map((r) => ({
    key: `table_large:${r.name}`,
    // "Reported rather than acted on", per the comment above — a table crossing
    // a threshold it took months to reach is the definition of not urgent.
    severity: "notice" as const,
    title: `The ${r.name} table has reached ${(Number(r.bytes) / 1_073_741_824).toFixed(1)} GB`,
    detail: "Every nightly backup copies it.",
    impact: "Nothing is broken. Backups get slower as it grows.",
    steps: ["Check what is accumulating in it and whether any of it can be retired."],
  }));
}

/**
 * The web app, asked of the worker.
 *
 * The two run as separate services, so each can be down while the other is
 * perfectly healthy — and the one holding the scheduler is the one that can
 * tell you. What nothing here can report is the worker being down itself; see
 * the note in DEPLOY.md about the external uptime check that closes that loop.
 */
const WEB_STEPS = [
  "Open app.clinicti.app to confirm.",
  "Check the web service's status and logs on Railway; if a deploy broke it, redeploy the last good commit.",
];

async function webChecks(): Promise<Finding[]> {
  const base = appUrl();
  if (!base) return [];
  try {
    const res = await fetch(`${base}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { ok?: boolean; db?: { ok?: boolean } };
      if (body.ok && body.db?.ok !== false) return [];
      return [
        {
          key: "web_unhealthy",
          severity: "urgent",
          title: "Clinicti is up but reports itself unhealthy",
          detail: `GET ${base}/api/health returned ${JSON.stringify(body).slice(0, 200)}`,
          impact: "Clinics may be unable to open patients, book or take payments.",
          steps: WEB_STEPS,
        },
      ];
    }
    return [
      {
        key: "web_unhealthy",
        severity: "urgent",
        title: `Clinicti is down (HTTP ${res.status})`,
        detail: `GET ${base}/api/health returned ${res.status}.`,
        impact: "Patients and staff cannot use Clinicti.",
        steps: WEB_STEPS,
      },
    ];
  } catch (e) {
    return [
      {
        key: "web_unhealthy",
        severity: "urgent",
        title: "Clinicti cannot be reached",
        detail: `GET ${base}/api/health failed from the worker: ${(e as Error).message.slice(0, 200)}`,
        impact: "Patients and staff probably cannot use Clinicti.",
        steps: WEB_STEPS,
      },
    ];
  }
}

/* ------------------------------------------------------- state and delivery */

/** When, as the agency reads it: Amman time, the day and the hour. */
function fmtWhen(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v ?? ""));
  if (Number.isNaN(d.getTime())) return "a while ago";
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Amman",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d) + " Amman time"
  );
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * One problem, laid out so the first three lines decide what to do (2026-11-27):
 * what is wrong, who it affects, the steps, the page that fixes it — and the
 * technical detail last and small, for whoever does the fixing.
 */
function findingHtml(f: Finding): string {
  const href = `${appUrl() || ""}${f.link ?? "/admin/monitoring"}`;
  return [
    `<h2 style="margin:0 0 8px;font-size:18px;color:#16181C">${esc(f.title)}</h2>`,
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#333"><strong>Who is affected:</strong> ${esc(f.impact)}</p>`,
    `<p style="margin:0 0 4px;font-size:14px;color:#333"><strong>What to do:</strong></p>`,
    `<ol style="margin:0 0 14px;padding-inline-start:20px;font-size:14px;line-height:1.55;color:#333">${f.steps
      .map((s) => `<li>${esc(s)}</li>`)
      .join("")}</ol>`,
    `<p style="margin:0 0 14px"><a href="${esc(href)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#0B1220;color:#fff;text-decoration:none;font-size:14px;font-weight:600">${
      f.clinic ? `Open ${esc(f.clinic.name)}` : "Open Monitoring"
    }</a></p>`,
    `<p style="margin:0 0 20px;font-size:12px;line-height:1.5;color:#888">Technical detail: ${esc(f.detail)}</p>`,
  ].join("");
}

function findingText(f: Finding): string {
  return [
    f.title,
    `Who is affected: ${f.impact}`,
    "What to do:",
    ...f.steps.map((s, i) => `  ${i + 1}. ${s}`),
    `Open: ${appUrl() || ""}${f.link ?? "/admin/monitoring"}`,
    `Technical detail: ${f.detail}`,
  ].join("\n");
}

function wrap(lead: string | null, inner: string): string {
  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px">`,
    lead ? `<p style="margin:0 0 16px;font-size:14px;color:#555">${esc(lead)}</p>` : "",
    inner,
    `<p style="margin:18px 0 0;font-size:12px;color:#888">Clinicti platform monitoring — ${esc(appUrl() || "")}/admin/monitoring</p>`,
    `</div>`,
  ].join("");
}

/** The subject names the clinic and the problem, so the inbox line alone says what is wrong. */
function subjectFor(prefix: string, list: Finding[]): string {
  const first = list[0];
  const more = list.length > 1 ? ` (+${list.length - 1} more)` : "";
  return `${prefix}: ${first.title}${more}`;
}

/** What an alert email for these findings looks like, without sending it — for QA and for reading. */
export function previewAlertEmail(list: Finding[]): { subject: string; html: string; text: string } {
  return {
    subject: subjectFor("Urgent", list),
    html: wrap(list.length > 1 ? `${list.length} things need attention now.` : null, list.map(findingHtml).join("<hr>")),
    text: list.map(findingText).join("\n\n"),
  };
}

async function deliverFindings(subject: string, lead: string | null, list: Finding[]): Promise<void> {
  await send(subject, wrap(lead, list.map(findingHtml).join("<hr style=\"border:0;border-top:1px solid #eee;margin:4px 0 20px\">")), [lead ?? "", ...list.map(findingText)].filter(Boolean).join("\n\n"));
}

/** Plain paragraphs: the clearances, the all-clear, the database that cannot be reached. */
async function deliver(subject: string, title: string, blocks: string[]): Promise<void> {
  await send(
    subject,
    wrap(null, [`<h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>`, ...blocks.map((b) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#333">${esc(b)}</p>`)].join("")),
    [title, "", ...blocks].join("\n")
  );
}

async function send(subject: string, htmlBody: string, text: string): Promise<void> {
  if (!emailConfigured()) {
    console.warn(`[ops] ${subject} (not sent: RESEND_API_KEY is unset)`);
    return;
  }
  const to = await recipients();
  if (!to.length) {
    console.error(`[ops] ${subject} — NOBODY TO TELL: set OPS_ALERT_EMAIL or a super admin`);
    return;
  }
  for (const address of to) {
    const res = await sendEmail({
      to: address,
      subject,
      html: htmlBody,
      text,
    });
    if (!res.ok && !res.skipped) console.error(`[ops] send to ${address} failed: ${res.error}`);
  }
}

/**
 * Compares what is wrong now against what was wrong last time, and tells
 * somebody about the difference.
 *
 * Returns a summary so the caller — and the QA suite — can see what it decided
 * without reading an inbox.
 */
export async function reconcile(
  findings: Finding[],
  /**
   * Which alerts this caller is answerable for.
   *
   * Resolution works by absence — anything open and no longer reported is
   * cleared — which is only correct when the caller looked for *everything*.
   * A second watcher that checks one condition would otherwise resolve every
   * alert it does not know about, silently, and the inbox would say the
   * platform recovered.
   *
   * Omitted means "I checked everything", which is the worker's full pass.
   */
  owns?: (key: string) => boolean
): Promise<{
  opened: string[];
  renotified: string[];
  resolved: string[];
  /** Of the above, the keys that actually caused an email. */
  emailed: string[];
}> {
  const open = await withSystem(async (c) =>
    (await c.query(`select key, title, severity, last_notified, notifications, opened_at from ops_alerts`))
      .rows
  );
  const openByKey = new Map(open.map((r) => [r.key as string, r]));
  const nowKeys = new Set(findings.map((f) => f.key));

  const opened: string[] = [];
  const renotified: string[] = [];
  const resolved: string[] = [];
  /*
    What is written down, versus what is sent. Every finding lands in
    `ops_alerts` and shows up on /admin/monitoring whatever its severity; only
    these three lists reach an inbox.
  */
  const announce: Finding[] = [];
  const persisting: Finding[] = [];

  for (const f of findings) {
    const existing = openByKey.get(f.key);
    if (!existing) {
      /*
        The insert decides whether this is new, not the read above.

        Two watchers can both see no row and both conclude they opened it,
        which is two emails for one problem — and with the web app now watching
        the worker there really are two. `returning` reports only the row this
        statement actually created, so the loser of the race stays quiet.
      */
      const created = await withSystem((c) =>
        c.query(
          `insert into ops_alerts (key, title, detail, severity) values ($1, $2, $3, $4)
           on conflict (key) do nothing
           returning key`,
          [f.key, f.title, f.detail, f.severity]
        )
      );
      if (created.rowCount) {
        opened.push(f.key);
        if (f.severity === "urgent") announce.push(f);
      }
      continue;
    }
    /*
      A condition that has got worse speaks up even though its row is already
      open — this is the WhatsApp escalation arriving, a drop that was recorded
      quietly six hours ago and has now lasted a day. Without this the severity
      split would be a trap: the notice claims the key first, and the outage it
      turns into never gets announced because something is already "open".
    */
    const escalated = existing.severity !== "urgent" && f.severity === "urgent";
    const age = Date.now() - new Date(existing.last_notified).getTime();
    if (escalated || age >= RENOTIFY_MS) {
      await withSystem((c) =>
        c.query(
          `update ops_alerts set last_notified = now(), notifications = notifications + 1,
                                 title = $2, detail = $3, severity = $4
            where key = $1`,
          [f.key, f.title, f.detail, f.severity]
        )
      );
      renotified.push(f.key);
      // An escalation is news, not a reminder, so it reads as one.
      if (f.severity === "urgent") (escalated ? announce : persisting).push(f);
      continue;
    }
    /*
      Nothing to send, but the row still has to describe what is true now.

      Titles move while a condition persists — the hour count in a WhatsApp
      drop climbs every pass — and severity can fall, when a session comes back
      as `disconnected` after having been `logged_out`. Leaving a stale
      `urgent` on the row would mean the eventual resolve sends a clearance
      email for something that stopped being urgent hours earlier.
    */
    if (existing.severity !== f.severity || existing.title !== f.title) {
      await withSystem((c) =>
        c.query(`update ops_alerts set title = $2, detail = $3, severity = $4 where key = $1`, [
          f.key,
          f.title,
          f.detail,
          f.severity,
        ])
      );
    }
  }

  for (const row of open) {
    if (nowKeys.has(row.key)) continue;
    // Never clear somebody else's alert just because this pass did not look for it.
    if (owns && !owns(row.key)) continue;
    await withSystem((c) => c.query(`delete from ops_alerts where key = $1`, [row.key]));
    resolved.push(row.key);
  }

  /*
    One email per transition group rather than one per alert. Three clinics
    dropping WhatsApp in the same minute is one situation, and three separate
    emails about it is the beginning of the filter rule that makes all of this
    pointless.
  */
  if (announce.length) {
    await deliverFindings(
      subjectFor("Urgent", announce),
      announce.length > 1 ? `${announce.length} things need attention now.` : null,
      announce
    );
  }
  if (persisting.length) {
    await deliverFindings(
      subjectFor("Still unresolved", persisting),
      `Reported earlier and still true. ${persisting.length === 1 ? "It" : "Each"} was first seen ${persisting
        .map((f) => fmtWhen(openByKey.get(f.key)?.opened_at))
        .join(", ")}.`,
      persisting
    );
  }
  /*
    Only clear what was announced in the first place.

    "Did that fix it?" is a real question and worth an email, but it is only a
    question you have about something that woke you up. A clearance for an alert
    that was never sent is an email reporting the end of a situation the reader
    was never told had started — which was half of the seventeen.
  */
  const cleared = resolved.filter((k) => openByKey.get(k)?.severity === "urgent");
  if (cleared.length) {
    const titles = cleared.map((k) => openByKey.get(k)?.title ?? k);
    const lasted = (k: string) => {
      const at = openByKey.get(k)?.opened_at;
      const h = at ? (Date.now() - new Date(at).getTime()) / 3_600_000 : NaN;
      return Number.isFinite(h) ? (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h.toFixed(h < 10 ? 1 : 0)} h`) : "";
    };
    await deliver(
      cleared.length === 1 ? `Resolved: ${titles[0]}` : `Resolved: ${titles[0]} (+${cleared.length - 1} more)`,
      cleared.length === 1 ? "Fixed — nothing more to do" : `${cleared.length} problems fixed — nothing more to do`,
      cleared.map((k, i) => `${titles[i]}${lasted(k) ? ` — lasted ${lasted(k)}` : ""}.`)
    );
  }

  return {
    opened,
    renotified,
    resolved,
    emailed: [...announce.map((f) => f.key), ...persisting.map((f) => f.key), ...cleared],
  };
}

/**
 * The all-clear, on a slow cadence.
 *
 * This is the check on the checker. Everything above only ever speaks when
 * something is wrong, which means a crashed scheduler, an unset API key or a
 * broken probe all present as a quiet inbox — the same quiet inbox as a healthy
 * platform. A weekly "nothing is wrong, and here is the evidence" is what turns
 * silence into information.
 */
export async function heartbeat(openCount: number): Promise<boolean> {
  const last = await withSystem(async (c) =>
    (await c.query(`select value from ops_state where key = 'heartbeat_at'`)).rows[0]
  );
  const lastMs = last ? Number(last.value) : 0;
  if (Date.now() - lastMs < HEARTBEAT_MS) return false;

  const age = await backupAgeHours().catch(() => Infinity);
  const backupLine =
    age === Infinity ? "no backup on record" : `newest backup ${Math.floor(age)}h old`;

  await withSystem((c) =>
    c.query(
      `insert into ops_state (key, value, updated_at) values ('heartbeat_at', $1, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [String(Date.now())]
    )
  );
  // Skipped on the very first run: that one would only report that this feature
  // was just deployed, which the deploy already said.
  if (!lastMs) return false;

  await deliver(
    "Clinicti: weekly all-clear",
    openCount ? `${openCount} open item(s), none urgent` : "Nothing needs attention",
    [
      `Backups: ${backupLine}.`,
      `Open items on Monitoring: ${openCount}${openCount ? " — notices only; anything urgent would have been emailed" : ""}.`,
      "This message exists so that silence from this address means the monitoring is alive, " +
        "rather than that it stopped running.",
    ]
  );
  return true;
}

/**
 * One pass: look, compare, tell, and prove aliveness.
 *
 * The database is the one dependency that cannot be checked from inside a
 * function that stores its state there — so a failure to reach it is reported
 * straight out, deduplicated in memory only. That is weaker than the rest of
 * this file and it is the best available: the alternative is that the single
 * most serious failure is the one condition that cannot raise an alert.
 */
/**
 * The web app keeping an eye on the worker.
 *
 * Everything else in this file runs *in* the worker, so the one failure it can
 * never report is its own. On 2026-09-05 it crash-looped for a day and the
 * first anyone knew came from Railway.
 *
 * GitHub Actions closes that loop from outside, and measurement says it closes
 * it slowly: its five-minute schedule actually delivered two runs four and a half
 * hours apart, because scheduled workflows on a free public repository are
 * throttled hard. That is a fine backstop for "everything is down" and far too
 * slow for "the worker died at 3am".
 *
 * So the two services watch each other. The worker checks the web app
 * (`webChecks`); this checks the worker, from the web container, every few
 * minutes. Between them the only unreported failure is both dying at once —
 * which is what the slow external watcher is for.
 *
 * Scoped to its own key. `reconcile` clears anything open that a pass did not
 * report, and this pass looks at exactly one thing.
 */
const WORKER_KEY = "worker_down";

export async function watchdogPass(): Promise<Finding[]> {
  const row = await withSystem(async (c) =>
    (
      await c.query(
        `select extract(epoch from (now() - updated_at)) * 1000 as idle_ms from worker_status where id = true`
      )
    ).rows[0]
  );
  // No row at all means this environment has never run a worker — a fresh
  // deployment, not a dead one. Saying nothing is the honest answer.
  if (!row?.idle_ms) return [];
  const idleMs = Number(row.idle_ms);
  if (idleMs < WORKER_SILENT_MS) return [];
  return [
    {
      key: WORKER_KEY,
      severity: "urgent",
      title: `The worker has stopped (silent for ${Math.round(idleMs / 60_000)} minutes)`,
      detail:
        "It rewrites its heartbeat every 60 seconds whether or not it has work, so the process is " +
        "not running. A crash loop leaves no trace in the deploy status.",
      impact: "WhatsApp is down for every clinic: no reminders, no replies to patients, no signed PDFs.",
      steps: ["Open the worker's logs (`npm run logs`) and find why it stopped.", "Restart or redeploy it; this clears once its heartbeat returns."],
    },
  ];
}

/** Five missed beats, matching /api/health so the two never disagree. */
const WORKER_SILENT_MS = 5 * 60_000;

export async function runWatchdog(): Promise<void> {
  try {
    await reconcile(await watchdogPass(), (key) => key === WORKER_KEY);
  } catch (e) {
    console.error("[ops watchdog]", (e as Error).message);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __cosWatchdog: NodeJS.Timeout | undefined;
}

/**
 * Starts the watchdog timer in the web process, once.
 *
 * Armed from `/api/health` rather than from `instrumentation.ts`, and that is a
 * scar rather than a preference. Next compiles instrumentation for **every**
 * runtime, and `src/middleware.ts` means there is an Edge build; the Edge
 * compiler follows the imports behind a `NEXT_RUNTIME` check — which is
 * evaluated far too late to help — straight into `pg`, and the build dies on
 * `Can't resolve 'fs'`. Putting the dynamic import behind a second module did
 * not help either; the tracer walks that too.
 *
 * A route handler runs on Node and already imports `pg`, so there is nothing to
 * confuse. The arming path is well travelled: the worker polls this endpoint
 * every five minutes and the external probe polls it too. Once the interval
 * exists it runs on its own, so the worker dying afterwards is exactly the case
 * it still covers.
 */
export function ensureWatchdog(): void {
  if (globalThis.__cosWatchdog) return;
  const everyMs = Math.max(60_000, Number(process.env.WATCHDOG_INTERVAL_MS) || 5 * 60_000);
  const timer = setInterval(() => void runWatchdog(), everyMs);
  // Must never hold the process open on the watchdog's account.
  timer.unref?.();
  globalThis.__cosWatchdog = timer;
  console.log(`[web] worker watchdog armed, every ${Math.round(everyMs / 1000)}s`);
}

let dbDownSince = 0;
export async function opsWatch(): Promise<void> {
  try {
    const findings = await collectFindings();
    await reconcile(findings);
    await heartbeat(findings.length);
    if (dbDownSince) {
      dbDownSince = 0;
      await deliver("Resolved: the database is reachable again", "Fixed — nothing more to do", [
        "The monitor reached the database again and finished a full pass.",
      ]);
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[ops] watch failed:", msg);
    // Once per six hours, not once per tick, and without touching the database
    // — which is exactly what is not working.
    if (Date.now() - dbDownSince < RENOTIFY_MS) return;
    dbDownSince = Date.now();
    await deliver("Urgent: the database cannot be reached", "The database cannot be reached", [
      "Who is affected: if the web app is failing too, every clinic is down — nobody can open patients, book or take payments.",
      "What to do: 1. Open app.clinicti.app to see whether clinics are affected. 2. Check Postgres-EU on Railway (memory, restarts, connections) and the pooler.",
      `Technical detail: the worker could not complete a health pass — ${msg.slice(0, 300)}`,
    ]).catch(() => {});
  }
}
