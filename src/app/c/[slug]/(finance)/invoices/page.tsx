import Link from "next/link";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { dayRangeUtc, weekRangeUtc, monthRangeUtc, fmtMoney, fmtDate } from "@/lib/dates";
import { PageHeader, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { redirect } from "next/navigation";
import { Plus, ReceiptText, Download } from "lucide-react";
import { can } from "@/lib/auth";
import { invoiceScopeSql, ownInvoicesOnly } from "@/lib/invoice-scope";

const invStatus: Record<string, StatusKey> = {
  draft: "neutral",
  sent: "pending",
  partially_paid: "pending",
  paid: "confirmed",
  void: "cancelled",
};

export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string; status?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);
  if (!can(access, "invoices")) redirect(`/c/${slug}`);
  const t = await dictForClinic(access.clinic.vocabulary);
  const locale = await getLocale();
  const tab = sp.tab === "payments" ? "payments" : "invoices";

  const tz = access.clinic.timezone;
  /*
    The totals across the top are the clinic's takings, which is a different
    question from whether somebody may raise and settle an invoice. A receptionist
    can be given the till without being shown the month's revenue.

    The query behind them does not run for a member who may not see the answer —
    the same rule the dashboard already follows, and the reason a hidden section
    there cannot leak through a page that everybody can open.
  */
  /*
    And a member whose list is filtered to their own work gets no clinic totals
    on top of it, whatever else they hold. A screen that filters the rows and
    then sums every row in the clinic above them is not a narrower view of the
    clinic, it is two different answers stacked — and the larger one is the
    number being withheld.
  */
  const showTotals = can(access, "invoices.analytics") && !ownInvoicesOnly(access);

  const data = await inClinic(access, async (c) => {
    const today = dayRangeUtc(tz);
    const week = weekRangeUtc(tz);
    const month = monthRangeUtc(tz);

    /*
      `partial_count` is not one of the totals — it is the number beside the
      "Partly paid" filter chip, and a member who can work the list needs it
      whether or not they may see money. So it is asked for either way, and the
      four sums are only added to the statement when they will be shown.
    */
    /*
      The chip counts what this member can actually open. Dead in the totals
      branch — a filtered member never reaches it, see `showTotals` — and
      written generally anyway, because the next person to move one of these
      branches should not have to notice that.
    */
    const chipScope = invoiceScopeSql(access, "i", showTotals ? 8 : 2);
    const [stats] = (
      await c.query(
        showTotals
          ? `select
               (select coalesce(sum(amount), 0) from payments where clinic_id = $1 and paid_at >= $2 and paid_at < $3) as today,
               (select coalesce(sum(amount), 0) from payments where clinic_id = $1 and paid_at >= $4 and paid_at < $5) as week,
               (select coalesce(sum(amount), 0) from payments where clinic_id = $1 and paid_at >= $6 and paid_at < $7) as month,
               (select coalesce(sum(total - amount_paid), 0) from invoices where clinic_id = $1 and status in ('sent', 'partially_paid')) as outstanding,
               (select count(*) from invoices i where i.clinic_id = $1 and i.status = 'partially_paid'${chipScope.sql})::int as partial_count`
          : `select (select count(*) from invoices i where i.clinic_id = $1 and i.status = 'partially_paid'${chipScope.sql})::int as partial_count`,
        showTotals
          ? [access.clinicId, today.start, today.end, week.start, week.end, month.start, month.end, ...chipScope.params]
          : [access.clinicId, ...chipScope.params]
      )
    ).rows;

    let invoices: Record<string, unknown>[] = [];
    let payments: Record<string, unknown>[] = [];
    if (tab === "invoices") {
      const conds = ["i.clinic_id = $1"];
      /*
        Partly paid is its own filter, not a shade of unpaid. "Owes something"
        and "has started paying" are different conversations to have with a
        patient, and lumping them together was why the second one was invisible.
      */
      if (sp.status === "unpaid") conds.push(`i.status in ('sent', 'partially_paid')`);
      else if (sp.status === "partial") conds.push(`i.status = 'partially_paid'`);
      else if (sp.status === "paid") conds.push(`i.status = 'paid'`);
      const scope = invoiceScopeSql(access, "i", 2);
      invoices = (
        await c.query(
          `select i.id, i.number, i.title, i.status, i.total, i.amount_paid, i.created_at, i.sent_at,
                  p.full_name as patient_name
           from invoices i join patients p on p.id = i.patient_id
           where ${conds.join(" and ")}${scope.sql}
           order by i.created_at desc limit 100`,
          [access.clinicId, ...scope.params]
        )
      ).rows;
    } else {
      // Payments hang off invoices, so the same filter reaches them through the
      // join rather than needing one of its own.
      const scope = invoiceScopeSql(access, "i", 2);
      payments = (
        await c.query(
          `select pay.id, pay.amount, pay.method, pay.reference, pay.paid_at,
                  i.number, i.id as invoice_id, i.total, i.amount_paid, i.status as invoice_status,
                  p.full_name as patient_name, u.full_name as recorded_by
           from payments pay
           join invoices i on i.id = pay.invoice_id
           join patients p on p.id = pay.patient_id
           left join users u on u.id = pay.recorded_by
           where pay.clinic_id = $1${scope.sql}
           order by pay.paid_at desc limit 100`,
          [access.clinicId, ...scope.params]
        )
      ).rows;
    }
    return { stats, invoices, payments };
  });

  const base = `/c/${slug}/invoices`;

  return (
    <>
      <PageHeader
        title={t.invoices.title}
        action={
          <div className="flex gap-2">
            {/* Behind the same capability as the totals it sits above. The
                route refuses it either way now; this stops offering a button
                that answers 403. */}
            {showTotals && (
              <a href={`/api/c/${slug}/payments/export`} download>
                <Button variant="outline">
                  <Download className="h-4 w-4" />
                  {t.invoices.exportCsv}
                </Button>
              </a>
            )}
            <Link href={`${base}/new`}>
              <Button>
                <Plus className="h-4 w-4" />
                {t.invoices.newInvoice}
              </Button>
            </Link>
          </div>
        }
      />

      {showTotals && (
        <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
          {(
            [
              [t.invoices.todayTotal, data.stats.today],
              [t.invoices.weekTotal, data.stats.week],
              [t.invoices.monthTotal, data.stats.month],
              [t.invoices.outstanding, data.stats.outstanding],
            ] as [string, string][]
          ).map(([label, val], i) => (
            <Card key={i} className="p-4">
              <div className="text-[13px] text-ink-500">{label}</div>
              <div className="mt-1 text-xl font-semibold tnum">{fmtMoney(Number(val), access.clinic.currency, locale)}</div>
            </Card>
          ))}
        </div>
      )}

      {/*
        Invoices and Payments used to be a strip of their own here. They are
        tabs of the Finance section now, drawn once above this page — two
        identical strips stacked, with the word "Invoices" in both, was three
        rows of chrome before the first invoice. What is left is the filter,
        which belongs to this list and not to the section.
      */}
      {tab === "invoices" && (
        <div className="mb-4 flex flex-wrap items-center gap-1">
          {(
            [
              ["", t.invoices.allFilter, 0],
              ["unpaid", t.invoices.unpaidFilter, 0],
              ["partial", t.invoices.partlyPaidFilter, Number(data.stats.partial_count)],
              ["paid", t.invoices.paidFilter, 0],
            ] as [string, string, number][]
          ).map(([key, label, count]) => {
            const on = (sp.status ?? "") === key;
            return (
              <Link
                key={key || "all"}
                href={key ? `${base}?status=${key}` : base}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors duration-140 ease-out ${
                  on ? "bg-st-pending-soft text-st-pending" : "bg-ink-900/4 text-ink-500 hover:text-ink-700"
                }`}
              >
                {label}
                {count > 0 && <span className="ms-1.5 tnum">{count}</span>}
              </Link>
            );
          })}
        </div>
      )}

      {tab === "invoices" ? (
        data.invoices.length === 0 ? (
          <EmptyState
            icon={<ReceiptText />}
            title={t.invoices.empty}
            body={t.invoices.emptyBody}
            action={
              <Link href={`${base}/new`}>
                <Button>{t.invoices.newInvoice}</Button>
              </Link>
            }
          />
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {data.invoices.map((inv) => {
                const total = Number(inv.total);
                const paid = Number(inv.amount_paid);
                const left = total - paid;
                const partial = String(inv.status) === "partially_paid";
                return (
                  <li key={String(inv.id)}>
                    {/*
                      Three fixed columns — 144 + 128 + 112 — plus gaps and
                      padding come to more than a phone is wide, so the row used
                      to push the entire page sideways. The widths earn their
                      keep on a desktop, where they line the numbers up into
                      columns; on a phone they are dropped and the row is allowed
                      to wrap instead.
                    */}
                    <Link
                      href={`${base}/${inv.id}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-sunken sm:flex-nowrap sm:gap-4 sm:px-5"
                    >
                      <span className="w-24 shrink-0 truncate text-sm font-semibold tnum sm:w-36" dir="ltr">
                        {String(inv.number)}
                      </span>
                      {/*
                        The name the clinic gave this invoice, after the person it
                        is for. Both truncate inside one min-w-0 column, so a long
                        title shortens rather than widening the row — the same
                        rule the rest of this list already follows.
                      */}
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate text-sm">{String(inv.patient_name)}</span>
                        {inv.title ? (
                          <span className="truncate text-[13px] text-ink-400">
                            {String(inv.title)}
                          </span>
                        ) : null}
                      </span>
                      <span className="hidden text-[13px] text-ink-400 sm:block">
                        {fmtDate(String(inv.created_at), tz, locale)}
                      </span>
                      {/*
                        A partly paid row shows the money, not just the word.
                        "Partly paid" next to the full total is the one thing
                        reception cannot act on — what they need to say on the
                        phone is how much is still owed.
                      */}
                      <span className="shrink-0 text-end sm:w-32">
                        <span className="block text-sm font-semibold tnum">
                          {fmtMoney(partial ? paid : total, access.clinic.currency, locale)}
                        </span>
                        {partial && (
                          <span className="block text-[12px] text-ink-400 tnum">
                            {t.invoices.ofTotal.replace(
                              "{total}",
                              fmtMoney(total, access.clinic.currency, locale)
                            )}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-end sm:w-28">
                        <Badge status={invStatus[String(inv.status)] ?? "neutral"}>
                          {(t.invoices.statuses as Record<string, string>)[String(inv.status)]}
                        </Badge>
                        {partial && (
                          <span className="mt-0.5 block text-[12px] font-medium text-st-pending tnum">
                            {t.invoices.leftToPay.replace(
                              "{amount}",
                              fmtMoney(left, access.clinic.currency, locale)
                            )}
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        )
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {data.payments.map((p) => {
              // Whether this payment closed the invoice or left a balance. The
              // ledger otherwise shows an amount with no way to tell a deposit
              // from a settlement.
              const stillDue = Number(p.total) - Number(p.amount_paid);
              const open = String(p.invoice_status) !== "paid" && stillDue > 0;
              return (
              <li key={String(p.id)} className="flex items-center gap-4 px-5 py-3">
                <span className="w-24 shrink-0 text-sm font-semibold tnum">
                  {fmtMoney(Number(p.amount), access.clinic.currency, locale)}
                </span>
                <Badge status="brand">
                  {(t.invoices.methods as Record<string, string>)[String(p.method)] ?? String(p.method)}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {String(p.patient_name)}
                  <span
                    className={`ms-2 text-[12px] ${open ? "text-st-pending" : "text-ink-400"}`}
                  >
                    {open
                      ? t.invoices.leftBalance.replace(
                          "{amount}",
                          fmtMoney(stillDue, access.clinic.currency, locale)
                        )
                      : t.invoices.settled}
                  </span>
                </span>
                <Link href={`${base}/${p.invoice_id}`} className="text-[13px] text-brand-700 tnum" dir="ltr">
                  {String(p.number)}
                </Link>
                <span className="hidden text-[13px] text-ink-400 sm:block">
                  {fmtDate(String(p.paid_at), tz, locale)}
                </span>
              </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
