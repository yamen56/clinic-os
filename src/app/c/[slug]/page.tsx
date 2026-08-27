import Link from "next/link";
import { guardClinic } from "@/lib/guard";
import { can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { dayRangeUtc, weekRangeUtc, monthRangeUtc, fmtTime, fmtMoney } from "@/lib/dates";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { BarChart, RowBar, type Point } from "@/components/ui/chart";
import { QuickActions, type QuickAction } from "./quick-actions";
import { CalendarDays, TrendingUp, TrendingDown, ArrowRight } from "lucide-react";

const apptStatus: Record<string, StatusKey> = {
  pending_approval: "pending",
  scheduled: "scheduled",
  confirmed: "confirmed",
  completed: "completed",
  no_show: "no_show",
  cancelled: "cancelled",
};

/** A stat tile. Built as data so the visible four follow the viewer's access. */
type Tile = { key: string; label: string; value: string; foot?: React.ReactNode; href?: string };

export default async function DashboardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = await guardClinic(slug);
  const t = await dictForClinic(a.clinic.vocabulary);
  const locale = await getLocale();

  const tz = a.clinic.timezone;
  /*
    The dashboard is the one screen everybody can open, which makes it the one
    screen where a hidden section can leak anyway. A member whose owner removed
    Invoices should not read the week's revenue off the front page, so the tiles
    and the charts follow the same capabilities as the nav — and the queries
    behind them do not run at all for somebody who cannot see the answer.
  */
  const showMoney = can(a, "invoices");
  const showInbox = can(a, "conversations");
  const showCalendar = can(a, "calendar");
  const showPatients = can(a, "patients");
  const intl = locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB";

  const data = await inClinic(a, async (c) => {
    const today = dayRangeUtc(tz);
    const thisWeek = weekRangeUtc(tz);
    const lastWeek = weekRangeUtc(tz, -1);
    const month = monthRangeUtc(tz);

    const appts = (
      await c.query(
        `select ap.id, ap.starts_at, ap.status, p.full_name as patient_name,
                s.name as service_name, s.name_ar as service_name_ar, s.color as service_color,
                du.full_name as doctor_name
         from appointments ap
         join patients p on p.id = ap.patient_id
         left join services s on s.id = ap.service_id
         left join clinic_members dm on dm.id = ap.doctor_member_id
         left join users du on du.id = dm.user_id
         where ap.clinic_id = $1 and ap.starts_at >= $2 and ap.starts_at < $3
           and ap.status not in ('cancelled')
         order by ap.starts_at
         limit 20`,
        [a.clinicId, today.start, today.end]
      )
    ).rows;

    // The counters are all scalar lookups — one statement rather than a query each.
    const [stats] = (
      await c.query(
        `select
          (select coalesce(sum(unread_count),0) from conversations where clinic_id=$1)::int as unread,
          (select coalesce(sum(amount),0) from payments where clinic_id=$1 and paid_at >= $2 and paid_at < $3) as rev_this,
          (select coalesce(sum(amount),0) from payments where clinic_id=$1 and paid_at >= $4 and paid_at < $5) as rev_last,
          (select count(*) from appointments where clinic_id=$1 and starts_at >= $6 and starts_at < $7 and status='no_show')::int as noshow,
          (select count(*) from appointments where clinic_id=$1 and starts_at >= $6 and starts_at < $7 and status in ('completed','no_show'))::int as finished,
          (select count(*) from invoices where clinic_id=$1 and status in ('sent','partially_paid'))::int as unpaid,
          -- The money owed, not just how many pieces of paper it is spread across.
          (select coalesce(sum(total - amount_paid),0) from invoices where clinic_id=$1 and status in ('sent','partially_paid')) as owed,
          (select count(*) from patients where clinic_id=$1 and merged_into is null and created_at >= $6 and created_at < $7)::int as new_patients,
          (select count(*) from appointments where clinic_id=$1 and status in ('scheduled','pending_approval') and starts_at > now())::int as unconfirmed`,
        [a.clinicId, thisWeek.start, thisWeek.end, lastWeek.start, lastWeek.end, month.start, month.end]
      )
    ).rows;

    /*
      Fourteen days of takings and bookings, bucketed by the clinic's own day.

      `generate_series` supplies the days so a quiet Friday is a zero rather
      than a gap — a chart that silently drops empty days compresses time and
      makes a bad week look like a normal one.
    */
    const series = (
      await c.query(
        `with days as (
           select generate_series(
             (now() at time zone $2)::date - interval '13 days',
             (now() at time zone $2)::date,
             interval '1 day')::date as day
         )
         select to_char(d.day, 'YYYY-MM-DD') as day,
                coalesce(p.amount, 0)::float8 as revenue,
                coalesce(ap.n, 0)::int as appointments
           from days d
           left join (
             select (paid_at at time zone $2)::date as day, sum(amount) as amount
               from payments
              where clinic_id = $1 and paid_at >= now() - interval '15 days'
              group by 1
           ) p on p.day = d.day
           left join (
             select (starts_at at time zone $2)::date as day, count(*) as n
               from appointments
              where clinic_id = $1 and starts_at >= now() - interval '15 days'
                and starts_at < now() + interval '1 day' and status <> 'cancelled'
              group by 1
           ) ap on ap.day = d.day
          order by d.day`,
        [a.clinicId, tz]
      )
    ).rows;

    /*
      Who did the work this month. Appointment-based rather than invoice-based,
      so it means something in a clinic that has not switched invoicing on, and
      it carries the misses beside the completions — a doctor with a high count
      and a high no-show rate is a different conversation from a busy one.
    */
    const doctors = (
      await c.query(
        `select coalesce(u.full_name, '') as name,
                count(*) filter (where ap.status = 'completed')::int as completed,
                count(*) filter (where ap.status = 'no_show')::int as no_show
           from appointments ap
           left join clinic_members cm on cm.id = ap.doctor_member_id
           left join users u on u.id = cm.user_id
          where ap.clinic_id = $1 and ap.starts_at >= $2 and ap.starts_at < $3
            and ap.status in ('completed', 'no_show')
          group by 1
          order by 2 desc, 3 asc
          limit 6`,
        [a.clinicId, month.start, month.end]
      )
    ).rows;

    /*
      Only for somebody who may see money. Skipped rather than filtered out
      later, because the cheapest query is the one that does not run — and this
      is the most-opened page in the product.
    */
    const services = showMoney
      ? (
          await c.query(
            `select coalesce(nullif(s.name_ar, ''), s.name, '') as name,
                    sum(ii.amount)::float8 as amount
               from invoice_items ii
               join invoices i on i.id = ii.invoice_id
               left join services s on s.id = ii.service_id
              where ii.clinic_id = $1 and i.status <> 'void'
                and i.created_at >= $2 and i.created_at < $3
              group by 1
              order by 2 desc
              limit 6`,
            [a.clinicId, month.start, month.end]
          )
        ).rows
      : [];

    return { appts, stats, series, doctors, services };
  });

  const revThis = Number(data.stats.rev_this);
  const revLast = Number(data.stats.rev_last);
  const revUp = revThis >= revLast;
  const owed = Number(data.stats.owed);
  const noShowRate =
    data.stats.finished > 0 ? Math.round((data.stats.noshow / data.stats.finished) * 100) : 0;
  const base = `/c/${slug}`;

  const actions: QuickAction[] = [
    ...(showCalendar ? (["appointment"] as const) : []),
    ...(showPatients ? (["patient"] as const) : []),
    ...(showMoney ? (["invoice"] as const) : []),
    ...(showInbox ? (["inbox"] as const) : []),
  ];

  /*
    Four tiles, chosen by what this member can see rather than by hiding gaps in
    a fixed row of six. A receptionist without invoices gets no-show rate and new
    patients where the money would have been, so the row is always full and
    always says something.
  */
  const tiles: Tile[] = [
    {
      key: "today",
      label: t.dashboard.todayAppointments,
      value: String(data.appts.length),
      href: showCalendar ? `${base}/calendar` : undefined,
    },
    ...(showInbox
      ? [
          {
            key: "unread",
            label: t.dashboard.unreadConversations,
            value: String(data.stats.unread),
            href: `${base}/conversations`,
          },
        ]
      : []),
    ...(showMoney
      ? [
          {
            key: "revenue",
            label: t.dashboard.revenueWeek,
            value: fmtMoney(revThis, a.clinic.currency, locale),
            foot: (
              <span
                className={`flex items-center gap-1 text-xs font-semibold ${revUp ? "text-ok" : "text-danger"}`}
              >
                {revUp ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" />
                )}
                {fmtMoney(revLast, a.clinic.currency, locale)} {t.dashboard.vsLastWeek}
              </span>
            ),
          },
          {
            key: "owed",
            label: t.dashboard.outstanding,
            value: fmtMoney(owed, a.clinic.currency, locale),
            foot: (
              <span className="text-xs text-ink-500">
                {t.dashboard.outstandingSub.replace("{n}", String(data.stats.unpaid))}
              </span>
            ),
            href: `${base}/invoices?status=unpaid`,
          },
        ]
      : []),
    { key: "noshow", label: t.dashboard.noShowRate, value: `${noShowRate}%` },
    ...(showPatients
      ? [
          {
            key: "newpatients",
            label: t.dashboard.newPatientsMonth,
            value: String(data.stats.new_patients),
            href: `${base}/patients`,
          },
        ]
      : []),
  ];

  const revenuePoints: Point[] = data.series.map((d) => ({
    label: String(d.day).slice(5),
    value: Number(d.revenue),
    sub: String(d.day),
  }));
  const apptPoints: Point[] = data.series.map((d) => ({
    label: String(d.day).slice(5),
    value: Number(d.appointments),
    sub: String(d.day),
  }));
  const maxService = Math.max(1, ...data.services.map((s) => Number(s.amount)));
  const maxDoctor = Math.max(1, ...data.doctors.map((d) => Number(d.completed)));

  return (
    <>
      {/*
        No WhatsApp or AI status badges here. They are settings, not news: they
        change a handful of times a year and told a receptionist nothing she
        needed while she was looking at today's list. A disconnection still
        reaches the owner as a notification, which is the moment it matters.
      */}
      <PageHeader
        title={t.dashboard.title}
        action={actions.length > 0 ? <QuickActions slug={slug} actions={actions} /> : undefined}
      />

      {/*
        One column below 360px. Two tiles across a 320px screen leaves about
        113px of usable width each, and "JOD 120.00" does not fit in it at any
        size somebody would want to read — the currency was being eaten by the
        ellipsis, which is the one part of a money figure that must never be the
        bit that goes. An iPhone SE gets four full-width tiles instead; every
        other phone keeps the pair.
      */}
      <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 xl:grid-cols-4">
        {tiles.slice(0, 4).map((tile) => {
          const body = (
            <Card className="h-full p-4">
              <div className="eyebrow">{tile.label}</div>
              {/*
                Smaller on a phone, where two tiles share 390px and a balance
                like "JOD 594.00" does not fit at 32px — it was losing the
                currency to the ellipsis, which is the one part of a money
                figure that must never be the bit that gets cut. `truncate`
                stays as the backstop for a six-figure balance.
              */}
              <div className="font-display mt-2 min-w-0 truncate text-[26px] font-bold leading-none tnum sm:text-[32px]">
                {tile.value}
              </div>
              {tile.foot && <div className="mt-2">{tile.foot}</div>}
            </Card>
          );
          return tile.href ? (
            <Link key={tile.key} href={tile.href} className="transition-shadow hover:shadow-pop">
              {body}
            </Link>
          ) : (
            <div key={tile.key}>{body}</div>
          );
        })}
      </div>

      {/*
        grid-cols-1 below lg, not a bare grid: an implicit column is floored at
        the min-content width of its widest child, and one appointment row with
        a long patient name held the dashboard open past the screen. The third
        instance of this bug — see automations-client and weekly-hours-editor.
      */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title={t.dashboard.todayAppointments}
            action={
              <Link
                href={`${base}/calendar`}
                className="flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:text-brand-800"
              >
                {t.dashboard.viewCalendar}
                <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
              </Link>
            }
          />
          {data.appts.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<CalendarDays />}
                title={t.dashboard.noAppointmentsToday}
                body={t.dashboard.emptyDay}
              />
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {data.appts.map((ap) => (
                <li
                  key={ap.id}
                  className="spine flex items-center gap-4 px-5 py-3"
                  style={
                    {
                      "--spine-color": ap.service_color ?? "var(--color-brand-600)",
                    } as React.CSSProperties
                  }
                >
                  <span className="w-16 shrink-0 text-sm font-semibold tnum">
                    {fmtTime(ap.starts_at, tz, locale)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{ap.patient_name}</div>
                    <div className="truncate text-[13px] text-ink-500">
                      {(locale === "ar" ? ap.service_name_ar : null) || ap.service_name || "—"}
                      {ap.doctor_name ? ` · ${ap.doctor_name}` : ""}
                    </div>
                  </div>
                  <Badge status={apptStatus[ap.status] ?? "neutral"}>
                    {(t.calendar.statuses as Record<string, string>)[ap.status] ?? ap.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="h-fit">
          <CardHeader title={t.dashboard.pending} />
          <ul className="grid gap-1 p-3">
            {showMoney && (
              <li>
                <Link
                  href={`${base}/invoices?status=unpaid`}
                  className="flex items-center justify-between rounded-lg px-3 py-2.5 text-sm hover:bg-ink-900/4"
                >
                  <span>{t.dashboard.unpaidInvoices}</span>
                  <span className="font-semibold tnum">{data.stats.unpaid}</span>
                </Link>
              </li>
            )}
            {showCalendar && (
              <li>
                <Link
                  href={`${base}/calendar`}
                  className="flex items-center justify-between rounded-lg px-3 py-2.5 text-sm hover:bg-ink-900/4"
                >
                  <span>{t.dashboard.unconfirmed}</span>
                  <span className="font-semibold tnum">{data.stats.unconfirmed}</span>
                </Link>
              </li>
            )}
          </ul>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {showMoney && (
          <Card>
            <CardHeader title={t.dashboard.revenueTrend} />
            <div className="px-5 py-4">
              <BarChart data={revenuePoints} locale={intl} />
            </div>
          </Card>
        )}
        <Card className={showMoney ? "" : "lg:col-span-2"}>
          <CardHeader title={t.dashboard.appointmentsTrend} />
          <div className="px-5 py-4">
            <BarChart data={apptPoints} locale={intl} />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {showMoney && (
          <Card>
            <CardHeader title={t.dashboard.topServices} sub={t.dashboard.topServicesSub} />
            {data.services.length === 0 ? (
              <p className="px-5 py-4 text-[13px] text-ink-500">{t.dashboard.noneYet}</p>
            ) : (
              <ul className="grid gap-3 px-5 py-4">
                {data.services.map((s, i) => (
                  <li key={i}>
                    <div className="flex min-w-0 items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-sm">
                        {s.name || t.dashboard.unassigned}
                      </span>
                      <span className="shrink-0 text-sm font-semibold tnum">
                        {fmtMoney(Number(s.amount), a.clinic.currency, locale)}
                      </span>
                    </div>
                    <div className="mt-1.5">
                      <RowBar value={Number(s.amount)} max={maxService} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card className={showMoney ? "" : "lg:col-span-2"}>
          {/*
            The clinic-wide rate lives here rather than in a tile of its own.
            A bare percentage is a number to worry about; the same number above
            the per-doctor breakdown is the start of knowing what to do — and it
            survives for a full-access owner, whose four tiles are taken by
            money and today's list.
          */}
          <CardHeader
            title={t.dashboard.byDoctor}
            sub={
              data.stats.finished > 0
                ? t.dashboard.noShowShare.replace("{n}", String(noShowRate))
                : t.dashboard.byDoctorSub
            }
          />
          {data.doctors.length === 0 ? (
            <p className="px-5 py-4 text-[13px] text-ink-500">{t.dashboard.noneYet}</p>
          ) : (
            <ul className="grid gap-3 px-5 py-4">
              {data.doctors.map((d, i) => (
                <li key={i}>
                  <div className="flex min-w-0 items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm">
                      {d.name || t.dashboard.unassigned}
                    </span>
                    <span className="shrink-0 text-[13px] tnum">
                      <span className="font-semibold">{d.completed}</span>{" "}
                      <span className="text-ink-500">{t.dashboard.completedShort}</span>
                      {d.no_show > 0 && (
                        <span className="text-danger">
                          {" · "}
                          {d.no_show} {t.dashboard.noShowShort}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <RowBar value={Number(d.completed)} max={maxDoctor} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
