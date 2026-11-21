import Link from "next/link";
import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { can, hasFullControl } from "@/lib/auth";
import { invoiceDaySql, invoiceScopeSql, ownInvoicesOnly } from "@/lib/invoice-scope";
import { landingPathIn } from "@/lib/permissions";
import { inClinic } from "@/lib/clinic-api";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { dayRangeUtc, monthRangeUtc, fmtMoney, fmtLongToday } from "@/lib/dates";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { QuickActions, type QuickAction } from "./quick-actions";
import { TodayList } from "./today-list";
import { TodoList } from "./todo-card";
import { StockLines } from "./stock-card";
import { loadStockAttention } from "@/lib/charts/face/stock";
import { owedSql } from "@/lib/invoices";
import { dueBackCount } from "@/lib/due-back";
import { setupChecklist, type SetupItem } from "@/lib/setup-checklist";
import type { Dict } from "@/lib/i18n/en";
import {
  ArrowRight,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ListChecks,
  MessageCircle,
  ReceiptText,
} from "lucide-react";

/**
 * The front page: today, and what is waiting on somebody.
 *
 * Yamen, 2026-11-21: the old dashboard "doesn't serve a real job, and has too
 * much talk". It was four tiles, the day's list, a follow-up card, two
 * fortnight charts, two "what earns" lists and a per-doctor breakdown — the
 * last five a second copy of Finance → Analytics, read once a week, on the
 * screen opened fifty times a day. So it does two jobs now and nothing else:
 *
 *  - who is in the clinic today, and the one step each of them needs next
 *    (TodayList, the same for every role since 2026-11-08); and
 *  - "Needs you": one list of everything waiting on a person — bookings to
 *    confirm, invoices unpaid, messages unread, patients due back, the
 *    automations' To do, stock to order, and what is left to set up.
 *
 * The money a member may see is one pill under the date, not a card.
 */
