import Link from "next/link";
import { guardClinic } from "@/lib/guard";
import { can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { getDict, getLocale } from "@/lib/i18n";
import { dayRangeUtc, weekRangeUtc, monthRangeUtc, fmtTime, fmtMoney } from "@/lib/dates";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { CalendarDays, TrendingUp, TrendingDown, ArrowRight } from "lucide-react";

const apptStatus: Record<string, StatusKey> = {
  pending_approval: "pending",
  scheduled: "scheduled",
  confirmed: "confirmed",
  completed: "completed",
  no_show: "no_show",
  cancelled: "cancelled",
};

export default async function DashboardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = await guardClinic(slug);
  const t = await getDict();
  const locale = await getLocale();

  const tz = a.clinic.timezone;

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

    // The counters and the two connection badges are all scalar lookups —
    // one statement rather than a query each.
    const [stats] = (
      await c.query(
        `select
          (select coalesce(sum(unread_count),0) from conversations where clinic_id=$1)::int as unread,
          (select coalesce(sum(amount),0) from payments where clinic_id=$1 and paid_at >= $2 and paid_at < $3) as rev_this,
          (select coalesce(sum(amount),0) from payments where clinic_id=$1 and paid_at >= $4 and paid_at < $5) as rev_last,
          (select count(*) from appointments where clinic_id=$1 and starts_at >= $6 and starts_at < $7 and status='no_show')::int as noshow,
          (select count(*) from appointments where clinic_id=$1 and starts_at >= $6 and starts_at < $7 and status in ('completed','no_show'))::int as finished,
          (select count(*) from invoices where clinic_id=$1 and status in ('sent','partially_paid'))::int as unpaid,
          (select count(*) from appointments where clinic_id=$1 and status in ('scheduled','pending_approval') and starts_at > now())::int as unconfirmed`,
        [a.clinicId, thisWeek.start, thisWeek.end, lastWeek.start, lastWeek.end, month.start, month.end]
      )
    ).rows;

    return { appts, stats };
  });

  const revThis = Number(data.stats.rev_this);
  const revLast = Number(data.stats.rev_last);
  const revUp = revThis >= revLast;
  /*
    The dashboard is the one screen everybody can open, which makes it the one
    screen where a hidden section can leak anyway. A member whose owner removed
    Invoices should not read the week's revenue off the front page, so the tiles
    follow the same capabilities as the nav.
  */
  const showMoney = can(a, "invoices");
  const showInbox = can(a, "conversations");
  const showCalendar = can(a, "calendar");
  const noShowRate = data.stats.finished > 0 ? Math.round((data.stats.noshow / data.stats.finished) * 100) : 0;
  const base = `/c/${slug}`;

  return (
    <>
      {/*
        No WhatsApp or AI status badges here. They are settings, not news: they
        change a handful of times a year and told a receptionist nothing she
        needed while she was looking at today's list. A disconnection still
        reaches the owner as a notification, which is the moment it matters.
      */}
      <PageHeader title={t.dashboard.title} />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Card className="p-4">
          <div className="eyebrow">{t.dashboard.todayAppointments}</div>
          <div className="font-display mt-2 text-[32px] font-bold leading-none tnum">{data.appts.length}</div>
        </Card>
        {showInbox && (
          <Link href={`${base}/conversations`}>
            <Card className="h-full p-4 transition-shadow hover:shadow-pop">
              <div className="eyebrow">{t.dashboard.unreadConversations}</div>
              <div className="font-display mt-2 text-[32px] font-bold leading-none tnum">{data.stats.unread}</div>
            </Card>
          </Link>
        )}
        {showMoney && (
        <Card className="p-4">
          <div className="eyebrow">{t.dashboard.revenueWeek}</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-display text-[32px] font-bold leading-none tnum">{fmtMoney(revThis, a.clinic.currency, locale)}</span>
          </div>
          <div className={`mt-2 flex items-center gap-1 text-xs font-semibold ${revUp ? "text-ok" : "text-danger"}`}>
            {revUp ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
            {fmtMoney(revLast, a.clinic.currency, locale)} {t.dashboard.vsLastWeek}
          </div>
        </Card>
        )}
        <Card className="p-4">
          <div className="eyebrow">{t.dashboard.noShowRate}</div>
          <div className="font-display mt-2 text-[32px] font-bold leading-none tnum">{noShowRate}%</div>
        </Card>
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
                <li key={ap.id} className="spine flex items-center gap-4 px-5 py-3"
                    style={{ "--spine-color": ap.service_color ?? "var(--color-brand-600)" } as React.CSSProperties}>
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

        <Card>
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
    </>
  );
}
