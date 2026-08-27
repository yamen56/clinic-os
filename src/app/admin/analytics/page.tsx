import Link from "next/link";
import { guardAdminCap } from "@/lib/guard";
import { getDict, getLocale } from "@/lib/i18n";
import { withSystem } from "@/lib/db";
import { fmtRelative } from "@/lib/dates";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { BarChart, RowBar, type Point } from "@/components/ui/chart";
import {
  BarChart3,
  Users,
  CalendarDays,
  MessageCircle,
  FileSignature,
  Sparkles,
} from "lucide-react";

const RANGES = [30, 90, 365] as const;
type Range = (typeof RANGES)[number];

type ClinicRow = {
  id: string;
  name: string;
  name_ar: string | null;
  slug: string;
  wa_status: string | null;
  outbound_today: number | null;
  daily_outbound_cap: number;
  patients: number;
  appointments: number;
  messages: number;
  documents: number;
  docs_pending: number;
  docs_expired: number;
  docs_declined: number;
  invoiced: string;
  ai_replies: number;
  ai_tokens: string;
  failures: number;
  last_activity: Date | null;
};

type MonthRow = {
  month: string;
  patients: number;
  appointments: number;
  messages: number;
  documents: number;
  ai_tokens: string;
};

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await guardAdminCap("analytics");
  const t = await getDict();
  const locale = await getLocale();

  const asked = Number((await searchParams).range);
  const range: Range = (RANGES as readonly number[]).includes(asked) ? (asked as Range) : 30;
  const days = String(range);

  const data = await withSystem(async (c) => {
    /*
      Three statements, not fifteen.

      node-pg serialises everything sent down one connection, so each awaited
      query is a full round trip to eu-central-1 and Promise.all would not
      change that — the driver still runs them one after another on the same
      client. Folding the headline numbers into a single select pays that
      latency once instead of nine times.

      Every subquery is scoped to `deleted_at is null`. A clinic on its way to
      being purged is not a customer, and counting one would make the platform
      look busiest on precisely the weeks it is losing people.
    */
    const totals = (
      await c.query(
        `select
           (select count(*) from clinics where deleted_at is null)::int as clinics,
           (select count(*) from clinics where deleted_at is null
              and subscription_status in ('trial','active'))::int as live,
           (select count(*) from patients p join clinics cl on cl.id = p.clinic_id
              where cl.deleted_at is null and p.merged_into is null)::int as patients,
           (select count(*) from appointments a join clinics cl on cl.id = a.clinic_id
              where cl.deleted_at is null
                and a.starts_at > now() - ($1 || ' days')::interval)::int as appointments,
           (select count(*) from messages m join clinics cl on cl.id = m.clinic_id
              where cl.deleted_at is null and m.direction = 'out'
                and m.status in ('sent','delivered','read')
                and m.created_at > now() - ($1 || ' days')::interval)::int as messages,
           (select count(*) from documents d join clinics cl on cl.id = d.clinic_id
              where cl.deleted_at is null and d.status = 'completed'
                and d.completed_at > now() - ($1 || ' days')::interval)::int as documents,
           coalesce((select sum(u.input_tokens + u.output_tokens) from ai_usage u
              join clinics cl on cl.id = u.clinic_id
              where cl.deleted_at is null and u.day > current_date - $2::int), 0)::bigint as ai_tokens,
           coalesce((select sum(u.messages_out) from ai_usage u
              join clinics cl on cl.id = u.clinic_id
              where cl.deleted_at is null and u.day > current_date - $2::int), 0)::int as ai_replies`,
        [days, range]
      )
    ).rows[0];

    /*
      Twelve buckets, generated rather than grouped.

      Left-joining onto `generate_series` is what makes a month with no activity
      come back as a zero instead of not coming back at all. Grouping alone
      drops the empty months, which compresses the timeline and quietly redraws
      a quiet summer as a straight line between two busy ones.
    */
    const months = (
      await c.query(
        `with months as (
           select generate_series(date_trunc('month', now()) - interval '11 months',
                                  date_trunc('month', now()), interval '1 month') as m
         )
         select to_char(months.m, 'YYYY-MM') as month,
                coalesce(p.n, 0)::int as patients,
                coalesce(a.n, 0)::int as appointments,
                coalesce(msg.n, 0)::int as messages,
                coalesce(d.n, 0)::int as documents,
                coalesce(tok.n, 0)::bigint as ai_tokens
           from months
           left join (
             select date_trunc('month', p.created_at) m, count(*) n from patients p
               join clinics cl on cl.id = p.clinic_id
              where cl.deleted_at is null and p.merged_into is null group by 1
           ) p on p.m = months.m
           left join (
             select date_trunc('month', a.starts_at) m, count(*) n from appointments a
               join clinics cl on cl.id = a.clinic_id where cl.deleted_at is null group by 1
           ) a on a.m = months.m
           left join (
             select date_trunc('month', m2.created_at) m, count(*) n from messages m2
               join clinics cl on cl.id = m2.clinic_id
              where cl.deleted_at is null and m2.direction = 'out'
                and m2.status in ('sent','delivered','read') group by 1
           ) msg on msg.m = months.m
           left join (
             select date_trunc('month', d.completed_at) m, count(*) n from documents d
               join clinics cl on cl.id = d.clinic_id
              where cl.deleted_at is null and d.status = 'completed'
                and d.completed_at is not null group by 1
           ) d on d.m = months.m
           left join (
             select date_trunc('month', u.day) m, sum(u.input_tokens + u.output_tokens) n
               from ai_usage u join clinics cl on cl.id = u.clinic_id
              where cl.deleted_at is null group by 1
           ) tok on tok.m = months.m
          order by months.m`
      )
    ).rows as MonthRow[];

    const clinics = (
      await c.query(
        `select cl.id, cl.name, cl.name_ar, cl.slug,
                ws.status as wa_status, ws.outbound_today, cl.daily_outbound_cap,
                (select count(*) from patients p
                   where p.clinic_id = cl.id and p.merged_into is null)::int as patients,
                (select count(*) from appointments a
                   where a.clinic_id = cl.id
                     and a.starts_at > now() - ($1 || ' days')::interval)::int as appointments,
                (select count(*) from messages m
                   where m.clinic_id = cl.id and m.direction = 'out'
                     and m.status in ('sent','delivered','read')
                     and m.created_at > now() - ($1 || ' days')::interval)::int as messages,
                (select count(*) from documents d
                   where d.clinic_id = cl.id and d.status = 'completed'
                     and d.completed_at > now() - ($1 || ' days')::interval)::int as documents,
                /*
                  Paperwork that has stalled. Unlike every other number here it
                  is deliberately not windowed by the range: a consent form sent
                  four months ago and never signed is more of a problem than one
                  sent last week, and a 30-day view would hide exactly the worst
                  cases.
                */
                (select count(*) from documents d
                   where d.clinic_id = cl.id
                     and d.status in ('sent', 'partially_signed'))::int as docs_pending,
                (select count(*) from documents d
                   where d.clinic_id = cl.id and d.status = 'expired')::int as docs_expired,
                (select count(*) from documents d
                   where d.clinic_id = cl.id and d.status = 'declined')::int as docs_declined,
                coalesce((select sum(i.total) from invoices i
                   where i.clinic_id = cl.id and i.status = 'paid'
                     and i.created_at > now() - ($1 || ' days')::interval), 0)::numeric as invoiced,
                coalesce((select sum(u.messages_out) from ai_usage u
                   where u.clinic_id = cl.id and u.day > current_date - $2::int), 0)::int as ai_replies,
                coalesce((select sum(u.input_tokens + u.output_tokens) from ai_usage u
                   where u.clinic_id = cl.id and u.day > current_date - $2::int), 0)::bigint as ai_tokens,
                (select count(*) from messages m
                   where m.clinic_id = cl.id and m.status = 'failed'
                     and m.created_at > now() - interval '7 days')::int as failures,
                (select max(al.created_at) from audit_log al
                   where al.clinic_id = cl.id) as last_activity
           from clinics cl
           left join whatsapp_sessions ws on ws.clinic_id = cl.id
          where cl.deleted_at is null
          order by cl.name`,
        [days, range]
      )
    ).rows as ClinicRow[];

    return { totals, months, clinics };
  });

  const { totals, months, clinics } = data;
  const intl = locale === "en" ? "en-GB" : "ar-JO";
  const num = (n: number | string) => Number(n).toLocaleString(intl);
  const monthLabel = (m: string) => {
    const [y, mo] = m.split("-");
    return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString(intl, { month: "short" });
  };
  const points = (key: "patients" | "appointments" | "messages" | "documents" | "ai_tokens"): Point[] =>
    months.map((r) => ({ label: monthLabel(r.month), sub: monthLabel(r.month), value: Number(r[key] ?? 0) }));

  // Busiest first. The table exists to find who is thriving and who has gone
  // quiet; alphabetical order answers neither question.
  const league = [...clinics].sort(
    (a, b) => b.appointments + b.messages - (a.appointments + a.messages)
  );
  const maxOf = (k: "patients" | "appointments" | "messages" | "documents") =>
    Math.max(1, ...clinics.map((c) => Number(c[k])));

  // Worst first: the clinic with the most unsigned paperwork is the one to call.
  const stalled = clinics
    .filter((c) => c.docs_pending + c.docs_expired + c.docs_declined > 0)
    .sort(
      (a, b) =>
        b.docs_pending + b.docs_expired + b.docs_declined -
        (a.docs_pending + a.docs_expired + a.docs_declined)
    );

  const daysQuiet = (d: Date | null) =>
    d ? Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000) : null;

  const tiles = [
    { icon: <Users className="h-4 w-4" />, label: t.admin.colPatients, value: num(totals.patients) },
    { icon: <CalendarDays className="h-4 w-4" />, label: t.admin.colAppointments, value: num(totals.appointments) },
    { icon: <MessageCircle className="h-4 w-4" />, label: t.admin.colMessages, value: num(totals.messages) },
    { icon: <FileSignature className="h-4 w-4" />, label: t.admin.colDocuments, value: num(totals.documents) },
    { icon: <Sparkles className="h-4 w-4" />, label: t.admin.colAiReplies, value: num(totals.ai_replies) },
    { icon: <BarChart3 className="h-4 w-4" />, label: t.admin.totalClinics, value: `${totals.live}/${totals.clinics}` },
  ];

  const hasAnything = Number(totals.patients) + Number(totals.appointments) > 0;

  return (
    <>
      <PageHeader
        title={t.admin.analytics}
        sub={t.admin.analyticsSub.replace("{days}", String(range))}
        action={
          <div className="flex items-center gap-1 rounded-full border border-line p-0.5">
            {RANGES.map((r) => (
              <Link
                key={r}
                href={`/admin/analytics?range=${r}`}
                prefetch
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                  r === range ? "bg-brand-600 text-white" : "text-ink-500 hover:text-ink-900"
                }`}
              >
                {r === 30 ? t.admin.range30 : r === 90 ? t.admin.range90 : t.admin.range365}
              </Link>
            ))}
          </div>
        }
      />

      {!hasAnything ? (
        <EmptyState icon={<BarChart3 />} title={t.admin.noData} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
            {tiles.map((s, i) => (
              <Card key={i} className="p-4">
                <div className="flex items-center gap-1.5 text-[13px] text-ink-500">
                  {s.icon}
                  <span className="truncate">{s.label}</span>
                </div>
                <div className="mt-1 text-2xl font-semibold tnum">{s.value}</div>
              </Card>
            ))}
          </div>

          {/*
            Small multiples rather than one chart with four series.

            Patients, appointments and messages differ by an order of magnitude,
            so sharing a y-axis would press three of them flat against the
            baseline — and giving each its own axis inside one frame is the
            dual-axis lie, where the crossing point is decided by the scales
            somebody chose. Four frames, one measure each, every scale stated by
            its own peak.
          */}
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            {(
              [
                ["patients", t.admin.colPatients],
                ["appointments", t.admin.colAppointments],
                ["messages", t.admin.colMessages],
                ["documents", t.admin.colDocuments],
              ] as const
            ).map(([key, label]) => (
              <Card key={key} className="p-5">
                <div className="mb-3 text-sm font-medium">
                  {label} <span className="text-ink-400">· {t.admin.growth}</span>
                </div>
                <BarChart data={points(key)} locale={intl} />
              </Card>
            ))}
          </div>

          <Card className="mb-4">
            <CardHeader title={t.admin.leagueTable} sub={t.admin.leagueTableSub} />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-400">
                    <th className="px-5 py-2 text-start font-semibold">{t.admin.clinics}</th>
                    <th className="px-3 py-2 text-end font-semibold">{t.admin.colPatients}</th>
                    <th className="px-3 py-2 text-end font-semibold">{t.admin.colAppointments}</th>
                    <th className="px-3 py-2 text-end font-semibold">{t.admin.colMessages}</th>
                    <th className="px-3 py-2 text-end font-semibold">{t.admin.colDocuments}</th>
                    <th className="px-3 py-2 text-end font-semibold">{t.admin.colInvoices}</th>
                    <th className="px-5 py-2 text-start font-semibold">{t.admin.lastActivity}</th>
                  </tr>
                </thead>
                <tbody>
                  {league.map((cl) => {
                    const quiet = daysQuiet(cl.last_activity);
                    return (
                      <tr key={cl.id} className="border-b border-line last:border-0">
                        <td className="px-5 py-2.5">
                          <Link
                            href={`/admin/clinics/${cl.slug}`}
                            className="font-medium hover:text-brand-700"
                          >
                            {cl.name_ar || cl.name}
                          </Link>
                        </td>
                        {(
                          [
                            ["patients", cl.patients],
                            ["appointments", cl.appointments],
                            ["messages", cl.messages],
                            ["documents", cl.documents],
                          ] as const
                        ).map(([k, v]) => (
                          <td key={k} className="px-3 py-2.5 align-middle">
                            {/* Number and bar together: the number is the value,
                                the bar is the comparison. Either on its own
                                leaves the reader doing the other's work. */}
                            <div className="text-end tnum">{num(v)}</div>
                            <div className="mt-1">
                              <RowBar value={Number(v)} max={maxOf(k)} />
                            </div>
                          </td>
                        ))}
                        <td className="px-3 py-2.5 text-end tnum">{num(cl.invoiced)}</td>
                        <td className="px-5 py-2.5 text-[13px]" suppressHydrationWarning>
                          {cl.last_activity ? (
                            quiet !== null && quiet >= 14 ? (
                              <Badge status="pending">
                                {t.admin.quiet.replace("{n}", String(quiet))}
                              </Badge>
                            ) : (
                              <span className="text-ink-500">
                                {fmtRelative(cl.last_activity, locale)}
                              </span>
                            )
                          ) : (
                            <span className="text-ink-300">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                <Sparkles className="h-4 w-4 text-chart" />
                {t.admin.aiCost}
              </div>
              <p className="mb-3 text-[12px] text-ink-400">{t.admin.aiCostSub}</p>
              <div className="mb-3 text-2xl font-semibold tnum">{num(totals.ai_tokens)}</div>
              <BarChart data={points("ai_tokens")} locale={intl} />
              {clinics.some((c) => Number(c.ai_tokens) > 0) && (
                <ul className="mt-4 grid gap-1.5 border-t border-line pt-3">
                  {[...clinics]
                    .filter((c) => Number(c.ai_tokens) > 0)
                    .sort((a, b) => Number(b.ai_tokens) - Number(a.ai_tokens))
                    .slice(0, 5)
                    .map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-3 text-[13px]">
                        <span className="min-w-0 truncate text-ink-700">{c.name_ar || c.name}</span>
                        <span className="tnum text-ink-500">{num(c.ai_tokens)}</span>
                      </li>
                    ))}
                </ul>
              )}
            </Card>

            {/*
              Paperwork that has stalled, and only that.

              This used to be a full per-clinic document table on a tab of its
              own, repeating the volume column already in the league table above.
              What it alone could tell you was which clinics have forms sitting
              unsigned — so that is all it shows now, and only for the clinics
              where the answer is not zero. A list of zeroes is not a report.
            */}
            {stalled.length > 0 && (
              <Card>
                <CardHeader title={t.admin.paperwork} sub={t.admin.paperworkSub} />
                <ul className="divide-y divide-line">
                  {stalled.map((cl) => (
                    <li key={cl.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5">
                      <Link
                        href={`/c/${cl.slug}/documents`}
                        className="min-w-32 flex-1 truncate text-[13px] font-medium hover:text-brand-700"
                      >
                        {cl.name_ar || cl.name}
                      </Link>
                      {cl.docs_pending > 0 && (
                        <Badge status="pending">
                          {t.docs.tabPending} {cl.docs_pending}
                        </Badge>
                      )}
                      {cl.docs_expired > 0 && (
                        <Badge status="no_show">
                          {t.docs.statuses.expired} {cl.docs_expired}
                        </Badge>
                      )}
                      {cl.docs_declined > 0 && (
                        <Badge status="cancelled">
                          {t.docs.statuses.declined} {cl.docs_declined}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Card>
              <CardHeader title={t.admin.waHealth} sub={t.admin.waHealthSub} />
              <ul className="divide-y divide-line">
                {clinics.map((cl) => {
                  const cap = cl.daily_outbound_cap || 1;
                  const used = Number(cl.outbound_today ?? 0);
                  return (
                    <li key={cl.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                      <span className="min-w-32 flex-1 truncate text-[13px]">
                        {cl.name_ar || cl.name}
                      </span>
                      {/* Dot and word. State is never colour alone. */}
                      <Badge status={cl.wa_status === "connected" ? "ok" : "danger"} dot>
                        {cl.wa_status === "connected" ? t.admin.connected : t.admin.disconnected}
                      </Badge>
                      <span className="w-24">
                        <span className="mb-0.5 block text-end text-[11px] tnum text-ink-400">
                          {used}/{cap}
                        </span>
                        <RowBar value={used} max={cap} />
                      </span>
                      {cl.failures > 0 && <Badge status="danger">{cl.failures}</Badge>}
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