export default async function DashboardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = await guardClinic(slug);
  /*
    Not `guardCap`, which would send anyone without the capability straight back
    here and spin. This is the page every other guard redirects *to*, so it is
    the one that has to work out where else somebody can go — and once it does,
    the fifteen bare redirects to the clinic root scattered through the
    workspace keep working untouched: they land here, and here forwards them on.
  */
  if (!can(a, "dashboard")) redirect(landingPathIn(slug, a.caps));
  const t = await dictForClinic(a.clinic.vocabulary);
  const locale = await getLocale();
  const tz = a.clinic.timezone;

  /*
    The one screen everybody can open is the one where a hidden section can
    leak anyway, so every figure follows the capability that opens its page —
    and the query behind it does not run for somebody who cannot see the answer
    (DECISIONS #74, #83).
  */
  const showMoney = can(a, "invoices");
  // The day's takings are "what the clinic took", not "may raise an invoice".
  const showRevenue = can(a, "invoices.analytics") && !ownInvoicesOnly(a);
  const showInbox = can(a, "conversations");
  const showCalendar = can(a, "calendar");
  const showPatients = can(a, "patients");
  /** Clinicti's own workspace — see clinics.vocabulary and i18n/vocab.ts. */
  const isAgency = a.clinic.vocabulary === "agency";

  const data = await inClinic(a, async (c) => {
    const today = dayRangeUtc(tz);
    const month = monthRangeUtc(tz);

    /*
      The clinic's day, the same for everybody (Yamen, 2026-11-08): the desk,
      the doctors and the owner all see who is in the waiting room, who is with
      a doctor and who is still to come. A doctor's own patients are marked as
      theirs rather than being the only ones shown.
    */
    const appts = (
      await c.query(
        // Every service of the visit, joined (0106): the doctor sees it is more than one.
        `select ap.id, ap.patient_id, ap.starts_at, ap.status, ap.arrived_at, ap.seated_at, p.full_name as patient_name,
                appointment_service_names(ap.id, false) as service_name, appointment_service_names(ap.id, true) as service_name_ar,
                s.color as service_color,
                ap.doctor_member_id, du.full_name as doctor_name, ap.service_id, s.duration_min as service_duration_min
         from appointments ap
         join patients p on p.id = ap.patient_id
         left join services s on s.id = ap.service_id
         left join clinic_members dm on dm.id = ap.doctor_member_id
         left join users du on du.id = dm.user_id
         where ap.clinic_id = $1 and ap.starts_at >= $2 and ap.starts_at < $3
           and ap.status not in ('cancelled')
         order by ap.starts_at
         limit 200`,
        [a.clinicId, today.start, today.end]
      )
    ).rows;

    /*
      The counters, as one statement built from the parts this member may see.

      Each part claims its parameters as it is added, so the numbering is always
      exactly what the statement mentions: Postgres refuses a statement handed a
      parameter it never uses, and a fixed list with optional parts is how this
      page once went down for everybody without revenue.
    */
    const params: unknown[] = [a.clinicId];
    const $ = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const parts: string[] = [];
    if (showInbox) parts.push(`(select coalesce(sum(unread_count),0) from conversations where clinic_id=$1)::int as unread`);
    if (showCalendar) {
      parts.push(
        `(select count(*) from appointments where clinic_id=$1 and status in ('scheduled','pending_approval') and starts_at > now())::int as unconfirmed`
      );
    }
    if (showMoney) {
      /*
        How many are unpaid, not how much: somebody who works the invoice list
        needs it whether or not they may see money. Counted over exactly the
        invoices its link lists — their own for a doctor, today's for a
        today-only member (2026-11-20).
      */
      const scope = invoiceScopeSql(a, "i", params.length + 1);
      params.push(...scope.params);
      const day = invoiceDaySql(a, "i", params.length + 1);
      params.push(...day.params);
      parts.push(`(select count(*) from invoices i where i.clinic_id=$1 and ${owedSql("i")}${scope.sql}${day.sql})::int as unpaid`);
    }
    if (showRevenue) {
      // The invoices page's "Collected today", to the cent: a cancelled invoice's payments are not takings.
      parts.push(
        `(select coalesce(sum(p.amount),0) from payments p join invoices v on v.id = p.invoice_id and v.status <> 'void'
           where p.clinic_id=$1 and p.paid_at >= ${$(today.start)} and p.paid_at < ${$(today.end)})::float8 as collected_today`
      );
    }
    if (isAgency) {
      // Demos booked through the public link this month, and prospects waiting on an answer.
      parts.push(
        `(select count(*) from appointments where clinic_id=$1 and source='booking_link' and starts_at >= ${$(month.start)} and starts_at < ${$(month.end)})::int as self_booked`
      );
      if (showPatients) parts.push(`(select count(*) from patients where clinic_id=$1 and merged_into is null and status='lead')::int as leads`);
    }
    const stats: Record<string, number> = parts.length ? (await c.query(`select ${parts.join(",\n")}`, params)).rows[0] : {};

    // Patients the doctor asked to see again, not booked yet — the desk's recall list.
    const dueBack = showCalendar ? await dueBackCount(c, a.clinicId) : 0;
    // Whoever runs the clinic sees what is left to set up, until nothing is.
    const setup = hasFullControl(a) ? await setupChecklist(c, a.clinicId) : null;
    // What the automations asked somebody at the desk to do: call back, chase, approve.
    const todo =
      showCalendar || showInbox
        ? (
            await c.query(
              `select t.id, t.title, t.body, t.patient_id, p.full_name as patient_name, t.created_at
                 from tasks t left join patients p on p.id = t.patient_id
                where t.clinic_id = $1 and not t.done
                order by t.created_at desc limit 10`,
              [a.clinicId]
            )
          ).rows
        : [];
    // What on the face chart's shelf needs ordering or throwing out, for whoever keeps Stock.
    const stock = a.clinic.features.aesthetic && can(a, "stock") ? await loadStockAttention(c, a.clinicId) : [];
    return { appts, stats, dueBack, setup, todo, stock };
  });

  const base = `/c/${slug}`;
  const money = (n: number) => fmtMoney(n, a.clinic.currency, locale);

  // The two things the front page starts; invoice and inbox keep their keys (I, M) from the shell.
  const actions: QuickAction[] = [
    ...(showCalendar ? (["appointment"] as const) : []),
    ...(showPatients ? (["patient"] as const) : []),
  ];

  /*
    What is waiting on somebody, in the order the desk works it. A row this
    member may see is always there — a zero says "nothing waiting", which is
    an answer — and only the parts that come and go (To do, stock, setup)
    disappear when empty.
  */
  const rows: NeedsRow[] = [
    ...(showCalendar
      ? [{ key: "unconfirmed", href: `${base}/calendar?show=unconfirmed`, icon: CalendarClock, label: t.dashboard.unconfirmed, count: data.stats.unconfirmed ?? 0 }]
      : []),
    ...(showMoney
      ? [{ key: "unpaid", href: `${base}/invoices?status=unpaid`, icon: ReceiptText, label: t.dashboard.unpaidInvoices, count: data.stats.unpaid ?? 0 }]
      : []),
    ...(showInbox
      ? [{ key: "unread", href: `${base}/conversations`, icon: MessageCircle, label: t.dashboard.unreadConversations, count: data.stats.unread ?? 0 }]
      : []),
    ...(showCalendar
      ? [{ key: "due-back", href: `${base}/calendar?tab=waitlist`, icon: CalendarPlus, label: t.finishVisit.dueBack, count: data.dueBack }]
      : []),
  ];
  const setupLeft = data.setup && data.setup.some((i) => !i.done) ? data.setup : null;
  const hasNeeds = rows.length > 0 || data.todo.length > 0 || data.stock.length > 0 || !!setupLeft;

  /*
    The day's money, and for the workspace that sells the product its two
    numbers, as pills on the line under the date (Yamen, 2026-11-15: a glance
    figure is a line, not a card).
  */
  const figures: { hook: string; label: string; value: string }[] = [
    ...(showRevenue ? [{ hook: "collected-today", label: t.invoices.collectedToday, value: money(data.stats.collected_today ?? 0) }] : []),
    ...(isAgency ? [{ hook: "demos", label: t.dashboard.demosMonth, value: String(data.stats.self_booked ?? 0) }] : []),
    ...(isAgency && showPatients ? [{ hook: "leads", label: t.patients.statusLead, value: String(data.stats.leads ?? 0) }] : []),
  ];

  return (
    <>
      {/* The date is the title: the desk's first question of this screen is which day it is looking at, and the clinic's day is not always the device's. */}
      <PageHeader
        title={fmtLongToday(tz, locale)}
        sub={
          figures.length > 0 ? (
            <span className="mt-1.5 flex flex-wrap items-center gap-2">
              {figures.map((f) => (
                <span key={f.hook} data-figure={f.hook} className="inline-flex items-baseline gap-2 rounded-full bg-ink-900/5 px-3 py-1">
                  <span className="text-[0.75rem] text-ink-500">{f.label}</span>
                  <span className="text-[0.8125rem] font-semibold text-ink-900 tnum">{f.value}</span>
                </span>
              ))}
            </span>
          ) : undefined
        }
        action={actions.length > 0 ? <QuickActions slug={slug} actions={actions} /> : undefined}
      />

      {/*
        grid-cols-1 below lg, not a bare grid: an implicit column is floored at
        the min-content width of its widest child, and one appointment row with
        a long patient name held the page open past the screen. On a phone the
        day comes first and Needs you under it — a doctor between rooms opens
        this for who is next.
      */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <Card className={hasNeeds ? "lg:col-span-2" : "lg:col-span-3"}>
          <CardHeader
            title={t.dashboard.todayAppointments}
            action={
              showCalendar ? (
                <Link
                  href={`${base}/calendar`}
                  className="flex items-center gap-1 text-[0.8125rem] font-medium text-brand-700 hover:text-brand-800"
                >
                  {/* The board of today's patients opens first on that page. */}
                  {t.dashboard.viewCalendar}
                  <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
                </Link>
              ) : undefined
            }
          />
          {data.appts.length === 0 ? (
            <EmptyState bare icon={<CalendarDays />} title={t.dashboard.noAppointmentsToday} />
          ) : (
            <TodayList
              slug={slug}
              tz={tz}
              rows={JSON.parse(JSON.stringify(data.appts))}
              canFlow={showCalendar}
              canOpenPatient={showPatients}
              selfMemberId={a.memberId ?? null}
            />
          )}
        </Card>

        {hasNeeds && (
          <div data-needs-you>
            <Card>
              <CardHeader title={t.dashboard.needsYou} />
              {rows.length > 0 && (
                <ul className="p-2">
                  {rows.map((r) => (
                    <NeedsLine key={r.key} row={r} />
                  ))}
                </ul>
              )}
              <TodoList slug={slug} rows={JSON.parse(JSON.stringify(data.todo))} canOpenPatient={showPatients} />
              <StockLines slug={slug} items={data.stock} t={t} locale={locale} />
              {setupLeft && <Setup base={base} items={setupLeft} t={t} />}
            </Card>
          </div>
        )}
      </div>
    </>
  );
}

