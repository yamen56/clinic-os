import Link from "next/link";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { getDict, getLocale } from "@/lib/i18n";
import { dayRangeUtc, weekRangeUtc, monthRangeUtc, fmtMoney, fmtDate } from "@/lib/dates";
import { PageHeader, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { redirect } from "next/navigation";
import { Plus, ReceiptText, Download } from "lucide-react";
import { can } from "@/lib/auth";

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
  const t = await getDict();
  const locale = await getLocale();
  const tab = sp.tab === "payments" ? "payments" : "invoices";

  const tz = access.clinic.timezone;

  const data = await inClinic(access, async (c) => {
    const today = dayRangeUtc(tz);
    const week = weekRangeUtc(tz);
    const month = monthRangeUtc(tz);

    const [stats] = (
      await c.query(
        `select
           (select coalesce(sum(amount), 0) from payments where clinic_id = $1 and paid_at >= $2 and paid_at < $3) as today,
           (select coalesce(sum(amount), 0) from payments where clinic_id = $1 and paid_at >= $4 and paid_at < $5) as week,
           (select coalesce(sum(amount), 0) from payments where clinic_id = $1 and paid_at >= $6 and paid_at < $7) as month,
           (select coalesce(sum(total - amount_paid), 0) from invoices where clinic_id = $1 and status in ('sent', 'partially_paid')) as outstanding,
           (select count(*) from invoices where clinic_id = $1 and status = 'partially_paid')::int as partial_count`,
        [access.clinicId, today.start, today.end, week.start, week.end, month.start, month.end]
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
      invoices = (
        await c.query(
          `select i.id, i.number, i.status, i.total, i.amount_paid, i.created_at, i.sent_at,
                  p.full_name as patient_name
           from invoices i join patients p on p.id = i.patient_id
           where ${conds.join(" and ")}
           order by i.created_at desc limit 100`,
          [access.clinicId]
        )
      ).rows;
    } else {
      payments = (
        await c.query(
          `select pay.id, pay.amount, pay.method, pay.reference, pay.paid_at,
                  i.number, i.id as invoice_id, i.total, i.amount_paid, i.status as invoice_status,
                  p.full_name as patient_name, u.full_name as recorded_by
           from payments pay
           join invoices i on i.id = pay.invoice_id
           join patients p on p.id = pay.patient_id
           left join users u on u.id = pay.recorded_by
           where pay.clinic_id = $1
           order by pay.paid_at desc limit 100`,
          [access.clinicId]
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
            <a href={`/api/c/${slug}/payments/export`} download>
              <Button variant="outline">
                <Download className="h-4 w-4" />
                {t.invoices.exportCsv}
              </Button>
            </a>
            <Link href={`${base}/new`}>
              <Button>
                <Plus className="h-4 w-4" />
                {t.invoices.newInvoice}
              </Button>
            </Link>
          </div>
        }
      />

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

      <div className="mb-4 flex gap-1 border-b border-line">
        {[
          { key: "invoices", label: t.invoices.title, href: base },
          { key: "payments", label: t.invoices.payments, href: `${base}?tab=payments` },
        ].map((x) => (
          <Link
            key={x.key}
            href={x.href}
            className={`relative px-3.5 py-2.5 text-sm font-medium ${
              tab === x.key ? "text-brand-700" : "text-ink-500 hover:text-ink-900"
            }`}
          >
            {x.label}
            {tab === x.key && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
          </Link>
        ))}
        {tab === "invoices" && (
          <div className="ms-auto flex flex-wrap items-center gap-1 self-center">
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
      </div>

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
                    <Link href={`${base}/${inv.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-sunken">
                      <span className="w-36 shrink-0 text-sm font-semibold tnum" dir="ltr">
                        {String(inv.number)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">{String(inv.patient_name)}</span>
                      <span className="hidden text-[13px] text-ink-400 sm:block">
                        {fmtDate(String(inv.created_at), tz, locale)}
                      </span>
                      {/*
                        A partly paid row shows the money, not just the word.
                        "Partly paid" next to the full total is the one thing
                        reception cannot act on — what they need to say on the
                        phone is how much is still owed.
                      */}
                      <span className="w-32 shrink-0 text-end">
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
                      <span className="w-28 shrink-0 text-end">
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
