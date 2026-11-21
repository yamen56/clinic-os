import Link from "next/link";
import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { guardClinic } from "@/lib/guard";
import { can, hasFullControl } from "@/lib/auth";
import { invoiceDaySql, invoiceScopeSql, ownInvoicesOnly } from "@/lib/invoice-scope";
import { landingPathIn } from "@/lib/permissions";
import { inClinic } from "@/lib/clinic-api";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { dayRangeUtc, monthRangeUtc, fmtMoney } from "@/lib/dates";
import { flowStage } from "@/lib/patient-flow";
import { Card, CardHeader } from "@/components/ui/card";
import { Sparkline } from "@/components/ui/chart";
import { buttonClass } from "@/components/ui/button-class";
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
  Banknote,
  CalendarCheck,
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
  Sunrise,
  Target,
  UserPlus,
  Users,
} from "lucide-react";

/**
 * The front page: a welcome, the day in four figures, today's patients, and
 * what is waiting on somebody.
 *
 * Yamen, 2026-11-21 — twice. First "it doesn't serve a real job and has too
 * much talk", so the tiles, the fortnight charts and the per-doctor lists went
 * to Analytics. Then, of the bare page that left, "it feels so empty — I want
 * it more welcoming and nice to view, and still show data but not that much".
 * So it opens on a greeting in the brand's own night surface, then four
 * figure cards a glance can read (today's visits and how far through them the
 * clinic is, the day's takings with the week's shape, the inbox, the patient
 * count), then the day's list beside one "Needs you" list and tomorrow's first
 * bookings. Analytics keeps the depth.
 *
 * Every figure follows the capability that opens its page, and its query does
 * not run for somebody who may not see it (DECISIONS #74, #83).
 */