type NeedsRow = {
  key: string;
  href: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  count: number;
};

/**
 * One thing waiting on somebody, and how many of it. The count is a chip so
 * that "11 waiting" and "nothing waiting" look different at a glance — amber
 * when there is work, quiet when there is none.
 */
function NeedsLine({ row }: { row: NeedsRow }) {
  const Icon = row.icon;
  return (
    <li>
      <Link
        href={row.href}
        data-needs-row={row.key}
        data-count={row.count}
        className="flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-[0.8125rem] transition-colors duration-140 ease-out hover:bg-ink-900/4"
      >
        <Icon className="h-4 w-4 shrink-0 text-ink-400" strokeWidth={1.75} />
        <span className={`min-w-0 flex-1 ${row.count > 0 ? "font-medium text-ink-900" : "text-ink-500"}`}>{row.label}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[0.75rem] font-semibold tnum ${
            row.count > 0 ? "bg-st-pending-soft text-st-pending" : "bg-ink-900/4 text-ink-400"
          }`}
        >
          {row.count}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
      </Link>
    </li>
  );
}

/*
  What is left to set up, folded behind one line with its progress (Yamen,
  2026-11-16: setup belongs behind a button). Open, every step is a link to the
  page that does it, ticked when the clinic has done it. The line goes when the
  last step is done.
*/
function Setup({ base, items, t }: { base: string; items: SetupItem[]; t: Dict }) {
  const done = items.filter((i) => i.done).length;
  return (
    <details data-setup-card className="group border-t border-line">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-5 py-2 text-[0.8125rem] transition-colors hover:bg-ink-900/4 [&::-webkit-details-marker]:hidden">
        <ListChecks className="h-4 w-4 shrink-0 text-ink-400" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 font-medium text-ink-900">{t.setup.title}</span>
        <span className="rounded-full bg-ink-900/5 px-2 py-0.5 text-[0.75rem] font-semibold text-ink-500 tnum">
          {done}/{items.length}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-ink-300 transition-transform group-open:rotate-180" />
      </summary>
      <ul className="grid gap-0.5 px-2 pb-2">
        {items.map((i) => (
          <li key={i.key}>
            <Link
              href={`${base}${i.path}`}
              className="flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-[0.8125rem] transition-colors hover:bg-ink-900/4"
              data-setup-item={i.key}
              data-done={i.done ? "1" : "0"}
            >
              {i.done ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-brand-700" />
              ) : (
                <Circle className="h-4 w-4 shrink-0 text-ink-300" />
              )}
              <span className={`min-w-0 flex-1 ${i.done ? "text-ink-400 line-through" : "text-ink-900"}`}>{t.setup.items[i.key].label}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
