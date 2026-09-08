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
import { usingObjectStore } from "@/lib/storage";
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
  title: string;
  detail: string;
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
        title: `The "${check.name}" health check is itself failing`,
        detail: (e as Error).message.slice(0, 300),
      });
    }
  }
  return found;
}

async function backupChecks(): Promise<Finding[]> {
  // Local disk in development is not a backup destination worth alerting on.
  if (!usingObjectStore()) return [];
  const out: Finding[] = [];
  if (!backupEngineReady()) {
    out.push({
      key: "backup_engine",
      severity: "urgent",
      title: "The backup engine will not load in this process",
      detail:
        "backupEngineReady() is false, so the nightly job throws on every tick and no archive " +
        "is being written. This is how backups were lost for five weeks: a runtime import " +
        "failing inside a worker image that installs with --omit=dev.",
    });
  }
  const age = await backupAgeHours();
  if (age >= 36) {
    out.push({
      key: "backup_stale",
      severity: "urgent",
      title:
        age === Infinity
          ? "This database has never been backed up"
          : `The newest backup is ${Math.floor(age)} hours old`,
      detail:
        "A nightly archive should never be older than about 24 hours. Check the worker is " +
        "running and that object storage is reachable, then run `npm run backup:list`.",
    });
  }
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
      detail:
        "AI replies, PDF renders and document filing all run through this queue. " +
        "See the failed-jobs table on /admin/monitoring for the errors.",
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
        "saturated — raising WORKER_SLOW_LANES is the immediate lever.",
    });
  }
  return out;
}

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
  return [
    {
      key: "outbox_failing",
      // Ten in an hour is not a flaky send, it is a number in trouble — and the
      // window in which anything can be done about that is short.
      severity: "urgent",
      title: `${failed} WhatsApp messages failed to send in the last hour`,
      detail:
        "Reminders and confirmations are not reaching patients. Check the affected clinic's " +
        "session on /admin/monitoring — repeated failures also auto-pause sending.",
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
        `select ws.clinic_id, ws.status, cl.name, cl.slug,
                extract(epoch from (now() - ws.connected_at)) / 3600 as hours
           from whatsapp_sessions ws
           join clinics cl on cl.id = ws.clinic_id
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
        ? `${r.name} is logged out of WhatsApp and needs the code rescanned`
        : `${r.name} has been disconnected from WhatsApp for ${Math.floor(hours)} hours`,
      detail: stuck
        ? `Session status is "${r.status}". This will not recover on its own — somebody at the ` +
          `clinic has to open the WhatsApp settings for /c/${r.slug} and scan the code. Until ` +
          `they do, the clinic is neither sending nor receiving.`
        : `Session status is "${r.status}". Baileys drops and reconnects by itself several times ` +
          `a day, so this is recorded rather than sent; it becomes an email at ` +
          `${WA_ESCALATE_HOURS} hours, by which point it is not reconnecting.`,
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
    detail:
      `${r.cold} of ${r.out} outbound messages in the last 30 days went into conversations the ` +
      `patient has never written in. That is the population that reports a number, and reports ` +
      `are what get it banned. Check whether a campaign or an import is sending to people who ` +
      `never contacted the clinic.`,
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
    detail:
      "Every nightly backup copies it, so this shows up as a slower dump long before it shows " +
      "up as anything else. Check what is accumulating and whether any of it can be retired.",
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
          title: "The web app is answering but reports itself unhealthy",
          detail: `GET ${base}/api/health returned ${JSON.stringify(body).slice(0, 200)}`,
        },
      ];
    }
    return [
      {
        key: "web_unhealthy",
        severity: "urgent",
        title: `The web app returned HTTP ${res.status}`,
        detail: `GET ${base}/api/health — patients and staff cannot use the product.`,
      },
    ];
  } catch (e) {
    return [
      {
        key: "web_unhealthy",
        severity: "urgent",
        title: "The web app is unreachable from the worker",
        detail: `GET ${base}/api/health failed: ${(e as Error).message.slice(0, 200)}`,
      },
    ];
  }
}

/* ------------------------------------------------------- state and delivery */

function plain(lines: string[]): string {
  return lines.join("\n");
}

function html(title: string, blocks: string[]): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px">`,
    `<h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>`,
    ...blocks.map(
      (b) =>
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#333">${esc(b)}</p>`
    ),
    `<p style="margin:18px 0 0;font-size:12px;color:#888">Clinicti platform monitoring — ${esc(
      appUrl() || ""
    )}/admin/monitoring</p>`,
    `</div>`,
  ].join("");
}

async function deliver(subject: string, title: string, blocks: string[]): Promise<void> {
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
      html: html(title, blocks),
      text: plain([title, "", ...blocks]),
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
    (await c.query(`select key, title, severity, last_notified, notifications from ops_alerts`))
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
    await deliver(
      announce.length === 1
        ? `Clinicti: ${announce[0].title}`
        : `Clinicti: ${announce.length} problems`,
      announce.length === 1 ? announce[0].title : `${announce.length} things need attention`,
      announce.flatMap((f) => (announce.length === 1 ? [f.detail] : [`${f.title} — ${f.detail}`]))
    );
  }
  if (persisting.length) {
    await deliver(
      `Clinicti: still unresolved (${persisting.length})`,
      "These were reported earlier and are still true",
      persisting.map((f) => `${f.title} — ${f.detail}`)
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
    await deliver(
      cleared.length === 1
        ? `Clinicti: resolved — ${titles[0]}`
        : `Clinicti: ${cleared.length} resolved`,
      "Cleared",
      titles.map((t) => `No longer true: ${t}`)
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
    "Nothing needs attention",
    [
      `Open alerts: ${openCount}.`,
      `Backups: ${backupLine}.`,
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
      title: `The worker has been silent for ${Math.round(idleMs / 60_000)} minutes`,
      detail:
        "It rewrites its heartbeat every 60 seconds whether or not it has work, so this means " +
        "the process is not running. WhatsApp is down for every clinic, reminders are not going " +
        "out and nothing is being rendered. Check `npm run logs` — a crash loop leaves no trace " +
        "in the deploy status.",
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
      await deliver("Clinicti: resolved — database reachable again", "Cleared", [
        "The database is answering again.",
      ]);
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[ops] watch failed:", msg);
    // Once per six hours, not once per tick, and without touching the database
    // — which is exactly what is not working.
    if (Date.now() - dbDownSince < RENOTIFY_MS) return;
    dbDownSince = Date.now();
    await deliver("Clinicti: the platform monitor cannot reach the database", "Database", [
      `The worker could not complete a health pass: ${msg.slice(0, 300)}`,
      "If the web app is also failing, this is an outage rather than a blip.",
    ]).catch(() => {});
  }
}
