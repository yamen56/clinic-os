import Link from "next/link";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { dictForClinic, getLocale } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n/client-dict";
import { dayRangeUtc, fmtMoney, fmtDate, fmtDateOnly } from "@/lib/dates";
import { PageHeader, Card } from "@/components/ui/card";
import { buttonClass } from "@/components/ui/button-class";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { redirect } from "next/navigation";
import { Plus, ReceiptText } from "lucide-react";
import { can } from "@/lib/auth";
import { invoiceDaySql, invoiceScopeSql, ownInvoicesOnly, paymentDaySql, todayOnly } from "@/lib/invoice-scope";
import { deskLines, readyToBillDesk } from "@/lib/charts/dental/billing-server";
import { ReadyToBillDesk, type DeskGroup } from "./ready-to-bill-desk";
import { DELETABLE_INVOICE_SQL, owedSql } from "@/lib/invoices";
import { patientSearchClause } from "@/lib/patients";
import { DeleteCancelled } from "./delete-cancelled";
import { InvoiceSearch } from "./invoice-search";
import { ListSwitch } from "./list-switch";

/* The list grows a page at a time from the newest; past this it is a search, not a scroll. */
const PAGE = 100;
const MAX_ROWS = 1000;

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
  searchParams: Promise<{ tab?: string; status?: string; q?: string; n?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);
  if (!can(access, "invoices")) redirect(`/c/${slug}`);
  const t = await dictForClinic(access.clinic.vocabulary);
  const locale = await getLocale();
  const tab = sp.tab === "payments" ? "payments" : "invoices";
  const cancelledView = tab === "invoices" && sp.status === "cancelled";
  const q = (sp.q ?? "").trim().slice(0, 80);
  const limit = Math.min(MAX_ROWS, Math.max(PAGE, Math.ceil((Number(sp.n) || PAGE) / PAGE) * PAGE));

  const tz = access.clinic.timezone;
  /*
    What was collected today, for whoever works this list (Yamen, 2026-11-15):
    the desk takes the money and has to be able to check its own day against
    the drawer at closing. It is the one figure left here — the week, the month
    and what is outstanding moved to the Analytics tab, behind
    `invoices.analytics`, and no longer ride on this screen.

    Not for a member whose list is filtered to their own work. A figure summed
    over the clinic above rows filtered to one doctor is two different answers
    stacked, and theirs is on the Earnings tab.
  */
  const showToday = !ownInvoicesOnly(access);
  /* No `invoices.history`: today's invoices and payments only (2026-11-20). */
  const onlyToday = todayOnly(access);

  const data = await inClinic(access, async (c) => {
    const today = dayRangeUtc(tz);

    /*
      The numbers beside the filter chips — part-paid, cancelled, and how many
      of the cancelled may be deleted (the ones never filed with JoFotara,
      DELETABLE_INVOICE_SQL). They count what this member can actually open.
    */
    const own = invoiceScopeSql(access, "i", 2);
    // A today-only member (no `invoices.history`) counts and lists today's alone.
    const day = invoiceDaySql(access, "i", 2 + own.params.length);
    const chipScope = { sql: own.sql + day.sql, params: [...own.params, ...day.params] };
    const [stats] = (
      await c.query(
        `select
           (select count(*) from invoices i where i.clinic_id = $1 and i.status = 'partially_paid'${chipScope.sql})::int as partial_count,
           (select count(*) from invoices i where i.clinic_id = $1 and i.status = 'void'${chipScope.sql})::int as cancelled_count,
           (select count(*) from invoices i where i.clinic_id = $1 and ${DELETABLE_INVOICE_SQL}${chipScope.sql})::int as deletable_count`,
        [access.clinicId, ...chipScope.params]
      )
    ).rows;

    /*
      Today's takings, by how they were paid — cash is what the drawer should
      hold, and the rest is what the machine and the bank should show. A
      cancelled invoice's payments are left out: that money is not the
      clinic's (Yamen, 2026-10-14). Not asked at all for somebody who is not
      shown it.
    */
    const todayByMethod: { method: string; amount: number; n: number }[] = showToday
      ? (
          await c.query(
            `select p.method, sum(p.amount)::float8 as amount, count(*)::int as n
               from payments p
               join invoices v on v.id = p.invoice_id and v.status <> 'void'
              where p.clinic_id = $1 and p.paid_at >= $2 and p.paid_at < $3
              group by p.method
              order by 2 desc`,
            [access.clinicId, today.start, today.end]
          )
        ).rows
      : [];

    let invoices: Record<string, unknown>[] = [];
    let payments: Record<string, unknown>[] = [];
    if (tab === "invoices") {
      const conds = ["i.clinic_id = $1"];
      /*
        Partly paid is its own filter, not a shade of unpaid. "Owes something"
        and "has started paying" are different conversations to have with a
        patient, and lumping them together was why the second one was invisible.
      */
      if (sp.status === "unpaid") conds.push(owedSql("i"));
      else if (sp.status === "partial") conds.push(`i.status = 'partially_paid'`);
      else if (sp.status === "paid") conds.push(`i.status = 'paid'`);
      /*
        Cancelled invoices have a chip of their own and are left out of "All":
        they are off the books, and in the working list they were only in the
        way (Yamen, 2026-10-14). Under "Cancelled" they can be deleted.
      */
      else if (sp.status === "cancelled") conds.push(`i.status = 'void'`);
      else conds.push(`i.status <> 'void'`);
      const scope = chipScope;
      const args: unknown[] = [access.clinicId, ...scope.params];
      /*
        Who it is for, the way the patients screen finds people — Arabic
        spellings folded, any phone format, the file number — or the invoice's
        own number and title.
      */
      if (q) {
        const who = patientSearchClause(q, args.length + 1);
        args.push(...who.params);
        args.push(`%${q}%`);
        const n = args.length;
        conds.push(`(${who.clause} or i.number ilike $${n} or ar_normalize(coalesce(i.title, '')) like ar_normalize($${n}))`);
      }
      // One row past the page says whether there is an older page to offer.
      invoices = (
        await c.query(
          /*
            Listed by the date the invoice carries, which can be set back to
            the day the work was done (2026-11-20); entered order breaks ties.
          */
          `select i.id, i.number, i.title, i.status, i.total, i.amount_paid, i.created_at, i.sent_at,
                  i.issue_date::text as issue_day, p.full_name as patient_name
           from invoices i join patients p on p.id = i.patient_id
           where ${conds.join(" and ")}${scope.sql}
           order by i.issue_date desc nulls last, i.created_at desc limit ${limit + 1}`,
          args
        )
      ).rows;
    } else {
      // Payments hang off invoices, so the same filter reaches them through the
      // join rather than needing one of its own. A cancelled invoice's payments
      // are not listed: they no longer count as money taken.
      const payDay = paymentDaySql(access, "pay", 2 + own.params.length);
      payments = (
        await c.query(
          `select pay.id, pay.amount, pay.method, pay.reference, pay.paid_at,
                  i.number, i.id as invoice_id, i.total, i.amount_paid, i.status as invoice_status,
                  p.full_name as patient_name, u.full_name as recorded_by
           from payments pay
           join invoices i on i.id = pay.invoice_id
           join patients p on p.id = pay.patient_id
           left join users u on u.id = pay.recorded_by
           where pay.clinic_id = $1 and i.status <> 'void'${own.sql}${payDay.sql}
           order by pay.paid_at desc limit 100`,
          [access.clinicId, ...own.params, ...payDay.params]
        )
      ).rows;
    }
    /*
      The desk's Ready to bill, on the invoices list: what was recorded and is
      not on an invoice yet — teeth, faces, and since 0108 the treatments every
      clinic records. A doctor who sees only their own invoices sees only their
      own work here.
    */
    let ready: DeskGroup[] = [];
    if (tab === "invoices") {
      const own = ownInvoicesOnly(access);
      if (!own || access.memberId) {
        const rows = await readyToBillDesk(c, access.clinicId, own ? access.memberId! : null);
        // Each patient's work item by item, worded and priced as the invoice will be.
        const lines = await deskLines(c, access.clinicId, rows.flatMap((r) => r.marks), locale, t.invoices.chartLine);
        ready = rows.map((r) => ({ patientId: r.patientId, name: r.name, lastAt: r.lastAt, lines: lines.filter((l) => l.patientId === r.patientId) }));
      }
    }
    const more = invoices.length > limit;
    return { stats, todayByMethod, invoices: more ? invoices.slice(0, limit) : invoices, more, payments, ready };
  });

  const base = `/c/${slug}/invoices`;
  const money = (n: number) => fmtMoney(n, access.clinic.currency, locale);
  const todayTotal = data.todayByMethod.reduce((sum, m) => sum + m.amount, 0);
  /* A link inside this list keeps whatever else is chosen: the filter, the search, how far back it reaches. */
  const listHref = (o: { status?: string; n?: number }) => {
    const u = new URLSearchParams();
    const status = "status" in o ? o.status : sp.status;
    if (status) u.set("status", status);
    if (q) u.set("q", q);
    if (o.n) u.set("n", String(o.n));
    const s = u.toString();
    return s ? `${base}?${s}` : base;
  };

  return (
    <>
      <PageHeader
        title={tab === "payments" ? t.invoices.payments : t.invoices.title}
        /*
          The day's takings, as one line under the title rather than a card of
          its own (Yamen, 2026-11-15: the card "takes a big section of the
          screen"). The total in a pill, how it was paid beside it — cash is
          what the drawer should hold. On both lists, so the desk closing its
          day reads the total and the payments under it together.
        */
        sub={
          showToday ? (
            <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5" data-today-takings={todayTotal.toFixed(2)}>
              <span className="inline-flex items-baseline gap-2 rounded-full bg-ink-900/5 px-3 py-1">
                <span className="text-[0.75rem] text-ink-500">{t.invoices.collectedToday}</span>
                <span className="text-[0.8125rem] font-semibold text-ink-900 tnum">{money(todayTotal)}</span>
              </span>
              {data.todayByMethod.map((m) => (
                <span key={m.method} className="text-[0.75rem] text-ink-400">
                  {(t.invoices.methods as Record<string, string>)[m.method] ?? m.method}{" "}
                  <span className="font-medium text-ink-700 tnum">{money(m.amount)}</span>
                </span>
              ))}
            </span>
          ) : undefined
        }
        action={
          <Link href={`${base}/new`} className={buttonClass()}>
            <Plus className="h-4 w-4" />
            {t.invoices.newInvoice}
          </Link>
        }
      />

      {data.ready.length > 0 && (
        <ReadyToBillDesk
          slug={slug}
          currency={access.clinic.currency}
          tz={tz}
          groups={JSON.parse(JSON.stringify(data.ready))}
          priceLinks={{
            dental: !!access.clinic.features.dental && can(access, "settings.services"),
            face: !!access.clinic.features.aesthetic && can(access, "settings.services"),
          }}
        />
      )}

      {/*
        One tab, two lists (Yamen, 2026-11-15): invoices and the payments taken
        on them. The switch is a segmented control beside the search, not a
        second strip of tabs under the section's own.
      */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <ListSwitch slug={slug} />
        {tab === "invoices" && (
          <div className="w-full sm:w-auto">
            <InvoiceSearch initial={q} />
          </div>
        )}
      </div>
      {tab === "invoices" && (
        <div className="mb-4 flex flex-wrap items-center gap-x-1 gap-y-2">
          {(
            [
              ["", t.invoices.allFilter, 0],
              ["unpaid", t.invoices.unpaidFilter, 0],
              ["partial", t.invoices.partlyPaidFilter, Number(data.stats.partial_count)],
              ["paid", t.invoices.paidFilter, 0],
              ["cancelled", t.invoices.cancelledFilter, Number(data.stats.cancelled_count)],
            ] as [string, string, number][]
          ).map(([key, label, count]) => {
            const on = (sp.status ?? "") === key;
            return (
              <Link
                key={key || "all"}
                href={listHref({ status: key || undefined })}
                className={`touch-manipulation rounded-full px-3 py-1 text-[0.75rem] font-medium max-md:py-2 transition-colors duration-140 ease-out ${
                  on ? "bg-brand-600 text-on-brand" : "bg-ink-900/4 text-ink-500 hover:bg-ink-900/8 hover:text-ink-700"
                }`}
              >
                {label}
                {count > 0 && <span className="ms-1.5 tnum">{count}</span>}
              </Link>
            );
          })}
          {/* Under Cancelled: clear them away, all at once. */}
          {cancelledView && Number(data.stats.deletable_count) > 0 && can(access, "invoices.void") && (
            <span className="max-sm:ms-auto">
              <DeleteCancelled slug={slug} count={Number(data.stats.deletable_count)} />
            </span>
          )}
        </div>
      )}
      {/* Whoever sees only today's (no `invoices.history`) is told so, and where the rest of a patient's bills are. */}
      {onlyToday && (
        <p className="-mt-2 mb-4 text-[0.75rem] text-ink-500" data-today-only>
          {t.invoices.todayOnlyNote}
        </p>
      )}
      {/* Why some cancelled invoices cannot be deleted, said where they are listed. */}
      {cancelledView && Number(data.stats.cancelled_count) > Number(data.stats.deletable_count) && (
        <p className="-mt-2 mb-4 text-[0.75rem] text-ink-500" data-filed-stay>
          {t.invoices.filedStays}
        </p>
      )}

      {tab === "invoices" ? (
        data.invoices.length === 0 ? (
          q ? (
            <EmptyState icon={<ReceiptText />} title={t.invoices.noMatch.replace("{q}", q)} />
          ) : cancelledView ? (
            <EmptyState icon={<ReceiptText />} title={t.invoices.noCancelled} />
          ) : (
            <EmptyState
              icon={<ReceiptText />}
              title={t.invoices.empty}
              body={t.invoices.emptyBody}
              action={
                <Link href={`${base}/new`} className={buttonClass()}>{t.invoices.newInvoice}</Link>
              }
            />
          )
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
                      columns.

                      On a phone the row is two lines on a grid instead: who and
                      how much on the first, which invoice and its state on the
                      second. Wrapped in one line, the number and the name both
                      lost their ends to an ellipsis — "RIMA-2026-00…" beside
                      "خالد السع…" — and between them identified nothing.
                      `order` puts the cells where the phone wants them and is
                      dropped at sm, so the desktop columns are untouched.
                    */}
                    <Link
                      href={`${base}/${inv.id}`}
                      className="flex items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-sunken max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4 sm:px-5"
                    >
                      <span
                        className="order-3 min-w-0 justify-self-start truncate text-[0.75rem] text-ink-500 tnum sm:order-none sm:w-36 sm:shrink-0 sm:text-sm sm:font-semibold sm:text-ink-900"
                        dir="ltr"
                      >
                        {String(inv.number)}
                      </span>
                      {/*
                        The name the clinic gave this invoice, after the person it
                        is for. Both truncate inside one min-w-0 column, so a long
                        title shortens rather than widening the row — the same
                        rule the rest of this list already follows.
                      */}
                      <span className="order-1 flex min-w-0 flex-1 items-baseline gap-2 sm:order-none">
                        <span className="truncate text-sm font-medium sm:font-normal">{String(inv.patient_name)}</span>
                        {inv.title ? (
                          <span className="truncate text-[0.8125rem] text-ink-400">
                            {String(inv.title)}
                          </span>
                        ) : null}
                      </span>
                      <span className="hidden text-[0.8125rem] text-ink-400 sm:block">
                        {inv.issue_day ? fmtDateOnly(String(inv.issue_day), locale) : fmtDate(String(inv.created_at), tz, locale)}
                      </span>
                      {/*
                        A partly paid row shows the money, not just the word.
                        "Partly paid" next to the full total is the one thing
                        reception cannot act on — what they need to say on the
                        phone is how much is still owed.
                      */}
                      <span className="order-2 shrink-0 text-end sm:order-none sm:w-32">
                        <span className="block text-sm font-semibold tnum">
                          {fmtMoney(partial ? paid : total, access.clinic.currency, locale)}
                        </span>
                        {partial && (
                          <span className="block text-[0.75rem] text-ink-400 tnum">
                            {t.invoices.ofTotal.replace(
                              "{total}",
                              fmtMoney(total, access.clinic.currency, locale)
                            )}
                          </span>
                        )}
                      </span>
                      <span className="order-4 shrink-0 text-end sm:order-none sm:w-28">
                        <Badge status={invStatus[String(inv.status)] ?? "neutral"}>
                          {(t.invoices.statuses as Record<string, string>)[String(inv.status)]}
                        </Badge>
                        {partial && (
                          <span className="mt-0.5 block text-[0.75rem] font-medium text-st-pending tnum">
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
            {data.more && !onlyToday && (
              <div className="border-t border-line p-3 text-center">
                <Link href={listHref({ n: limit + PAGE })} scroll={false} className={buttonClass({ variant: "ghost", size: "sm" })} data-invoices-older>
                  {t.invoices.showOlder}
                </Link>
              </div>
            )}
          </Card>
        )
      ) : data.payments.length === 0 ? (
        <EmptyState icon={<ReceiptText />} title={t.invoices.noPayments} body={t.invoices.noPaymentsBody} />
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
              /*
                Wraps on a phone, for the reason the invoice row above already
                does. Unwrapped, the fixed columns — amount, method badge,
                invoice number — came to more than 390px between them, so the
                patient's name was squeezed to nothing and the note beside it
                ran outside a truncating box where it could not be read at all.
              */
              <li key={String(p.id)} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:flex-nowrap sm:gap-4 sm:px-5">
                <span className="w-24 shrink-0 text-sm font-semibold tnum">
                  {fmtMoney(Number(p.amount), access.clinic.currency, locale)}
                </span>
                <Badge status="brand">
                  {(t.invoices.methods as Record<string, string>)[String(p.method)] ?? String(p.method)}
                </Badge>
                {/* The note wraps under the name rather than truncating with it:
                    at tablet width this column is about ninety pixels, and
                    "Settled th…" tells reception nothing. */}
                <span className="flex min-w-0 flex-1 basis-full flex-wrap items-baseline gap-x-2 sm:basis-auto">
                  <span className="truncate text-sm">{String(p.patient_name)}</span>
                  <span
                    className={`text-[0.75rem] ${open ? "text-st-pending" : "text-ink-400"}`}
                  >
                    {open
                      ? t.invoices.leftBalance.replace(
                          "{amount}",
                          fmtMoney(stillDue, access.clinic.currency, locale)
                        )
                      : t.invoices.settled}
                  </span>
                </span>
                <Link
                  href={`${base}/${p.invoice_id}`}
                  className="shrink-0 text-[0.8125rem] text-brand-700 tnum"
                  dir="ltr"
                >
                  {String(p.number)}
                </Link>
                <span className="hidden text-[0.8125rem] text-ink-400 sm:block">
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


