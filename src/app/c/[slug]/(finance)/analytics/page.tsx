import Link from "next/link";
import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { ArrowDownRight, ArrowUpRight, Download, Minus } from "lucide-react";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { can, hasFullControl } from "@/lib/auth";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { fmtMoney } from "@/lib/dates";
import { ownInvoicesOnly } from "@/lib/invoice-scope";
import { round2 } from "@/lib/invoices";
import { asPeriodParam } from "@/lib/finance-periods";
import { financeAnalytics, firstMoneyDate, periodOf, type Period, type SeriesPoint } from "@/lib/finance-analytics";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { buttonClass } from "@/components/ui/button-class";
import { RowBar } from "@/components/ui/chart";
import { PeriodPicker, type MenuYear } from "./period-picker";
import { TrendChart, type TrendPoint } from "./trend-chart";

/**
 * The clinic's money, in depth.
 *
 * The invoices screen is for working: raise one, take its payment, check the
 * day against the drawer. This one is for reading — what came in over a
 * period and how that compares with the period before, what was invoiced,
 * what went out, what was kept, who pays how, what earns, and who still owes.
 * The week, month and outstanding tiles that used to sit above the invoice
 * list moved here (Yamen, 2026-11-15). Any stretch of time can be read: this
 * month, this year, all time, or any one month or year (lib/finance-periods).
 *
 * Behind `invoices.analytics`, which no job starts with: an owner ticks it for
 * the person who should see the takings. Never for a member whose invoices are
 * filtered to their own work, whatever they were ticked — every figure here is
 * the clinic's. And two parts answer to grants of their own: what was spent
 * needs `expenses`, and the doctors' shares need whoever holds the clinic.
 */