export default async function DashboardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = await guardClinic(slug);
  /*
    Not `guardCap`, which would send anyone without the capability straight back
    here and spin. This is the page every other guard redirects *to*, so it is
    the one that has to work out where else somebody can go.
  */
  if (!can(a, "dashboard")) redirect(landingPathIn(slug, a.caps));
  const t = await dictForClinic(a.clinic.vocabulary);
  const D = t.dashboard;
  const locale = await getLocale();
  const tz = a.clinic.timezone;
  const intl = locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB";

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
    const tomorrow = dayRangeUtc(tz, DateTime.now().setZone(tz).plus({ days: 1 }).toISODate()!);

    /*
      The clinic's day, the same for everybody (Yamen, 2026-11-08): the desk,
      the doctors and the owner all see who is in the waiting room, who is with
      a doctor and who is still to come.
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
      parameter it never uses.
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
      // How many are unpaid, over exactly the invoices its link lists (own work, today's only).
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
    if (showPatients) {
      parts.push(`(select count(*) from patients where clinic_id=$1 and merged_into is null and status <> 'archived')::int as patients`);
      parts.push(
        `(select count(*) from patients where clinic_id=$1 and merged_into is null and created_at >= ${$(month.start)} and created_at < ${$(month.end)})::int as new_patients`
      );
    }
    if (isAgency) {
      parts.push(
        `(select count(*) from appointments where clinic_id=$1 and source='booking_link' and starts_at >= ${$(month.start)} and starts_at < ${$(month.end)})::int as self_booked`
      );
      if (showPatients) parts.push(`(select count(*) from patients where clinic_id=$1 and merged_into is null and status='lead')::int as leads`);
    }
    const stats: Record<string, number> = parts.length ? (await c.query(`select ${parts.join(",\n")}`, params)).rows[0] : {};

    /*
      The last seven days, for the little lines in the corner of the cards:
      bookings for everybody, takings only for somebody who may see them.
      `generate_series` supplies the days, so a quiet day is a zero, not a gap.
    */
    const week = (
      await c.query(
        `with days as (
           select generate_series((now() at time zone $2)::date - 6, (now() at time zone $2)::date, interval '1 day')::date as day
         )
         select d.day,
                (select count(*) from appointments ap
                  where ap.clinic_id = $1 and ap.status <> 'cancelled'
                    and (ap.starts_at at time zone $2)::date = d.day)::int as visits${
                  showRevenue
                    ? `,
                (select coalesce(sum(p.amount), 0) from payments p join invoices v on v.id = p.invoice_id and v.status <> 'void'
                  where p.clinic_id = $1 and (p.paid_at at time zone $2)::date = d.day)::float8 as taken`
                    : ""
                }
           from days d order by d.day`,
        [a.clinicId, tz]
      )
    ).rows as { visits: number; taken?: number }[];

    // Tomorrow's first few, so the end of the day can glance at the start of the next.
    const tomorrowRows = showCalendar
      ? (
          await c.query(
            `select ap.id, ap.starts_at, p.full_name as patient_name, du.full_name as doctor_name, count(*) over () as total
               from appointments ap
               join patients p on p.id = ap.patient_id
               left join clinic_members dm on dm.id = ap.doctor_member_id
               left join users du on du.id = dm.user_id
              where ap.clinic_id = $1 and ap.starts_at >= $2 and ap.starts_at < $3 and ap.status not in ('cancelled')
              order by ap.starts_at limit 4`,
            [a.clinicId, tomorrow.start, tomorrow.end]
          )
        ).rows
      : [];

    // With nothing today, when the next visit is — a quiet day still knows what comes next.
    const next =
      showCalendar && appts.length === 0
        ? ((
            await c.query(
              `select ap.starts_at, p.full_name as patient_name from appointments ap join patients p on p.id = ap.patient_id
                where ap.clinic_id = $1 and ap.starts_at >= $2 and ap.status not in ('cancelled','no_show')
                order by ap.starts_at limit 1`,
              [a.clinicId, today.end]
            )
          ).rows[0] ?? null)
        : null;

    const dueBack = showCalendar ? await dueBackCount(c, a.clinicId) : 0;
    const setup = hasFullControl(a) ? await setupChecklist(c, a.clinicId) : null;
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
    const stock = a.clinic.features.aesthetic && can(a, "stock") ? await loadStockAttention(c, a.clinicId) : [];
    return { appts, stats, week, tomorrowRows, next, dueBack, setup, todo, stock };
  });

  const base = `/c/${slug}`;
  const money = (n: number) => fmtMoney(n, a.clinic.currency, locale);
  const now = DateTime.now().setZone(tz).setLocale(intl);
  const nowMs = now.toMillis();

  /* Where the day stands: finished (and missed), in the waiting room, with a doctor. */
  const stages = data.appts.map((r) => flowStage(r, nowMs));
  const finished = stages.filter((s) => s === "finished" || s === "no_show").length;
  const waiting = stages.filter((s) => s === "waiting").length;
  const total = data.appts.length;

  /* The welcome. */
  const hour = now.hour;
  const greeting = hour < 12 ? D.goodMorning : hour < 17 ? D.goodAfternoon : D.goodEvening;
  const name = shortName(a.session.user.fullName);

  /*
    Four figure cards at most, chosen by what this member may see — so a
    receptionist without the money gets the week's bookings where the takings
    would be, and the row is never a gap.
  */
  const cards: FigureCard[] = [
    {
      key: "today",
      href: showCalendar ? `${base}/calendar` : undefined,
      icon: CalendarDays,
      label: D.todayAppointments,
      value: String(total),
      sub: total > 0 ? `${D.finishedN.replace("{n}", String(finished))} · ${D.waitingN.replace("{n}", String(waiting))}` : D.noneYetToday,
      progress: total > 0 ? finished / total : undefined,
    },
    showRevenue
      ? {
          key: "collected-today",
          href: `${base}/invoices`,
          icon: Banknote,
          label: t.invoices.collectedToday,
          value: money(data.stats.collected_today ?? 0),
          sub: D.last7,
          spark: data.week.map((w) => Number(w.taken ?? 0)),
        }
      : {
          key: "week",
          href: showCalendar ? `${base}/calendar` : undefined,
          icon: CalendarCheck,
          label: D.thisWeek,
          value: String(data.week.reduce((s, w) => s + Number(w.visits), 0)),
          sub: D.last7,
          spark: data.week.map((w) => Number(w.visits)),
        },
    ...(isAgency
      ? [
          { key: "demos", href: `${base}/calendar`, icon: CalendarCheck, label: D.demosMonth, value: String(data.stats.self_booked ?? 0), sub: "" },
          ...(showPatients
            ? [{ key: "leads", href: `${base}/patients?status=lead`, icon: Target, label: t.patients.statusLead, value: String(data.stats.leads ?? 0), sub: "" }]
            : []),
        ]
      : [
          ...(showInbox
            ? [
                {
                  key: "unread",
                  href: `${base}/conversations`,
                  icon: MessageCircle,
                  label: D.unreadConversations,
                  value: String(data.stats.unread ?? 0),
                  sub: (data.stats.unread ?? 0) > 0 ? D.waitingReply : D.allAnswered,
                },
              ]
            : []),
          ...(showPatients
            ? [
                {
                  key: "patients",
                  href: `${base}/patients`,
                  icon: Users,
                  label: D.patients,
                  value: Number(data.stats.patients ?? 0).toLocaleString(intl),
                  sub: D.newThisMonth.replace("{n}", String(data.stats.new_patients ?? 0)),
                },
              ]
            : []),
        ]),
  ].slice(0, 4);

  /*
    What is waiting on a person. A row this member may see stays at zero — "nothing waiting" is an
    answer; the parts that come and go (To do, stock, setup) disappear when empty. Unread messages
    are a card above, so they are not repeated here.
  */
  const rows: NeedsRow[] = [
    ...(showCalendar
      ? [{ key: "unconfirmed", href: `${base}/calendar?show=unconfirmed`, icon: CalendarClock, label: D.unconfirmed, count: data.stats.unconfirmed ?? 0 }]
      : []),
    ...(showMoney
      ? [{ key: "unpaid", href: `${base}/invoices?status=unpaid`, icon: ReceiptText, label: D.unpaidInvoices, count: data.stats.unpaid ?? 0 }]
      : []),
    ...(showCalendar
      ? [{ key: "due-back", href: `${base}/calendar?tab=waitlist`, icon: CalendarPlus, label: t.finishVisit.dueBack, count: data.dueBack }]
      : []),
  ];
  const setupLeft = data.setup && data.setup.some((i) => !i.done) ? data.setup : null;
  const tomorrowTotal = Number(data.tomorrowRows[0]?.total ?? 0);
  const time = (iso: string) => DateTime.fromJSDate(new Date(iso)).setZone(tz).toFormat("HH:mm");

  return (
    <>
      <Welcome
        greeting={name ? `${greeting}${locale === "ar" ? "، " : ", "}${name}` : greeting}
        date={now.toFormat("cccc d LLLL")}
        line={D.welcomeLine}
        actions={
          <>
            {showCalendar && (
              <Link href={`${base}/calendar?new=1`} className={buttonClass({ className: "!bg-white !text-night hover:!bg-white/90" })}>
                <CalendarPlus className="h-4 w-4" />
                {t.calendar.newAppointment}
              </Link>
            )}
            {showPatients && (
              <Link
                href={`${base}/patients?new=1`}
                className={buttonClass({ variant: "outline", className: "!border-white/25 !bg-white/5 !text-white hover:!bg-white/15" })}
              >
                <UserPlus className="h-4 w-4" />
                {t.patients.newPatient}
              </Link>
            )}
          </>
        }
      />

      {/*
        grid-cols-1 below lg, not a bare grid: an implicit column is floored at
        the min-content width of its widest child. On a phone the day comes
        straight after the welcome — a doctor between rooms opens this for who
        is next — and the figures follow it.
      */}
      <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <div
          className={`order-2 grid grid-cols-2 gap-3 lg:order-1 lg:col-span-3 ${cards.length >= 4 ? "xl:grid-cols-4" : cards.length === 3 ? "lg:grid-cols-3" : ""}`}
          data-figures
        >
          {cards.map((card) => (
            <Figure key={card.key} card={card} />
          ))}
        </div>

        <div className="order-1 lg:order-2 lg:col-span-2">
          <Card>
            <CardHeader
              title={D.todayAppointments}
              action={
                showCalendar ? (
                  <Link href={`${base}/calendar`} className="flex items-center gap-1 text-[0.8125rem] font-medium text-brand-700 hover:text-brand-800">
                    {D.viewCalendar}
                    <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
                  </Link>
                ) : undefined
              }
            />
            {data.appts.length === 0 ? (
              /* A quiet day, said kindly — and what comes next, so it is not a dead end. */
              <div className="flex flex-col items-center px-6 py-10 text-center" data-today-empty>
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-brand-700 ring-1 ring-brand-100">
                  <Sunrise className="h-6 w-6" strokeWidth={1.75} />
                </span>
                <p className="mt-3 font-display text-base font-semibold text-ink-900">{D.noAppointmentsToday}</p>
                {data.next && (
                  <p className="mt-1 text-[0.8125rem] text-ink-500">
                    {D.nextVisit.replace(
                      "{when}",
                      `${DateTime.fromJSDate(new Date(data.next.starts_at)).setZone(tz).setLocale(intl).toFormat("ccc d LLL, HH:mm")} · ${data.next.patient_name}`
                    )}
                  </p>
                )}
                {showCalendar && (
                  <Link href={`${base}/calendar?new=1`} className={buttonClass({ variant: "outline", size: "sm", className: "mt-4" })}>
                    <CalendarPlus className="h-4 w-4" />
                    {D.bookOne}
                  </Link>
                )}
              </div>
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
        </div>

        <div className="order-3 flex flex-col gap-4">
          {(rows.length > 0 || data.todo.length > 0 || data.stock.length > 0 || setupLeft) && (
            <div data-needs-you>
              <Card>
                <CardHeader title={D.needsYou} />
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

          {showCalendar && (
            <div data-tomorrow>
              <Card>
                <CardHeader
                  title={D.tomorrow}
                  action={
                    tomorrowTotal > 0 ? (
                      <span className="rounded-full bg-ink-900/5 px-2 py-0.5 text-[0.75rem] font-semibold text-ink-500 tnum">{tomorrowTotal}</span>
                    ) : undefined
                  }
                />
                {data.tomorrowRows.length === 0 ? (
                  <p className="px-5 py-4 text-[0.8125rem] text-ink-400">{D.nothingTomorrow}</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {data.tomorrowRows.map((r) => (
                      <li key={r.id} className="flex items-center gap-3 px-5 py-2.5 text-[0.8125rem]">
                        <span className="w-11 shrink-0 font-semibold text-ink-900 tnum">{time(r.starts_at)}</span>
                        <span className="min-w-0 flex-1 truncate text-ink-700">{r.patient_name}</span>
                        {r.doctor_name && <span className="hidden max-w-[40%] truncate text-[0.75rem] text-ink-400 sm:inline">{r.doctor_name}</span>}
                      </li>
                    ))}
                    {tomorrowTotal > data.tomorrowRows.length && (
                      <li>
                        <Link
                          href={`${base}/calendar`}
                          className="flex items-center justify-between px-5 py-2.5 text-[0.75rem] font-medium text-brand-700 hover:bg-ink-900/4"
                        >
                          {D.tomorrowMore.replace("{n}", String(tomorrowTotal - data.tomorrowRows.length))}
                          <ChevronRight className="h-4 w-4 rtl:rotate-180" />
                        </Link>
                      </li>
                    )}
                  </ul>
                )}
              </Card>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** "د. سامر القيسي" → "د. سامر"; "Dr. Lina Mansour" → "Dr. Lina"; "Rana Haddad" → "Rana". */
function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1 && /^(د\.?|dr\.?)$/i.test(parts[0])) return `${parts[0]} ${parts[1]}`;
  return parts[0] ?? "";
}

/**
 * The greeting, on the brand's night surface with two of its soft shapes —
 * the same art that meets everybody at sign-in, so the first screen after it
 * feels like the same place. White on near-black in both themes.
 */
function Welcome({ greeting, date, line, actions }: { greeting: string; date: string; line: string; actions: React.ReactNode }) {
  return (
    <section
      className="welcome-art relative isolate overflow-hidden rounded-card px-4 py-4 text-white ring-1 ring-white/5 sm:px-5 sm:py-6 md:px-8 md:py-8"
      data-welcome
    >
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <p className="text-[0.75rem] font-medium text-white/60 sm:text-[0.8125rem]">{date}</p>
          <h1 className="mt-0.5 font-display text-[1.375rem] font-bold leading-tight sm:mt-1 sm:text-[1.625rem] md:text-[2rem]">{greeting}</h1>
          <p className="mt-1.5 text-sm text-white/70 max-sm:hidden">{line}</p>
        </div>
        {/*
          Not on a phone: there the welcome is one slim line, so a doctor's list
          is on the first screen (qa-connections), and the tab bar already
          reaches Appointments and Patients.
        */}
        <div className="flex flex-wrap gap-2 max-sm:hidden">{actions}</div>
      </div>
    </section>
  );
}

type FigureCard = {
  key: string;
  href?: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  value: string;
  sub: string;
  /** How far through the day: finished of booked. */
  progress?: number;
  /** The last seven days, oldest first. */
  spark?: number[];
};

/**
 * One figure: its name and mark, the number large, a quiet line under it, and
 * — where it helps — how far through the day or the week's shape.
 *
 * The number is sized to its card, not only to the screen: the currency is the
 * one part of a money figure that must never be the part an ellipsis eats.
 */
function Figure({ card }: { card: FigureCard }) {
  const Icon = card.icon;
  const body = (
    <div className="@container flex h-full flex-col rounded-card border border-line bg-surface p-4 shadow-card transition-[border-color,box-shadow] duration-140 ease-out group-hover:border-line-strong group-hover:shadow-pop" data-figure={card.key}>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[0.8125rem] font-medium text-ink-500">{card.label}</span>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-brand-100">
          <Icon className="h-4 w-4" strokeWidth={1.9} />
        </span>
      </div>
      <div
        className="mt-2 font-display font-bold leading-none text-ink-900 tnum"
        style={{ fontSize: `min(1.75rem, ${(100 / (Math.max(4, card.value.length) * 0.62)).toFixed(1)}cqi)` }}
      >
        {card.value}
      </div>
      {card.sub && <div className="mt-2 truncate text-[0.75rem] text-ink-500">{card.sub}</div>}
      {card.progress !== undefined && (
        <div className="mt-auto pt-3" aria-hidden>
          <div className="h-1.5 overflow-hidden rounded-full bg-chart-soft">
            <div className="h-full rounded-full bg-chart" style={{ width: `${Math.round(card.progress * 100)}%` }} data-chart-mark />
          </div>
        </div>
      )}
      {card.spark && (
        <div className="mt-auto pt-2">
          <Sparkline values={card.spark} className="h-8" />
        </div>
      )}
    </div>
  );
  return card.href ? (
    <Link href={card.href} className="group block rounded-card">
      {body}
    </Link>
  ) : (
    <div>{body}</div>
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
  What is left to set up, folded behind one line with its progress (setup
  belongs behind a button). Open, every step is a link to the page that does
  it, ticked when the clinic has done it. The line goes when the last is done.
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
              {i.done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-brand-700" /> : <Circle className="h-4 w-4 shrink-0 text-ink-300" />}
              <span className={`min-w-0 flex-1 ${i.done ? "text-ink-400 line-through" : "text-ink-900"}`}>{t.setup.items[i.key].label}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
