import { guardAdminCap } from "@/lib/guard";
import { withSystem } from "@/lib/db";
import { getDict, getLocale } from "@/lib/i18n";
import { fmtRelative } from "@/lib/dates";
import { storageUsage } from "@/lib/storage";
import { backupAgeHours, listBackupDetails } from "@/lib/backup";
import { publicLoad } from "@/lib/public-guard";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Activity, HardDrive, MessageCircle, Sparkles, AlertTriangle, DatabaseBackup, ShieldAlert } from "lucide-react";

import { internalSecret } from "@/lib/internal-secret";

const WORKER_URL = process.env.WORKER_URL || "http://localhost:4020";
const SECRET = () => internalSecret();

/**
 * Where the archives actually live, said on the page.
 *
 * The bucket name, not the endpoint or any key — enough for whoever is holding
 * the pager to know which door to open, and nothing that helps somebody who
 * should not be opening it. Falls back to the local driver's wording in dev.
 */
const BUCKET_HINT = process.env.S3_BUCKET
  ? `object storage: ${process.env.S3_BUCKET}/_system/backups/`
  : "local disk: ./storage/_system/backups/";

async function workerHealth(): Promise<{
  ok: boolean;
  sessions: { clinicId: string; connected: boolean }[];
  uptime?: number;
  /** Whether the worker can actually load the backup engine. Undefined = old build. */
  backupReady?: boolean;
}> {
  try {
    const res = await fetch(`${WORKER_URL}/health`, {
      headers: { "x-internal-secret": SECRET() },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { ok: false, sessions: [] };
    return { ok: true, ...(await res.json()) };
  } catch {
    return { ok: false, sessions: [] };
  }
}

export default async function MonitoringPage() {
  await guardAdminCap("monitoring");
  const t = await getDict();
  const locale = await getLocale();
  const health = await workerHealth();

  const data = await withSystem(async (c) => {
    const clinics = (
      await c.query(
        `select cl.id, cl.name, cl.name_ar, cl.slug, cl.subscription_status,
                ws.status as wa_status, ws.phone_number, ws.outbound_today, ws.consecutive_errors,
                ws.paused_until, cl.daily_outbound_cap,
                (select count(*) from automation_runs r where r.clinic_id = cl.id and r.status = 'failed'
                   and r.started_at > now() - interval '7 days')::int as failed_runs,
                (select count(*) from messages m where m.clinic_id = cl.id and m.status = 'failed'
                   and m.created_at > now() - interval '7 days')::int as failed_msgs,
                (select max(created_at) from audit_log al where al.clinic_id = cl.id) as last_activity,
                coalesce((select sum(messages_out) from ai_usage a where a.clinic_id = cl.id
                   and a.day > current_date - 30), 0)::int as ai_msgs,
                coalesce((select sum(input_tokens + output_tokens) from ai_usage a where a.clinic_id = cl.id
                   and a.day > current_date - 30), 0)::bigint as ai_tokens
         from clinics cl
         left join whatsapp_sessions ws on ws.clinic_id = cl.id
         order by cl.created_at`
      )
    ).rows;

    const [jobs] = (
      await c.query(
        `select
           count(*) filter (where j.status = 'pending')::int as pending,
           count(*) filter (where j.status = 'failed')::int as failed,
           count(*) filter (where j.status = 'running')::int as running,
           count(*) filter (where j.status = 'pending' and j.run_at < now() - interval '5 minutes')::int as stale
         from jobs j`
      )
    ).rows;

    const failedJobs = (
      await c.query(
        `select j.kind, j.last_error, j.attempts, j.updated_at, cl.slug
         from jobs j left join clinics cl on cl.id = j.clinic_id
         where j.status = 'failed' order by j.updated_at desc limit 10`
      )
    ).rows;

    const outbox = (
      await c.query(
        `select count(*) filter (where status = 'queued')::int as queued,
                count(*) filter (where status = 'failed')::int as failed
         from messages where created_at > now() - interval '7 days'`
      )
    ).rows[0];

    return { clinics, jobs, failedJobs, outbox };
  });

  const usage = await storageUsage();
  const storageMb = (usage.truncated ? "≥" : "") + (usage.bytes / 1024 / 1024).toFixed(1);

  /*
    How long ago the database was last backed up, on the page somebody actually
    looks at.

    Worth a tile of its own because the failure this catches is invisible
    everywhere else: backups stopped for five weeks and every screen in the
    product carried on looking perfectly healthy. A number that goes red is the
    difference between finding that out today and finding it out the morning you
    need the archive.
  */
  const backups = (await listBackupDetails().catch(() => [])).slice(-10).reverse();
  const backupAge = await backupAgeHours().catch(() => Infinity);
  /*
    Two different questions, and the second is the one that went unanswered for
    five weeks: how long since the last archive, and whether the worker could
    even make one. A worker that cannot load the backup engine reports a stale
    age *eventually*; it reports `backupReady: false` immediately.
  */
  const engineDown = health.ok && health.backupReady === false;
  const load = publicLoad();
  const backupLabel = engineDown
    ? "engine down"
    : backupAge === Infinity
      ? "never"
      : backupAge < 48
        ? `${Math.floor(backupAge)}h ago`
        : `${Math.floor(backupAge / 24)}d ago`;

  return (
    <>
      <PageHeader
        title={t.admin.monitoring}
        action={
          <Badge status={health.ok ? "confirmed" : "no_show"} dot>
            {health.ok
              ? `Worker up · ${Math.floor((health.uptime ?? 0) / 60)}m`
              : "Worker unreachable"}
          </Badge>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
        {[
          { icon: <Activity className="h-4 w-4" />, label: "Jobs pending", value: data.jobs.pending, warn: data.jobs.stale > 0 },
          { icon: <AlertTriangle className="h-4 w-4" />, label: "Jobs failed", value: data.jobs.failed, warn: data.jobs.failed > 0 },
          { icon: <MessageCircle className="h-4 w-4" />, label: "Outbox queued", value: data.outbox.queued, warn: data.outbox.failed > 0 },
          { icon: <HardDrive className="h-4 w-4" />, label: "Storage (MB)", value: storageMb, warn: false },
          {
            icon: <DatabaseBackup className="h-4 w-4" />,
            label: "Last backup",
            value: backupLabel,
            // A day and a half: past a missed nightly run, before a second one.
            warn: backupAge >= 36 || engineDown,
          },
          {
            /*
              Anonymous work in flight, against the share of the connection pool
              it is allowed — see lib/public-guard. The number to read is the
              second one: requests shed since boot. Zero is the normal state, so
              anything else means the booking or signing links are being hit
              harder than the pool can serve, which is what an attack looks like
              from in here. It counts this replica only.
            */
            icon: <ShieldAlert className="h-4 w-4" />,
            label: "Public load",
            value: `${load.inFlight}/${load.max}${load.shed ? ` · ${load.shed} shed` : ""}`,
            warn: load.shed > 0,
          },
        ].map((s, i) => (
          <Card key={i} className="p-4">
            <div className="flex items-center gap-1.5 text-[13px] text-ink-500">
              {s.icon}
              {s.label}
            </div>
            <div className={`mt-1 text-2xl font-semibold tnum ${s.warn ? "text-danger" : ""}`}>
              {s.value}
            </div>
          </Card>
        ))}
      </div>

      <Card className="mb-4">
        <CardHeader title="WhatsApp sessions & AI spend" sub="Per clinic, last 30 days" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 text-start font-semibold">Clinic</th>
                <th className="px-3 py-2 text-start font-semibold">WhatsApp</th>
                <th className="px-3 py-2 text-end font-semibold">Sent today</th>
                <th className="px-3 py-2 text-end font-semibold">AI replies</th>
                <th className="px-3 py-2 text-end font-semibold">AI tokens</th>
                <th className="px-3 py-2 text-start font-semibold">Errors</th>
                <th className="px-5 py-2 text-start font-semibold">{t.admin.lastActivity}</th>
              </tr>
            </thead>
            <tbody>
              {data.clinics.map((cl) => {
                const live = health.sessions.find((s) => s.clinicId === cl.id);
                const paused = cl.paused_until && new Date(cl.paused_until) > new Date();
                return (
                  <tr key={cl.id} className="border-b border-line last:border-0">
                    <td className="px-5 py-2.5">
                      <Link href={`/admin/clinics/${cl.slug}`} className="font-medium hover:text-brand-700">
                        {cl.name_ar || cl.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge status={cl.wa_status === "connected" ? "confirmed" : "no_show"} dot>
                        {cl.wa_status ?? "—"}
                      </Badge>
                      {live && !live.connected && <span className="ms-1 text-[11px] text-st-pending">(worker: down)</span>}
                      {paused && <Badge status="pending">paused</Badge>}
                    </td>
                    <td className="px-3 py-2.5 text-end tnum">
                      {cl.outbound_today ?? 0}
                      <span className="text-ink-400">/{cl.daily_outbound_cap}</span>
                    </td>
                    <td className="px-3 py-2.5 text-end tnum">{cl.ai_msgs}</td>
                    <td className="px-3 py-2.5 text-end tnum">{Number(cl.ai_tokens).toLocaleString("en-GB")}</td>
                    <td className="px-3 py-2.5">
                      {cl.failed_runs > 0 && <Badge status="danger">{cl.failed_runs} runs</Badge>}
                      {cl.failed_msgs > 0 && <Badge status="danger">{cl.failed_msgs} msgs</Badge>}
                      {cl.consecutive_errors > 0 && <Badge status="pending">{cl.consecutive_errors} wa</Badge>}
                      {!cl.failed_runs && !cl.failed_msgs && !cl.consecutive_errors && (
                        <span className="text-ink-300">—</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-[13px] text-ink-500" suppressHydrationWarning>
                      {cl.last_activity ? fmtRelative(cl.last_activity, locale) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {data.failedJobs.length > 0 && (
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-danger" />
                Failed jobs
              </span>
            }
          />
          <ul className="divide-y divide-line">
            {data.failedJobs.map((j, i) => (
              <li key={i} className="px-5 py-2.5 text-[13px]">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{j.kind}</span>
                  {j.slug && <Badge status="neutral">{j.slug}</Badge>}
                  <span className="text-ink-400">· {j.attempts} attempts</span>
                </div>
                <div className="mt-0.5 truncate text-ink-500">{j.last_error}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
        The archives themselves, not just how old the newest one is.

        Deliberately a list and not a download. Every one of these files is
        every patient record in every clinic, and a button here would make the
        whole database one compromised admin session away from walking out of
        the building. Seeing that last night's ran, and that it is a plausible
        size, is what this page is for; fetching one is a deliberate act with
        the storage credentials, written down in DEPLOY.md.
      */}
      <Card className="mt-4">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <DatabaseBackup className="h-4 w-4 text-brand-600" />
              Database backups
            </span>
          }
          sub={`Nightly, kept 14 days plus one a month for a year · ${BUCKET_HINT}`}
        />
        {backups.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-danger">
            No archives at all. The database is not backed up.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {backups.map((b) => (
              <li key={b.key} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[13px]">
                <span className="truncate font-mono text-[12px]">{b.name}</span>
                <span className="flex shrink-0 items-center gap-3 text-ink-500">
                  {/*
                    A size worth reading: an archive that suddenly weighs a
                    fraction of the one before it is the shape of a dump that
                    stopped halfway, and no age check would notice.
                  */}
                  <span className="tnum">{(b.bytes / 1048576).toFixed(2)} MB</span>
                  <span className="tnum text-ink-400">
                    {b.takenAt ? fmtRelative(b.takenAt.toISOString(), locale) : "—"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {data.clinics.some((c) => Number(c.ai_tokens) > 0) && (
        <Card className="mt-4">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-brand-600" />
                AI spend
              </span>
            }
            sub="Tokens across all clinics, last 30 days"
          />
          <div className="px-5 py-4 text-2xl font-semibold tnum">
            {data.clinics
              .reduce((s, c) => s + Number(c.ai_tokens), 0)
              .toLocaleString("en-GB")}
          </div>
        </Card>
      )}
    </>
  );
}