export default async function FinanceAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ p?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);
  /*
    The page gates itself. The section's layout draws the tab from the same two
    conditions, but a layout is not a gate — Next renders it and this page
    concurrently — and this URL can be typed.
  */
  if (!can(access, "invoices.analytics") || ownInvoicesOnly(access)) redirect(`/c/${slug}`);

  const t = await dictForClinic(access.clinic.vocabulary);
  const F = t.finance;
  const locale = await getLocale();
  const intl = locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB";
  const tz = access.clinic.timezone;
  const currency = access.clinic.currency;
  const money = (n: number) => fmtMoney(n, currency, locale);

  const showSpend = can(access, "expenses");
  const showShares = hasFullControl(access);

  /*
    When the clinic's money starts decides two things: where all time begins,
    and how far back the month menu reaches. Asked first, on the same
    connection, because the period depends on it.
  */
  const { a, period, since } = await inClinic(access, async (c) => {
    const since = await firstMoneyDate(c, access.clinicId);
    const period = periodOf(tz, asPeriodParam(sp.p), since);
    const a = await financeAnalytics(
      c,
      { clinicId: access.clinicId, tz, period, dental: !!access.clinic.features.dental },
      { spend: showSpend, shares: showShares }
    );
    return { a, period, since };
  });

  const day = (d: DateTime, withYear: boolean) => d.setLocale(intl).toFormat(withYear ? "d LLL yyyy" : "d LLL");
  // Half-open ranges end the day after the last one they cover.
  const span = (from: DateTime, to: DateTime) => {
    const last = to.minus({ days: 1 });
    return `${day(from, from.year !== last.year)} – ${day(last, true)}`;
  };

  const trend = (rows: SeriesPoint[]) => points(rows, period, intl);
  const menu = monthMenu(tz, since, intl, F.allOf);

  /*
    What was kept. Sales tax comes off because it was never the clinic's, the
    doctors' shares only for a reader who may know them, and what was spent only
    for one who may see it — so the chain stops where this member's sight does,
    rather than ending in a figure that is quietly missing a number.
  */
  const kept = a.spend ? round2(a.collected - (a.tax ?? 0) - (a.commission ?? 0) - a.spend.total) : null;

  const tiles: TileProps[] = [
    {
      label: F.collected,
      value: money(a.collected),
      delta: delta(a.collected, a.collectedPrev),
      upIsGood: true,
      sub: F.paymentsCount.replace("{n}", String(a.payments)),
      hook: "collected",
    },
    {
      label: F.invoiced,
      value: money(a.invoiced),
      delta: delta(a.invoiced, a.invoicedPrev),
      upIsGood: true,
      sub: F.invoicesCount.replace("{n}", String(a.invoices)),
      hook: "invoiced",
    },
    ...(a.spend
      ? [
          {
            label: F.spent,
            value: money(a.spend.total),
            delta: delta(a.spend.total, a.spend.prev),
            upIsGood: false,
            sub: a.spend.toPay > 0 ? F.toPay.replace("{amount}", money(a.spend.toPay)) : "",
            hook: "spent",
          },
          {
            label: a.commission === null ? F.afterExpenses : t.earnings.kept,
            value: money(kept ?? 0),
            negative: (kept ?? 0) < 0,
            sub: a.collected > 0 ? F.ofCollected.replace("{pct}", String(Math.round(((kept ?? 0) / a.collected) * 100))) : "",
            hook: "kept",
          },
        ]
      : [
          {
            label: F.averageInvoice,
            value: money(a.invoices > 0 ? a.invoiced / a.invoices : 0),
            sub: a.invoiced > 0 ? F.paidSoFar.replace("{pct}", String(Math.round((a.invoicedPaid / a.invoiced) * 100))) : "",
            hook: "average",
          },
        ]),
    {
      label: F.owed,
      value: money(a.owed.total),
      sub: F.owedNow.replace("{n}", String(a.owed.invoices)),
      hook: "owed",
    },
  ];

  const methodsTotal = a.methods.reduce((s, m) => s + m.amount, 0);
  const servicesMax = Math.max(0, ...a.services.map((s) => s.amount));
  const doctorsMax = Math.max(0, ...a.doctors.map((d) => d.amount));
  const agingMax = Math.max(0, ...a.owed.aging);
  const categoriesMax = Math.max(0, ...(a.spend?.categories ?? []).map((c) => c.total));
  const exportHref = `/api/c/${slug}/payments/export?from=${encodeURIComponent(period.from.toUTC().toISO()!)}&to=${encodeURIComponent(period.to.toUTC().toISO()!)}`;
  const thirdRow = (a.spend ? 1 : 0) + (a.services.length > 0 ? 1 : 0) + (a.doctors.length > 0 ? 1 : 0);
  const trendSub = period.bucket === "day" ? F.byDay : period.bucket === "month" ? F.byMonth : F.byYear;

  return (
    <div data-finance-analytics>
      <PageHeader
        title={F.title}
        sub={
          period.compare
            ? `${span(period.from, period.to)} · ${F.comparedWith.replace("{range}", span(period.prevFrom, period.prevTo))}`
            : F.allSince.replace("{date}", day(period.from, true))
        }
        action={
          <a href={exportHref} download className={buttonClass({ variant: "outline" })}>
            <Download className="h-4 w-4" />
            {t.invoices.exportCsv}
          </a>
        }
      />

      <PeriodPicker slug={slug} current={period.key} menu={menu} />

      {/*
        Five figures when the spending is in sight, four when it is not. Five
        never leave one alone beside a gap: on a phone the first — what came
        in, the number the page is opened for — takes the whole row, and on a
        tablet the first two share a row and the other three the next.
      */}
      <div className={`mb-4 grid grid-cols-2 gap-3 ${tiles.length === 5 ? "md:grid-cols-6 xl:grid-cols-5" : "xl:grid-cols-4"}`}>
        {tiles.map((tile, i) => (
          <Tile
            key={tile.hook}
            {...tile}
            className={
              tiles.length !== 5
                ? ""
                : i === 0
                  ? "col-span-2 md:col-span-3 xl:col-span-1"
                  : i === 1
                    ? "md:col-span-3 xl:col-span-1"
                    : "md:col-span-2 xl:col-span-1"
            }
            words={{ more: F.more, less: F.less, same: F.same }}
          />
        ))}
      </div>

      {/*
        A card with nothing to say is left out rather than drawn empty: a quiet
        month should read as a short page, not as six boxes each saying so. The
        chart stays, because "nothing came in" is itself the answer.
      */}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card className={a.methods.length > 0 ? "lg:col-span-2" : "lg:col-span-3"}>
          <CardHeader title={F.trendTitle} sub={trendSub} />
          <div className="px-5 py-4">
            {a.collected > 0 ? (
              <TrendChart data={trend(a.series)} locale={intl} currency={currency} />
            ) : (
              <Quiet>{F.nothingCollected}</Quiet>
            )}
          </div>
        </Card>

        {a.methods.length > 0 && (
          <Card>
            <CardHeader title={F.methodsTitle} />
            <ul className="divide-y divide-line">
              {a.methods.map((m) => (
                <Row
                  key={m.method}
                  name={(t.invoices.methods as Record<string, string>)[m.method] ?? m.method}
                  note={F.paymentsCount.replace("{n}", String(m.n))}
                  amount={money(m.amount)}
                  share={methodsTotal > 0 ? Math.round((m.amount / methodsTotal) * 100) : null}
                  value={m.amount}
                  max={a.methods[0].amount}
                />
              ))}
            </ul>
          </Card>
        )}
      </div>

      {a.spend && a.spend.total > 0 && (
        <div className="mb-4 grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title={F.spentTitle} sub={trendSub} />
            <div className="px-5 py-4">
              <TrendChart data={trend(a.spend.series)} locale={intl} currency={currency} />
            </div>
          </Card>

          <Card>
            <CardHeader title={t.expenses.byCategory} />
            <ul className="divide-y divide-line">
              {a.spend.categories.slice(0, 8).map((c) => (
                <Row
                  key={c.categoryId ?? "none"}
                  name={(locale === "ar" ? c.nameAr || c.name : c.name || c.nameAr) || F.uncategorised}
                  amount={money(c.total)}
                  share={a.spend!.total > 0 ? Math.round((c.total / a.spend!.total) * 100) : null}
                  value={c.total}
                  max={categoriesMax}
                />
              ))}
            </ul>
          </Card>
        </div>
      )}

      <div className={`mb-4 grid items-start gap-4 lg:grid-cols-2 ${thirdRow === 3 ? "xl:grid-cols-3" : ""}`}>
        {a.spend && (
          <Card>
            <CardHeader title={t.earnings.whatTheClinicKept} />
            <dl className="px-5 py-4 text-sm" data-kept={kept ?? undefined}>
              <Line label={t.earnings.collected} value={money(a.collected)} />
              {(a.tax ?? 0) > 0 && <Line label={t.earnings.salesTax} value={`− ${money(a.tax ?? 0)}`} />}
              {a.commission !== null && <Line label={t.earnings.doctorsShare} value={`− ${money(a.commission)}`} />}
              <Line label={t.earnings.expenses} value={`− ${money(a.spend.total)}`} />
              <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-line pt-3">
                <dt className="font-semibold text-ink-900">{a.commission === null ? F.afterExpenses : t.earnings.kept}</dt>
                <dd className={`font-display text-lg font-bold tnum ${(kept ?? 0) < 0 ? "text-danger" : "text-ink-900"}`}>
                  {money(kept ?? 0)}
                </dd>
              </div>
            </dl>
            <p className="border-t border-line px-5 py-3 text-[0.75rem] leading-relaxed text-ink-500">
              {a.commission === null ? F.afterExpensesNote : t.earnings.keptNote}
            </p>
          </Card>
        )}

        {a.services.length > 0 && (
          <Card>
            <CardHeader title={F.servicesTitle} sub={F.servicesSub} />
            <ul className="divide-y divide-line">
              {a.services.map((s) => (
                <Row
                  key={s.key}
                  name={locale === "ar" ? s.nameAr || s.name : s.name}
                  note={`× ${Number.isInteger(s.qty) ? s.qty : s.qty.toFixed(2)}`}
                  amount={money(s.amount)}
                  value={s.amount}
                  max={servicesMax}
                />
              ))}
            </ul>
          </Card>
        )}

        {a.doctors.length > 0 && (
          <Card>
            <CardHeader title={F.doctorsTitle} sub={F.doctorsSub} />
            <ul className="divide-y divide-line">
              {a.doctors.map((d) => (
                <Row
                  key={d.id}
                  name={d.name}
                  note={F.invoicesCount.replace("{n}", String(d.invoices))}
                  amount={money(d.amount)}
                  value={d.amount}
                  max={doctorsMax}
                />
              ))}
            </ul>
          </Card>
        )}
      </div>

      {/* What is owed is today's fact, not the period's — said in the card, so the chips above are not read into it. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card className={a.owed.invoices === 0 ? "lg:col-span-2" : ""}>
          <CardHeader title={F.owed} sub={F.owedSub} />
          {a.owed.invoices === 0 ? (
            <div className="px-5 py-4">
              <Quiet>{F.nothingOwed}</Quiet>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {([F.aging.d30, F.aging.d60, F.aging.d90, F.aging.older] as string[]).map((label, i) => (
                <Row
                  key={i}
                  name={label}
                  amount={money(a.owed.aging[i])}
                  share={a.owed.total > 0 ? Math.round((a.owed.aging[i] / a.owed.total) * 100) : null}
                  value={a.owed.aging[i]}
                  max={agingMax}
                />
              ))}
            </ul>
          )}
        </Card>

        {a.owed.invoices > 0 && (
          <Card>
            <CardHeader
              title={F.whoOwes}
              action={
                a.owed.invoices > 0 ? (
                  <Link href={`/c/${slug}/invoices?status=unpaid`} className={buttonClass({ variant: "ghost", size: "sm" })}>
                    {F.seeUnpaid}
                  </Link>
                ) : undefined
              }
            />
            {a.owed.patients.length === 0 ? (
              <div className="px-5 py-4">
                <Quiet>{F.nothingOwed}</Quiet>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {a.owed.patients.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="min-w-0 flex-1">
                      {can(access, "patients") ? (
                        <Link href={`/c/${slug}/patients/${p.id}`} className="block truncate text-sm font-medium text-ink-900 hover:underline">
                          {p.name}
                        </Link>
                      ) : (
                        <span className="block truncate text-sm font-medium text-ink-900">{p.name}</span>
                      )}
                      <span className="block text-[0.75rem] text-ink-400">{F.invoicesCount.replace("{n}", String(p.invoices))}</span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-ink-900 tnum">{money(p.owed)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

/** The change against the period before, as a whole percentage — or nothing, when there is nothing to measure against. */
function delta(now: number, before: number): number | null {
  if (!(before > 0)) return null;
  return Math.round(((now - before) / before) * 100);
}

/** The chart's points: a short label for under the axis, the full name for the readout. */
function points(rows: SeriesPoint[], period: Period, intl: string): TrendPoint[] {
  const years = new Set(rows.map((r) => r.bucket.slice(0, 4))).size > 1;
  return rows.map((r) => {
    const d = DateTime.fromISO(r.bucket).setLocale(intl);
    return period.bucket === "year"
      ? { label: d.toFormat("yyyy"), name: d.toFormat("yyyy"), value: r.amount }
      : period.bucket === "month"
        ? { label: d.toFormat(years ? "LLL yy" : "LLL"), name: d.toFormat("LLLL yyyy"), value: r.amount }
        : { label: d.toFormat("d LLL"), name: d.toFormat("cccc d LLLL"), value: r.amount };
  });
}

/**
 * The menu of single months and years, from the clinic's first record to last
 * month, newest first and grouped by year. This month and this year are the
 * switch beside it, so they are not repeated here; a past year opens with its
 * whole. Ten years at most — a menu, not an archive.
 */
function monthMenu(tz: string, since: Date | null, intl: string, allOf: string): MenuYear[] {
  if (!since) return [];
  const now = DateTime.now().setZone(tz).startOf("month");
  const first = DateTime.fromJSDate(since).setZone(tz).startOf("month");
  const out: MenuYear[] = [];
  for (let y = now.year; y >= Math.max(first.year, now.year - 9); y--) {
    const months: MenuYear["months"] = [];
    for (let m = 12; m >= 1; m--) {
      const d = DateTime.fromObject({ year: y, month: m, day: 1 }, { zone: tz });
      if (d >= now || d < first) continue;
      months.push({ value: d.toFormat("yyyy-MM"), label: d.setLocale(intl).toFormat("LLLL yyyy") });
    }
    const whole = y < now.year ? { value: String(y), label: allOf.replace("{year}", String(y)) } : null;
    if (months.length || whole) out.push({ year: y, whole, months });
  }
  return out;
}

type TileProps = {
  label: string;
  value: string;
  sub: string;
  /** Percent against the period before; absent on a figure that has no "before". */
  delta?: number | null;
  /** Whether more of this is good news — more collected is, more spent is not. */
  upIsGood?: boolean;
  negative?: boolean;
  /** For QA: which figure this is, whatever language it is labelled in. */
  hook: string;
};

function Tile({
  label,
  value,
  sub,
  delta: d,
  upIsGood = true,
  negative,
  hook,
  words,
  className = "",
}: TileProps & { words: { more: string; less: string; same: string }; className?: string }) {
  const good = d === null || d === undefined || d === 0 ? null : d > 0 === upIsGood;
  const Arrow = !d ? Minus : d > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <Card className={`p-4 ${className}`}>
      <div data-figure={hook}>
        <div className="text-[0.8125rem] text-ink-500">{label}</div>
        <div className={`mt-1.5 font-display text-[1.375rem] font-bold leading-tight ${negative ? "text-danger" : "text-ink-900"}`}>
          {value}
        </div>
        <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem] text-ink-400">
          {d !== null && d !== undefined && (
            /*
              Direction is the arrow and the word, never the colour alone: the
              tint only says whether the direction is good news, and the title
              spells it out for a screen reader.
            */
            <span
              title={(d === 0 ? words.same : d > 0 ? words.more : words.less).replace("{pct}", String(Math.abs(d)))}
              className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold tnum ${
                good === null
                  ? "bg-ink-900/5 text-ink-500"
                  : good
                    ? "bg-st-confirmed-soft text-st-confirmed"
                    : "bg-danger-soft text-danger"
              }`}
            >
              <Arrow className="h-3 w-3" aria-hidden />
              {Math.abs(d) > 999 ? "999+" : Math.abs(d)}%
            </span>
          )}
          {sub && <span>{sub}</span>}
        </div>
      </div>
    </Card>
  );
}

/** One row of a breakdown: a name, its amount, and a bar on the scale the whole card shares. */
function Row({
  name,
  note,
  amount,
  share,
  value,
  max,
}: {
  name: string;
  note?: string;
  amount: string;
  share?: number | null;
  value: number;
  max: number;
}) {
  return (
    <li className="px-5 py-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[0.8125rem]">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-ink-900">{name}</span>
          {note && <span className="shrink-0 text-[0.75rem] text-ink-400 tnum">{note}</span>}
        </span>
        <span className="shrink-0 tnum">
          <span className="font-semibold text-ink-900">{amount}</span>
          {share !== null && share !== undefined && <span className="ms-2 inline-block w-9 text-end text-[0.75rem] text-ink-400">{share}%</span>}
        </span>
      </div>
      <RowBar value={value} max={max} />
    </li>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-ink-900 tnum">{value}</dd>
    </div>
  );
}

/** An empty card says so in a line. A drawing of a chart with nothing in it would be decoration. */
function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[0.8125rem] text-ink-400">{children}</p>;
}
