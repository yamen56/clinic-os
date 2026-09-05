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

export type Finding = {
  /** Stable per condition, not per occurrence. Reusing it is what dedupes. */
  key: string;
  title: string;
  detail: string;
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
    webChecks,
  ];
  for (const check of checks) {
    try {
      found.push(...(await check()));
    } catch (e) {
      found.push({
        key: `probe_failed:${check.name}`,
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
 * Thirty minutes, because Baileys reconnects on its own routinely and alerting
 * on every blip is how an operator learns to ignore the sender.
 */
async function whatsappChecks(): Promise<Finding[]> {
  const rows = await withSystem(async (c) =>
    (
      await c.query(
        `select ws.clinic_id, ws.status, cl.name, cl.slug
           from whatsapp_sessions ws
           join clinics cl on cl.id = ws.clinic_id
          where ws.desired
            and ws.status <> 'connected'
            and ws.updated_at < now() - interval '30 minutes'
            and cl.deleted_at is null
            and cl.subscription_status <> 'suspended'`
      )
    ).rows
  );
  return rows.map((r) => ({
    key: `whatsapp_down:${r.clinic_id}`,
    title: `${r.name} has been disconnected from WhatsApp for over 30 minutes`,
    detail:
      `Session status is "${r.status}". The clinic is not sending or receiving messages. ` +
      `If it reads "logged_out" or "qr", somebody at the clinic has to rescan the code.`,
  }));
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
    title: `${r.name} is messaging people who never reply (${Math.round(r.ratio * 100)}%)`,
    detail:
      `${r.cold} of ${r.out} outbound messages in the last 30 days went into conversations the ` +
      `patient has never written in. That is the population that reports a number, and reports ` +
      `are what get it banned. Check whether a campaign or an import is sending to people who ` +
      `never contacted the clinic.`,
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
          title: "The web app is answering but reports itself unhealthy",
          detail: `GET ${base}/api/health returned ${JSON.stringify(body).slice(0, 200)}`,
        },
      ];
    }
    return [
      {
        key: "web_unhealthy",
        title: `The web app returned HTTP ${res.status}`,
        detail: `GET ${base}/api/health — patients and staff cannot use the product.`,
      },
    ];
  } catch (e) {
    return [
      {
        key: "web_unhealthy",
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
  findings: Finding[]
): Promise<{ opened: string[]; renotified: string[]; resolved: string[] }> {
  const open = await withSystem(async (c) =>
    (await c.query(`select key, title, last_notified, notifications from ops_alerts`)).rows
  );
  const openByKey = new Map(open.map((r) => [r.key as string, r]));
  const nowKeys = new Set(findings.map((f) => f.key));

  const opened: string[] = [];
  const renotified: string[] = [];
  const resolved: string[] = [];

  for (const f of findings) {
    const existing = openByKey.get(f.key);
    if (!existing) {
      await withSystem((c) =>
        c.query(
          `insert into ops_alerts (key, title, detail) values ($1, $2, $3)
           on conflict (key) do nothing`,
          [f.key, f.title, f.detail]
        )
      );
      opened.push(f.key);
      continue;
    }
    const age = Date.now() - new Date(existing.last_notified).getTime();
    if (age >= RENOTIFY_MS) {
      await withSystem((c) =>
        c.query(
          `update ops_alerts set last_notified = now(), notifications = notifications + 1,
                                 title = $2, detail = $3
            where key = $1`,
          [f.key, f.title, f.detail]
        )
      );
      renotified.push(f.key);
    }
  }

  for (const row of open) {
    if (nowKeys.has(row.key)) continue;
    await withSystem((c) => c.query(`delete from ops_alerts where key = $1`, [row.key]));
    resolved.push(row.key);
  }

  /*
    One email per transition group rather than one per alert. Three clinics
    dropping WhatsApp in the same minute is one situation, and three separate
    emails about it is the beginning of the filter rule that makes all of this
    pointless.
  */
  const newOnes = findings.filter((f) => opened.includes(f.key));
  if (newOnes.length) {
    await deliver(
      newOnes.length === 1 ? `Clinicti: ${newOnes[0].title}` : `Clinicti: ${newOnes.length} problems`,
      newOnes.length === 1 ? newOnes[0].title : `${newOnes.length} things need attention`,
      newOnes.flatMap((f) => (newOnes.length === 1 ? [f.detail] : [`${f.title} — ${f.detail}`]))
    );
  }
  const again = findings.filter((f) => renotified.includes(f.key));
  if (again.length) {
    await deliver(
      `Clinicti: still unresolved (${again.length})`,
      "These were reported earlier and are still true",
      again.map((f) => `${f.title} — ${f.detail}`)
    );
  }
  if (resolved.length) {
    const titles = resolved.map((k) => openByKey.get(k)?.title ?? k);
    await deliver(
      resolved.length === 1 ? `Clinicti: resolved — ${titles[0]}` : `Clinicti: ${resolved.length} resolved`,
      "Cleared",
      titles.map((t) => `No longer true: ${t}`)
    );
  }

  return { opened, renotified, resolved };
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
