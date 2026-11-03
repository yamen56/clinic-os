"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateOnly, fmtMoney, monthLabel } from "@/lib/dates";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import type { DoctorEarnings, EarningsLine } from "@/lib/earnings";
import type { OwedMonth, Payout, PayoutMethod } from "@/lib/payouts";
import { recordPayoutAction, removePayoutAction } from "./actions";
import { Check, ChevronLeft, ChevronRight, Trash2, Wallet } from "lucide-react";

/** How a clinic pays a doctor — `PAYOUT_METHODS`, kept here so the page does not pull the ledger's SQL into the browser. */
const METHODS: PayoutMethod[] = ["cash", "cliq", "transfer", "cheque"];
/** Below a fil is rounding, not a debt (`SETTLED` in lib/payouts). */
const SETTLED = 0.005;
const r2 = (n: number) => Math.round(n * 100) / 100;

type Draft = { doctorMemberId: string; amount: string; paidOn: string; method: PayoutMethod; note: string };

export function EarningsClient({
  slug,
  currency,
  timezone,
  offset,
  hasCommission,
  myRate,
  myVisitFee,
  myCostsRule,
  self,
  detail,
  team,
  net,
  showSpend,
  names,
  showTeam,
  canOpenInvoices,
  period,
  today,
  myMemberId,
  payouts,
  owed,
}: {
  slug: string;
  currency: string;
  timezone: string;
  offset: number;
  hasCommission: boolean;
  myRate: number | null;
  /** On call (0086): what each completed visit earns them; null when they are not. */
  myVisitFee: number | null;
  /** How a treatment's costs come into the viewer's own share. */
  myCostsRule: "shared" | "doctor";
  self: DoctorEarnings | null;
  detail: EarningsLine[];
  team: DoctorEarnings[];
  net: {
    collected: number;
    tax: number;
    commission: number;
    expenses: number;
    kept: number;
    afterCommission: number;
  } | null;
  /** Whether this reader may also see what the clinic spent. */
  showSpend: boolean;
  names: Record<string, string>;
  showTeam: boolean;
  /*
    Whether the invoice numbers below are worth linking.

    A doctor on the default permissions holds `earnings` and not `invoices` —
    that split is the whole reason this screen exists. Linking regardless sent
    them to an invoice page that redirects them back to the dashboard, so the
    number read as broken rather than as deliberately withheld. Off, it stays a
    number, which is all it was needed for.
  */
  canOpenInvoices: boolean;
  /** The month on screen, as its first day — what a payout made here pays for. */
  period: string;
  /** Today in the clinic, the default day a payout was made. */
  today: string;
  myMemberId: string | null;
  /** What was paid for this month (0091): everybody's for the owner, a doctor's own for them. */
  payouts: Payout[];
  /** Earlier months a doctor is still owed for — the owner's alone. */
  owed: OwedMonth[];
}) {
  const { t, locale } = useI18n();
  const E = t.earnings;
  const router = useRouter();
  const { toast } = useToast();
  const money = (n: number) => fmtMoney(n, currency, locale);
  const visitOnly = myVisitFee !== null && self !== null && self.produced === 0 && self.costs === 0;
  const month = monthLabel(timezone, offset, locale);
  const monthOf = (p: string) =>
    DateTime.fromISO(p).setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB").toFormat("LLLL yyyy");

  /*
    Paying answers the tap: the row turns paid at once and goes back if the
    server says no, with Undo on the toast for the slip of a finger. A ref
    beside the state, so Undo reads the list as it is now, not as it was when
    the toast was drawn.
  */
  const [paid, setPaid] = useState<Payout[]>(payouts);
  const paidNow = useRef(paid);
  paidNow.current = paid;
  const [paying, setPaying] = useState<Draft | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Payout | null>(null);
  const paidTo = (id: string | null) =>
    r2(paid.filter((p) => p.doctorMemberId === id).reduce((s, p) => s + p.amount, 0));
  const nameOf = (id: string) => names[id] ?? "—";

  const openPay = (doctorMemberId: string, earned: number) => {
    const left = r2(earned - paidTo(doctorMemberId));
    setPaying({ doctorMemberId, amount: left > SETTLED ? left.toFixed(2) : "", paidOn: today, method: "cash", note: "" });
  };

  const unpay = async (id: string) => {
    const was = paidNow.current.find((p) => p.id === id);
    if (!was) return;
    setPaid((prev) => prev.filter((p) => p.id !== id));
    const r = await removePayoutAction(slug, id);
    if (r.error) {
      setPaid((prev) => [...prev, was]);
      toast(t.common.genericError, "error");
      return;
    }
    toast(E.payRemoved);
  };

  const pay = async (d: Draft) => {
    const temp: Payout = {
      id: `temp-${Date.now()}`,
      doctorMemberId: d.doctorMemberId,
      period,
      amount: r2(Number(d.amount)),
      paidOn: d.paidOn,
      method: d.method,
      note: d.note.trim(),
    };
    setPaying(null);
    setPaid((prev) => [...prev, temp]);
    const r = await recordPayoutAction(slug, { ...d, period, amount: temp.amount });
    if (r.error || !r.id) {
      setPaid((prev) => prev.filter((p) => p.id !== temp.id));
      toast(E.payFailed, "error");
      return;
    }
    const id = r.id;
    setPaid((prev) => prev.map((p) => (p.id === temp.id ? { ...p, id } : p)));
    toast(E.payRecorded.replace("{name}", nameOf(d.doctorMemberId)).replace("{amount}", money(temp.amount)), undefined, {
      label: E.undo,
      onClick: () => void unpay(id),
    });
  };

  const mine = paid.filter((p) => p.doctorMemberId === myMemberId);
  const myLeft = self ? r2(self.earned - paidTo(myMemberId)) : 0;
  const totalEarned = r2(team.reduce((s, d) => s + d.earned, 0));
  const totalPaid = r2(team.reduce((s, d) => s + paidTo(d.doctorMemberId), 0));
  const totalLeft = r2(team.reduce((s, d) => s + Math.max(r2(d.earned - paidTo(d.doctorMemberId)), 0), 0));

  /*
    Empty only when there is genuinely nothing on the page. `hasCommission`
    alone was the test, which meant a solo owner who splits revenue with nobody
    — the reader most interested in the profit chain below — was told revenue
    sharing was not set up and shown nothing else.
  */
  if (!self && !net) {
    return (
      <>
        <PageHeader title={t.nav.earnings} />
        <Card className="p-5">
          <EmptyState
            icon={<Wallet className="h-6 w-6" />}
            title={t.earnings.noneTitle}
            body={t.earnings.noneBody}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t.nav.earnings}
        sub={t.earnings.sub}
        action={
          /* Stepping back through months, never forward past this one: there is
             nothing to show in a month that has not happened. */
          <div className="flex items-center gap-1">
            <button
              aria-label={t.earnings.previousMonth}
              onClick={() => router.push(`/c/${slug}/earnings?m=${offset - 1}`)}
              className="rounded-lg border border-line p-1.5 text-ink-500 hover:border-brand-400"
            >
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </button>
            <span className="min-w-28 text-center text-[13px] font-medium tabular-nums sm:min-w-36">
              {month}
            </span>
            <button
              aria-label={t.earnings.nextMonth}
              disabled={offset >= 0}
              onClick={() => router.push(`/c/${slug}/earnings?m=${offset + 1}`)}
              className="rounded-lg border border-line p-1.5 text-ink-500 hover:border-brand-400 disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4 rtl:rotate-180" />
            </button>
          </div>
        }
      />

      <div className="grid gap-4">
        {self && (
          <Card className="p-5">
            {/*
              On call and nothing billed under their name: what they billed and
              what it cost would be two zeros about a deal they do not have, so
              the card is their pay and their fee.
            */}
            <div className={`grid gap-4 ${visitOnly ? "sm:grid-cols-2" : "sm:grid-cols-4"}`}>
              <Figure label={t.earnings.myShare} value={money(self.earned)} strong />
              {!visitOnly && <Figure label={t.invoices.produced} value={money(self.produced)} />}
              {!visitOnly && <Figure label={t.earnings.costs} value={money(self.costs)} />}
              <Figure
                label={t.earnings.myRate}
                value={
                  myVisitFee !== null
                    ? t.earnings.perVisit.replace("{amount}", money(myVisitFee))
                    : myRate === null
                      ? t.staff.commissionNone
                      : `${myRate}%`
                }
              />
            </div>
            {/* Whether the clinic has handed it over yet (0091) — what a doctor opens this page to find out at the start of a month. */}
            {(self.earned > 0 || mine.length > 0) && (
              <div
                className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-3 text-[13px]"
                data-my-payout={mine.length === 0 ? "unpaid" : myLeft > SETTLED ? "part" : "paid"}
              >
                {mine.length === 0 ? (
                  <span className="text-ink-500">{E.notPaidYet}</span>
                ) : (
                  <>
                    {myLeft <= SETTLED && (
                      <Badge status="ok">
                        <Check className="h-3.5 w-3.5" />
                        {E.myPaidInFull}
                      </Badge>
                    )}
                    {mine.map((p) => (
                      <span key={p.id} className="text-ink-700">
                        {E.myPaidLine.replace("{amount}", money(p.amount)).replace("{date}", fmtDateOnly(p.paidOn, locale))}
                      </span>
                    ))}
                    {myLeft > SETTLED && (
                      <span className="font-medium text-ink-900">{E.myLeft.replace("{amount}", money(myLeft))}</span>
                    )}
                  </>
                )}
              </div>
            )}
            {/*
              Said plainly, because it is the question this screen will be asked
              about: the share is of the ex-tax net, so it is not a percentage of
              what the patient handed over.
            */}
            {!visitOnly && (
              <p className="mt-4 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-500">
                {t.earnings.exTaxNote}
              </p>
            )}
            {/* The deal, said once: how what the work cost — materials, the lab — came into the share above. */}
            {myVisitFee !== null ? (
              <p className={`text-[12px] leading-relaxed text-ink-500 ${visitOnly ? "mt-4 border-t border-line pt-3" : "mt-2"}`} data-on-call>
                {t.earnings.onCallNote}
              </p>
            ) : (
              <p className="mt-2 text-[12px] leading-relaxed text-ink-500" data-costs-rule={myCostsRule}>
                {myCostsRule === "doctor" ? t.earnings.costsDoctorNote : t.earnings.costsSharedNote}
              </p>
            )}
          </Card>
        )}

        {self && (
          <Card>
            <CardHeader title={t.earnings.breakdown} sub={t.earnings.breakdownSub} />
            {detail.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-400">{t.earnings.nothingThisMonth}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-400">
                      <th className="px-5 py-2 text-start font-semibold">{t.invoices.invoiceNo}</th>
                      <th className="px-5 py-2 text-start font-semibold">{t.common.date}</th>
                      <th className="px-5 py-2 text-end font-semibold">{t.invoices.produced}</th>
                      <th className="px-5 py-2 text-end font-semibold">{t.earnings.costs}</th>
                      <th className="px-5 py-2 text-end font-semibold">{t.invoices.earned}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.map((l) => (
                      <tr key={l.invoiceId ?? "visits"} className="border-b border-line last:border-0">
                        <td className="px-5 py-2.5">
                          {/* The month's on-call visits, owed against no invoice: one line, counted. */}
                          {l.invoiceId === null ? (
                            <span className="font-medium" data-visits-line={l.visits}>
                              {t.earnings.onCallVisits.replace("{n}", String(l.visits))}
                            </span>
                          ) : canOpenInvoices ? (
                            <Link
                              href={`/c/${slug}/invoices/${l.invoiceId}`}
                              className="font-medium text-brand-700 hover:underline"
                            >
                              {l.number}
                            </Link>
                          ) : (
                            <span className="font-medium">{l.number}</span>
                          )}
                          {l.status === "void" && (
                            <span className="ms-2 rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-500">
                              {t.invoices.statuses.void}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-2.5 text-ink-500">{fmtDateOnly(l.paidAt, locale)}</td>
                        <td className="px-5 py-2.5 text-end tabular-nums text-ink-500">
                          {l.invoiceId === null ? "—" : money(l.produced)}
                        </td>
                        <td className="px-5 py-2.5 text-end tabular-nums text-ink-500">
                          {l.costs > 0 ? <span dir="ltr">− {money(l.costs)}</span> : "—"}
                        </td>
                        <td className="whitespace-nowrap px-5 py-2.5 text-end font-medium tabular-nums">
                          {money(l.earned)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {showTeam && net && (
          <Card className="p-5">
            <CardHeader title={t.earnings.whatTheClinicKept} />
            {/*
              A chain rather than three headline figures, because every line is
              a number the owner recognises and the last one is only believable
              if the subtractions above it are visible.
            */}
            <ul className="mt-4 grid gap-2">
              <Line label={t.earnings.collected} value={money(net.collected)} />
              {/*
                Sales tax, shown only when there is any. Most clinics here are
                under the registration threshold and issue everything outside
                the scope of tax, so a permanent 0.00 row would be noise for
                them — and leaving it out entirely would overstate profit for
                the few who do charge it. Same rule as the tax column on the
                patient's own invoice.
              */}
              {net.tax > 0 && <Line label={t.earnings.salesTax} value={`− ${money(net.tax)}`} />}
              {net.commission > 0 && (
                <Line label={t.earnings.doctorsShare} value={`− ${money(net.commission)}`} />
              )}
              {showSpend && <Line label={t.earnings.expenses} value={`− ${money(net.expenses)}`} />}
              <li className="mt-1 flex items-center justify-between gap-3 border-t border-line pt-3">
                <span className="text-[13px] font-semibold">
                  {showSpend ? t.earnings.kept : t.earnings.afterCommission}
                </span>
                {/*
                  A loss is an ordinary month — the first one of any clinic, and
                  any month somebody buys a chair — so it is coloured rather
                  than left looking like a number that went wrong. `dir="ltr"`
                  keeps the minus beside its digits in an RTL page.
                */}
                <span
                  dir="ltr"
                  className={`text-lg font-bold tabular-nums ${
                    (showSpend ? net.kept : net.afterCommission) < 0 ? "text-danger" : "text-ink-900"
                  }`}
                >
                  {money(showSpend ? net.kept : net.afterCommission)}
                </span>
              </li>
            </ul>
            <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-500">
              {showSpend ? t.earnings.keptNote : t.earnings.afterCommissionNote}
            </p>
          </Card>
        )}

        {showTeam && (
          <Card>
            <CardHeader title={t.earnings.payoutTitle} sub={t.earnings.payoutSub} />
            {team.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-400">{t.earnings.nothingThisMonth}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-400">
                      <th className="px-5 py-2 text-start font-semibold">{t.invoices.doctor}</th>
                      {/* On a phone the two figures behind the share give way to whether it was paid. */}
                      <th className="px-5 py-2 text-end font-semibold max-sm:hidden">{t.invoices.produced}</th>
                      <th className="px-5 py-2 text-end font-semibold max-sm:hidden">{t.earnings.costs}</th>
                      <th className="px-5 py-2 text-end font-semibold">{t.invoices.earned}</th>
                      <th className="px-5 py-2 text-end font-semibold">{E.paidCol}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.map((d) => {
                      const got = paidTo(d.doctorMemberId);
                      const left = r2(d.earned - got);
                      const state =
                        got === 0
                          ? left > SETTLED ? "unpaid" : "none"
                          : left > SETTLED ? "part" : left < -SETTLED ? "over" : "paid";
                      return (
                        <tr
                          key={d.doctorMemberId}
                          className="border-b border-line last:border-0"
                          data-payout-row={d.doctorMemberId}
                        >
                          <td className="px-5 py-2.5 font-medium">{nameOf(d.doctorMemberId)}</td>
                          <td className="px-5 py-2.5 text-end tabular-nums text-ink-500 max-sm:hidden">
                            {money(d.produced)}
                          </td>
                          <td className="px-5 py-2.5 text-end tabular-nums text-ink-500 max-sm:hidden">
                            {d.costs > 0 ? <span dir="ltr">− {money(d.costs)}</span> : "—"}
                          </td>
                          <td className="whitespace-nowrap px-5 py-2.5 text-end font-medium tabular-nums">
                            {money(d.earned)}
                          </td>
                          <td className="px-5 py-2 text-end">
                            <div className="flex flex-wrap items-center justify-end gap-2" data-payout-state={state}>
                              {got > 0 && (
                                /* What was paid, and the way into each payment — to see it, or take one back. */
                                <button
                                  type="button"
                                  onClick={() => setHistory(d.doctorMemberId)}
                                  className="inline-flex items-center rounded-lg px-1.5 py-1 hover:bg-sunken"
                                  data-payout-history
                                >
                                  {state === "part" ? (
                                    /* Each amount whole on its own line before either breaks in the middle, on a phone. */
                                    <span className="flex flex-wrap items-center justify-end gap-x-1 text-[12.5px] tabular-nums text-ink-700">
                                      <span className="whitespace-nowrap">{money(got)} ·</span>
                                      <span className="whitespace-nowrap font-medium text-ink-900">
                                        {E.paidPart.replace("{left}", money(left))}
                                      </span>
                                    </span>
                                  ) : state === "over" ? (
                                    <Badge status="danger">{E.paidOver.replace("{amount}", money(-left))}</Badge>
                                  ) : (
                                    <Badge status="ok">
                                      <Check className="h-3.5 w-3.5" />
                                      {E.paidInFull}
                                    </Badge>
                                  )}
                                </button>
                              )}
                              {left > SETTLED && (
                                <Button
                                  size="sm"
                                  variant={got > 0 ? "outline" : "primary"}
                                  onClick={() => openPay(d.doctorMemberId, d.earned)}
                                  data-payout-pay
                                >
                                  {got > 0 ? E.payRest : E.markPaid}
                                </Button>
                              )}
                              {state === "none" && <span className="text-ink-400">—</span>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {team.length > 1 && (
                    <tfoot>
                      <tr className="border-t border-line-strong">
                        <td className="px-5 py-2.5 font-semibold">{E.total}</td>
                        <td className="max-sm:hidden" />
                        <td className="max-sm:hidden" />
                        <td className="whitespace-nowrap px-5 py-2.5 text-end font-semibold tabular-nums">{money(totalEarned)}</td>
                        <td className="px-5 py-2.5 text-end tabular-nums" data-payout-total-left={totalLeft}>
                          <div className="whitespace-nowrap font-semibold">{money(totalPaid)}</div>
                          {totalLeft > SETTLED && (
                            <div className="text-[12px] text-ink-500">
                              {E.stillOwed} <span className="whitespace-nowrap">{money(totalLeft)}</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </Card>
        )}

        {/* The months moved on from without paying in full — since the clinic started paying here. */}
        {showTeam && owed.length > 0 && (
          <Card>
            <CardHeader title={E.earlierTitle} sub={E.earlierSub} />
            <ul className="divide-y divide-line" data-payout-earlier>
              {owed.map((o) => (
                <li
                  key={`${o.doctorMemberId}|${o.period}`}
                  className="flex items-center justify-between gap-3 px-5 py-2.5 text-[13px]"
                  data-payout-earlier-row={o.period}
                >
                  <span className="min-w-0">
                    <span className="font-medium">{nameOf(o.doctorMemberId)}</span>
                    <span className="text-ink-500"> · {monthOf(o.period)}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="font-medium tabular-nums">{money(o.owed)}</span>
                    <Link
                      href={`/c/${slug}/earnings?month=${o.period.slice(0, 7)}`}
                      className={buttonClass({ variant: "outline", size: "sm" })}
                    >
                      {E.openMonth}
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <Modal
        open={!!paying}
        onClose={() => setPaying(null)}
        title={paying ? E.payTitle.replace("{name}", nameOf(paying.doctorMemberId)).replace("{month}", month) : undefined}
      >
        {paying && (
          <div className="grid gap-4" data-payout-form>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={E.payAmount} required>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.01}
                  dir="ltr"
                  value={paying.amount}
                  onChange={(e) => setPaying({ ...paying, amount: e.target.value })}
                  data-payout-amount
                />
              </Field>
              <Field label={E.paidOn} required>
                <Input
                  type="date"
                  value={paying.paidOn}
                  onChange={(e) => setPaying({ ...paying, paidOn: e.target.value })}
                />
              </Field>
            </div>
            <Field label={t.expenses.method}>
              <Select
                value={paying.method}
                onChange={(e) => setPaying({ ...paying, method: e.target.value as PayoutMethod })}
                data-payout-method
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t.expenses.methods[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={E.payNote} hint={t.common.optional}>
              <Input
                value={paying.note}
                maxLength={300}
                onChange={(e) => setPaying({ ...paying, note: e.target.value })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPaying(null)}>
                {t.common.cancel}
              </Button>
              <Button
                disabled={!(Number(paying.amount) > 0) || !paying.paidOn}
                onClick={() => void pay(paying)}
                data-payout-save
              >
                {E.paySave.replace("{amount}", money(Number(paying.amount) || 0))}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!history}
        onClose={() => setHistory(null)}
        title={history ? E.history.replace("{name}", nameOf(history)).replace("{month}", month) : undefined}
      >
        {history && (
          <div className="grid gap-3">
            <ul className="divide-y divide-line rounded-card border border-line" data-payout-list>
              {paid
                .filter((p) => p.doctorMemberId === history)
                .map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                    <div className="min-w-0">
                      <div className="font-medium tabular-nums">{money(p.amount)}</div>
                      <div className="text-[12px] text-ink-500">
                        {fmtDateOnly(p.paidOn, locale)} · {t.expenses.methods[p.method]}
                        {p.note ? ` · ${p.note}` : ""}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={p.id.startsWith("temp-")}
                      onClick={() => setRemoving(p)}
                      data-payout-remove
                    >
                      <Trash2 className="h-4 w-4" />
                      {E.remove}
                    </Button>
                  </li>
                ))}
            </ul>
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={() => {
                  const d = team.find((x) => x.doctorMemberId === history);
                  setHistory(null);
                  openPay(history, d?.earned ?? 0);
                }}
              >
                {E.payMore}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const p = removing!;
          setRemoving(null);
          // The last one gone leaves nothing to list.
          if (paid.filter((x) => x.doctorMemberId === p.doctorMemberId).length === 1) setHistory(null);
          void unpay(p.id);
        }}
        title={E.removeTitle}
        body={E.removeBody}
        confirmLabel={E.remove}
        cancelLabel={t.common.cancel}
      />
    </>
  );
}

/** One subtraction in the profit chain. */
function Line({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-ink-500">{label}</span>
      <span dir="ltr" className="text-[13px] tabular-nums">{value}</span>
    </li>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-400">{label}</div>
      <div className={`mt-1 tabular-nums ${strong ? "text-2xl font-bold text-ink-900" : "text-xl font-semibold text-ink-700"}`}>
        {value}
      </div>
    </div>
  );
}
