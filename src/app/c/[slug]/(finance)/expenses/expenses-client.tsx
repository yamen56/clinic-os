"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateOnly, fmtMoney, monthLabel } from "@/lib/dates";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { Field, Input, Select, Textarea, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { RowBar } from "@/components/ui/chart";
import type { ExpenseCategoryTotal, ExpenseRow } from "@/lib/expenses";
import type { Bill, SupplierOwed } from "@/lib/bills";
import {
  saveExpenseAction,
  deleteExpenseAction,
  saveExpenseCategoryAction,
  deleteExpenseCategoryAction,
  saveExpenseScheduleAction,
  deleteExpenseScheduleAction,
  saveBillAction,
  deleteBillAction,
  payBillsAction,
  undoBillPaymentAction,
} from "./actions";
import {
  Plus,
  Download,
  Paperclip,
  Pencil,
  Trash2,
  Banknote,
  ChevronLeft,
  ChevronRight,
  RotateCw,
  Package,
} from "lucide-react";
import Link from "next/link";

const METHODS = ["cash", "cliq", "card", "transfer", "cheque"] as const;
type Method = (typeof METHODS)[number];

type Category = {
  id: string;
  name: string;
  name_ar: string | null;
  color: string;
  is_system: boolean;
  active: boolean;
};

type Schedule = {
  id: string;
  category_id: string | null;
  amount: string;
  vendor: string;
  note: string;
  method: Method;
  day_of_month: number;
  active: boolean;
  category_name: string | null;
  category_name_ar: string | null;
};

type Draft = {
  id?: string;
  categoryId: string | null;
  amount: string;
  vendor: string;
  note: string;
  spentOn: string;
  method: Method;
  hasReceipt: boolean;
  /** Not paid yet: saved as a bill to pay (0099), not as an expense. `spentOn` is then the bill's date. */
  unpaid: boolean;
  dueOn: string;
  /** Editing a bill rather than an expense. */
  billId?: string;
  /** A stock company's bill: who it is owed to is the company, not something typed. */
  fixedVendor?: boolean;
};

/** Paying a supplier: how much of what they are owed, on which day, how. */
type PayDraft = { group: SupplierOwed; amount: string; paidOn: string; method: Method };

type CatDraft = { id?: string; name: string; nameAr: string; color: string; active: boolean };

type SchedDraft = {
  id?: string;
  categoryId: string | null;
  amount: string;
  vendor: string;
  note: string;
  method: Method;
  dayOfMonth: string;
  active: boolean;
};

export function ExpensesClient({
  slug,
  currency,
  timezone,
  offset,
  monthFrom,
  monthTo,
  total,
  rows,
  byCategory,
  categories,
  schedules,
  stockHref,
  suppliers,
  labsOwed,
}: {
  slug: string;
  currency: string;
  timezone: string;
  offset: number;
  /** First day of the month on screen, so a new expense defaults into it. */
  monthFrom: string;
  /** First day of the next one — the export's exclusive upper bound. */
  monthTo: string;
  total: number;
  rows: ExpenseRow[];
  byCategory: ExpenseCategoryTotal[];
  categories: Category[];
  schedules: Schedule[];
  /** Where an expense from a delivery points, for somebody who may open Stock. */
  stockHref: string | null;
  /** What is owed (ذمم, 0099), supplier by supplier, the most owed first. */
  suppliers: SupplierOwed[];
  /** What the outside labs are owed, paid from the Lab work page; null when nothing is. */
  labsOwed: { owed: number; labs: number; href: string | null } | null;
}) {
  const { t, locale } = useI18n();
  const E = t.expenses;
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [catDraft, setCatDraft] = useState<CatDraft | null>(null);
  const [deleteCatId, setDeleteCatId] = useState<string | null>(null);
  const [schedDraft, setSchedDraft] = useState<SchedDraft | null>(null);
  const [deleteSchedId, setDeleteSchedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  /*
    A receipt picked while adding, before there is anything to attach it to.
    Held here and uploaded the moment the row has an id, so somebody entering
    an expense with the bill in their hand does it in one pass rather than
    saving, reopening and attaching.
  */
  const [pendingReceipt, setPendingReceipt] = useState<File | null>(null);
  const [paying, setPaying] = useState<PayDraft | null>(null);
  const [deleteBillId, setDeleteBillId] = useState<string | null>(null);

  const money =(n: number | string) => fmtMoney(n, currency, locale);
  const label = (x: { name: string | null; name_ar?: string | null; nameAr?: string | null }) => {
    const ar = x.name_ar ?? x.nameAr ?? null;
    return (locale === "ar" ? ar || x.name : x.name) ?? t.expenses.unfiled;
  };

  /*
    Today, in the clinic's own day, so an expense typed in the evening in Amman
    does not default to tomorrow. When the screen is showing a past month the
    default is that month's first day instead — filling in August from September
    should not put every row on today's date.
  */
  const todayLocal = useMemo(() => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    return parts;
  }, [timezone]);
  const defaultDate = offset === 0 ? todayLocal : monthFrom;

  /** Returns false on a failure it has already reported. */
  const uploadReceipt = async (expenseId: string, file: File) => {
    const fd = new FormData();
    fd.set("file", file);
    const res = await fetch(`/api/c/${slug}/expenses/${expenseId}/receipt`, {
      method: "POST",
      body: fd,
    });
    if (res.status === 413) {
      toast(t.expenses.receiptTooLarge, "error");
      return false;
    }
    if (!res.ok) {
      toast(t.common.genericError, "error");
      return false;
    }
    return true;
  };

  const emptyDraft = (): Draft => ({
    categoryId: categories.find((c) => c.active)?.id ?? null,
    amount: "",
    vendor: "",
    note: "",
    spentOn: defaultDate,
    method: "cash",
    hasReceipt: false,
    unpaid: false,
    dueOn: "",
  });

  const billDraft = (b: Bill): Draft => ({
    billId: b.id,
    unpaid: true,
    fixedVendor: !!b.companyId,
    categoryId: b.categoryId,
    amount: String(b.amount),
    vendor: b.vendor,
    note: b.note,
    spentOn: b.incurredOn,
    dueOn: b.dueOn ?? "",
    method: "cash",
    hasReceipt: false,
  });

  const owedTotal = Math.round((suppliers.reduce((s, g) => s + g.owed, 0) + (labsOwed?.owed ?? 0)) * 100) / 100;

  /*
    Paying closes the dialog at once and says so when the server has the
    expenses written, with Undo — which takes back exactly the expenses that
    payment wrote, nothing a person has added since.
  */
  const pay = (p: PayDraft) => {
    setPaying(null);
    start(async () => {
      const r = await payBillsAction(slug, {
        billIds: p.group.bills.map((b) => b.id),
        amount: p.amount,
        paidOn: p.paidOn,
        method: p.method,
      });
      if (r.error || !r.expenseIds) {
        toast(r.error === "too_much" ? E.payTooMuch : t.common.genericError, "error");
        setPaying(p);
        return;
      }
      const ids = r.expenseIds;
      toast(E.paidToast.replace("{amount}", money(Number(p.amount))).replace("{name}", p.group.name || "—"), "success", {
        label: E.undo,
        onClick: () =>
          start(async () => {
            const u = await undoBillPaymentAction(slug, ids);
            if (u.error) return toast(t.common.genericError, "error");
            toast(E.payUndone);
            router.refresh();
          }),
      });
      router.refresh();
    });
  };

  /*
    Close first, write second.

    The dialog used to stay open until the server came back, which on a phone on
    clinic wifi reads as a Save button that did nothing — so people press it
    again. Nothing here needs the server's permission to close: the form is
    already valid by the time the button is enabled, and the writes that can
    fail do so for reasons a person cannot fix by looking at the dialog. So the
    click is answered at once and `undo` puts the draft back on the rare failure,
    with the toast saying why.

    `fn` captures the draft from this render, not from state, so clearing it
    above does not empty what gets sent.
  */
  const run = (
    fn: () => Promise<{ error?: string }>,
    done: () => void,
    undo?: () => void
  ) => {
    /*
      Outside `start`, and that is the whole fix rather than a detail.

      `useTransition` marks everything inside its callback as non-urgent, so a
      `setState` in there does not paint until the transition settles — which
      here means after the write *and* the refresh that follows it. Closing the
      dialog from inside was therefore never going to be immediate no matter
      where in the callback it sat. The close is an urgent update; the write is
      the transition.
    */
    done();
    start(async () => {
      const r = await fn();
      if (r.error) {
        toast(
          r.error === "duplicate"
            ? t.expenses.duplicateCategory
            : r.error === "below_paid"
              ? E.belowPaid
              : t.common.genericError,
          "error"
        );
        undo?.();
        return;
      }
      toast(t.common.saved);
      router.refresh();
    });
  };

  const maxCategory = Math.max(1, ...byCategory.map((b) => b.total));

  return (
    <>
      <PageHeader
        title={t.nav.expenses}
        sub={t.expenses.sub}
        /*
          Three separate children, not one row.

          `PageHeader` wraps its action area precisely so a header with several
          controls can break onto a second line on a phone. Handing it a single
          flex `div` defeated that: the whole group became one unbreakable item
          516px wide inside a 358px column, so the page itself scrolled sideways
          at 390px and "Add expense" was off the screen entirely. The stepper
          stays one unit — a month name with its arrows on different lines is
          worse than a wrap — and the two buttons are free to drop below it.
        */
        action={
          <>
            <div className="flex items-center gap-1">
              <button
                aria-label={t.earnings.previousMonth}
                onClick={() => router.push(`/c/${slug}/expenses?m=${offset - 1}`)}
                className="rounded-lg border border-line p-1.5 text-ink-500 hover:border-brand-400"
              >
                <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
              </button>
              <span className="min-w-28 text-center text-[13px] font-medium tabular-nums sm:min-w-36">
                {monthLabel(timezone, offset, locale)}
              </span>
              <button
                aria-label={t.earnings.nextMonth}
                disabled={offset >= 0}
                onClick={() => router.push(`/c/${slug}/expenses?m=${offset + 1}`)}
                className="rounded-lg border border-line p-1.5 text-ink-500 hover:border-brand-400 disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4 rtl:rotate-180" />
              </button>
            </div>
            <a
              href={`/api/c/${slug}/expenses/export?from=${monthFrom}&to=${monthTo}`}
              download
              className={buttonClass({ variant: "outline", size: "sm" })}
            >
              <Download className="h-4 w-4" />
              {t.invoices.exportCsv}
            </a>
            <Button size="sm" onClick={() => setDraft(emptyDraft())}>
              <Plus className="h-4 w-4" />
              {t.expenses.add}
            </Button>
          </>
        }
      />

      <div className="grid gap-4">
        <Card className="p-5">
          <div className="text-[11px] uppercase tracking-wide text-ink-400">
            {t.expenses.thisMonth}
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-ink-900">{money(total)}</div>
        </Card>

        {/*
          What is owed (ذمم): never scoped to the month on screen, because a debt
          is owed until it is paid. A wrapper, not the Card, carries the anchor —
          Card does not pass ids or data attributes through.
        */}
        <div id="to-pay" className="scroll-mt-24" data-to-pay={owedTotal}>
          <Card>
            <CardHeader
              title={E.toPay}
              sub={E.toPaySub}
              action={
                <Button size="sm" variant="outline" onClick={() => setDraft({ ...emptyDraft(), unpaid: true })} data-bill-add>
                  <Plus className="h-4 w-4" />
                  {E.addBill}
                </Button>
              }
            />
            {owedTotal <= 0 ? (
              <p className="px-5 pb-5 text-[13px] text-ink-400">{E.nothingOwed}</p>
            ) : (
              <>
                <div className="px-5 pb-3">
                  <div className="text-[11px] uppercase tracking-wide text-ink-400">{E.owedTotal}</div>
                  <div className="mt-1 text-2xl font-bold tabular-nums text-ink-900">{money(owedTotal)}</div>
                </div>
                <ul className="divide-y divide-line border-t border-line">
                  {suppliers.map((s) => (
                    <li key={s.key} className="px-5 py-3" data-supplier={s.name}>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-semibold" dir="auto">
                            {s.name || "—"}
                          </div>
                          <div className="text-[12px] text-ink-500">
                            {E.since.replace("{date}", fmtDateOnly(s.bills[0].incurredOn, locale))}
                          </div>
                        </div>
                        <span className="whitespace-nowrap text-[15px] font-bold tabular-nums" data-supplier-owed={s.owed}>
                          {money(s.owed)}
                        </span>
                        <Button
                          size="sm"
                          onClick={() => setPaying({ group: s, amount: s.owed.toFixed(2), paidOn: todayLocal, method: "cash" })}
                          data-supplier-pay
                        >
                          {E.pay}
                        </Button>
                      </div>
                      <ul className="mt-2 grid gap-1.5">
                        {s.bills.map((b) => {
                          const late = !!b.dueOn && b.dueOn < todayLocal;
                          return (
                            <li key={b.id} className="flex items-center gap-2 rounded-ctl bg-sunken ps-3 pe-1 py-1.5 text-[12.5px]" data-bill={b.id}>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-ink-900" dir="auto">
                                  {b.product || b.note || E.billFallback}
                                </div>
                                <div className="text-ink-500">
                                  {fmtDateOnly(b.incurredOn, locale)}
                                  {b.dueOn && (
                                    <span className={late ? "font-semibold text-danger" : ""} data-bill-due={late ? "late" : "due"}>
                                      {" · "}
                                      {(late ? E.overdue : E.dueBy).replace("{date}", fmtDateOnly(b.dueOn, locale))}
                                    </span>
                                  )}
                                  {b.paid > 0 && (
                                    <>
                                      {" · "}
                                      {E.paidOf.replace("{paid}", money(b.paid)).replace("{amount}", money(b.amount))}
                                    </>
                                  )}
                                </div>
                              </div>
                              <span className="whitespace-nowrap font-semibold tabular-nums" data-bill-owed={b.owed}>
                                {money(b.owed)}
                              </span>
                              <Button variant="ghost" size="icon" aria-label={t.common.edit} onClick={() => setDraft(billDraft(b))} data-bill-edit>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="icon" aria-label={t.common.delete} onClick={() => setDeleteBillId(b.id)} data-bill-delete>
                                <Trash2 className="h-4 w-4 text-danger" />
                              </Button>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                  {labsOwed && (
                    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3" data-labs-owed={labsOwed.owed}>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-semibold">{E.labWork}</div>
                        <div className="text-[12px] text-ink-500">{E.labsSub}</div>
                      </div>
                      <span className="whitespace-nowrap text-[15px] font-bold tabular-nums">{money(labsOwed.owed)}</span>
                      {labsOwed.href && (
                        <Link href={labsOwed.href} className={buttonClass({ variant: "outline", size: "sm" })}>
                          {E.openLabs}
                        </Link>
                      )}
                    </li>
                  )}
                </ul>
              </>
            )}
          </Card>
        </div>

        {byCategory.length > 0 && (
          <Card>
            <CardHeader title={t.expenses.byCategory} />
            <ul className="grid gap-2.5 p-5">
              {byCategory.map((b) => (
                <li key={b.categoryId ?? "__unfiled"} className="grid gap-1">
                  <div className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="flex items-center gap-1.5">
                      {b.color && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: b.color }}
                        />
                      )}
                      {label(b)}
                    </span>
                    <span className="tabular-nums font-medium">{money(b.total)}</span>
                  </div>
                  {/* Positive by construction — `amount > 0` — which is the only
                      reason a bar is safe here at all. */}
                  <RowBar value={b.total} max={maxCategory} />
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader title={t.expenses.list} />
          {rows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<Banknote className="h-6 w-6" />}
                title={t.expenses.emptyTitle}
                body={t.expenses.emptyBody}
                action={<Button onClick={() => setDraft(emptyDraft())}>{t.expenses.add}</Button>}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-400">
                    <th className="px-5 py-2 text-start font-semibold">{t.common.date}</th>
                    <th className="px-5 py-2 text-start font-semibold">{t.expenses.vendor}</th>
                    <th className="px-5 py-2 text-start font-semibold">{t.expenses.category}</th>
                    <th className="px-5 py-2 text-end font-semibold">{t.expenses.amount}</th>
                    <th className="px-5 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id} className="border-b border-line last:border-0">
                      {/* fmtDateOnly, not fmtDate: `spent_on` is a calendar day
                          and a zone conversion would move it. */}
                      <td className="whitespace-nowrap px-5 py-2.5 text-ink-500">
                        {fmtDateOnly(e.spentOn, locale)}
                      </td>
                      <td className="px-5 py-2.5">
                        <span className="font-medium">{e.vendor || "—"}</span>
                        {e.recurring && (
                          <span className="ms-2 inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-500">
                            <RotateCw className="h-3 w-3" />
                            {t.expenses.recurring}
                          </span>
                        )}
                        {e.fromStock &&
                          (stockHref ? (
                            <Link href={stockHref} className="ms-2 inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold text-brand-700 hover:underline" data-expense-stock>
                              <Package className="h-3 w-3" />
                              {t.expenses.fromDelivery.replace("{product}", e.fromStock)}
                            </Link>
                          ) : (
                            <span className="ms-2 inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-500" data-expense-stock>
                              <Package className="h-3 w-3" />
                              {t.expenses.fromDelivery.replace("{product}", e.fromStock)}
                            </span>
                          ))}
                        {/* A delivery's payment already says which delivery; anything else paid toward a bill says so. */}
                        {e.towardBill && !e.fromStock && (
                          <span className="ms-2 inline-flex items-center whitespace-nowrap rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-500" data-expense-bill>
                            {E.towardBill}
                          </span>
                        )}
                        {e.note && <div className="text-[12px] text-ink-400">{e.note}</div>}
                      </td>
                      <td className="px-5 py-2.5">
                        <span className="flex items-center gap-1.5 text-ink-500">
                          {e.categoryColor && (
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: e.categoryColor }}
                            />
                          )}
                          {label({ name: e.categoryName, name_ar: e.categoryNameAr })}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 text-end font-medium tabular-nums">
                        {money(e.amount)}
                      </td>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t.common.edit}
                            onClick={() =>
                              setDraft({
                                id: e.id,
                                categoryId: e.categoryId,
                                amount: String(e.amount),
                                vendor: e.vendor,
                                note: e.note,
                                spentOn: e.spentOn,
                                method: e.method as Method,
                                hasReceipt: e.hasReceipt,
                                unpaid: false,
                                dueOn: "",
                              })
                            }
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t.common.delete}
                            onClick={() => setDeleteId(e.id)}
                          >
                            <Trash2 className="h-4 w-4 text-danger" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Repeating bills live beside the ledger rather than in settings: the
            moment somebody wants "and this happens every month" is while they
            are typing this month's. */}
        <Card>
          <CardHeader
            title={t.expenses.repeating}
            sub={t.expenses.repeatingSub}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setSchedDraft({
                    categoryId: categories.find((c) => c.active)?.id ?? null,
                    amount: "",
                    vendor: "",
                    note: "",
                    method: "transfer",
                    dayOfMonth: "1",
                    active: true,
                  })
                }
              >
                <Plus className="h-4 w-4" />
                {t.expenses.addRepeating}
              </Button>
            }
          />
          {schedules.length === 0 ? (
            <p className="px-5 py-6 text-center text-[13px] text-ink-400">
              {t.expenses.noRepeating}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {schedules.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{s.vendor || "—"}</span>
                      {!s.active && <Badge status="cancelled">{t.expenses.paused}</Badge>}
                    </div>
                    <div className="text-[12px] text-ink-500">
                      {money(s.amount)} ·{" "}
                      {t.expenses.everyMonthOn.replace("{d}", String(s.day_of_month))} ·{" "}
                      {label({ name: s.category_name, name_ar: s.category_name_ar })}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.common.edit}
                    onClick={() =>
                      setSchedDraft({
                        id: s.id,
                        categoryId: s.category_id,
                        amount: String(s.amount),
                        vendor: s.vendor,
                        note: s.note,
                        method: s.method,
                        dayOfMonth: String(s.day_of_month),
                        active: s.active,
                      })
                    }
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.common.delete}
                    onClick={() => setDeleteSchedId(s.id)}
                  >
                    <Trash2 className="h-4 w-4 text-danger" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title={t.expenses.categories}
            sub={t.expenses.categoriesSub}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setCatDraft({ name: "", nameAr: "", color: "#6989a6", active: true })
                }
              >
                <Plus className="h-4 w-4" />
                {t.expenses.addCategory}
              </Button>
            }
          />
          <ul className="divide-y divide-line">
            {categories.map((c) => (
              <li key={c.id} className={`flex items-center gap-3 px-5 py-2.5 ${c.active ? "" : "opacity-50"}`}>
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
                <span className="flex-1 text-[13px]">{label(c)}</span>
                {!c.active && <Badge status="cancelled">{t.expenses.hidden}</Badge>}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t.common.edit}
                  onClick={() =>
                    setCatDraft({
                      id: c.id,
                      name: c.name,
                      nameAr: c.name_ar ?? "",
                      color: c.color,
                      active: c.active,
                    })
                  }
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t.common.delete}
                  onClick={() => setDeleteCatId(c.id)}
                >
                  <Trash2 className="h-4 w-4 text-danger" />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* ---------------------------------------------------------- expense */}
      <Modal
        open={!!draft}
        onClose={() => {
          setDraft(null);
          setPendingReceipt(null);
        }}
        title={draft?.billId ? E.editBill : draft?.id ? t.common.edit : draft?.unpaid ? E.addBill : t.expenses.add}
      >
        {draft && (
          <div className="grid gap-4" data-expense-form={draft.unpaid ? "bill" : "expense"}>
            {/* Only while adding: an expense stays an expense and a bill a bill once saved. */}
            {!draft.id && !draft.billId && (
              <Field label={E.payment}>
                <Select
                  value={draft.unpaid ? "owed" : "paid"}
                  onChange={(e) => setDraft({ ...draft, unpaid: e.target.value === "owed" })}
                  data-expense-payment
                >
                  <option value="paid">{E.paidNow}</option>
                  <option value="owed">{E.notPaidYet}</option>
                </Select>
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.expenses.amount} required>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.5}
                  dir="ltr"
                  value={draft.amount}
                  onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                  data-expense-amount
                />
              </Field>
              <Field label={draft.unpaid ? E.billDate : t.common.date} required>
                <Input
                  type="date"
                  value={draft.spentOn}
                  onChange={(e) => setDraft({ ...draft, spentOn: e.target.value })}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.expenses.category}>
                <Select
                  value={draft.categoryId ?? ""}
                  onChange={(e) => setDraft({ ...draft, categoryId: e.target.value || null })}
                >
                  <option value="">{t.expenses.unfiled}</option>
                  {categories
                    .filter((c) => c.active || c.id === draft.categoryId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {label(c)}
                      </option>
                    ))}
                </Select>
              </Field>
              {draft.unpaid ? (
                <Field label={E.dueOn} hint={t.common.optional}>
                  <Input
                    type="date"
                    value={draft.dueOn}
                    min={draft.spentOn || undefined}
                    onChange={(e) => setDraft({ ...draft, dueOn: e.target.value })}
                    data-bill-due-input
                  />
                </Field>
              ) : (
                <Field label={t.expenses.method}>
                  <Select
                    value={draft.method}
                    onChange={(e) => setDraft({ ...draft, method: e.target.value as Method })}
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t.expenses.methods[m]}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            {/* Who is owed is what a bill is about, so it is asked for; on an expense it is optional. */}
            <Field
              label={draft.unpaid ? E.supplier : t.expenses.vendor}
              required={draft.unpaid}
              hint={draft.unpaid ? undefined : t.common.optional}
            >
              <Input
                value={draft.vendor}
                maxLength={120}
                disabled={draft.fixedVendor}
                onChange={(e) => setDraft({ ...draft, vendor: e.target.value })}
                data-expense-vendor
              />
            </Field>
            {/*
              Available while adding as well as editing. The upload itself is
              addressed by id and so has to wait for the row, but that is a
              mechanical detail and not something to make somebody live with:
              a file chosen now is held and sent the moment Save returns one.
              Not on a bill: the receipt belongs to the payment, which is an
              expense of its own.
            */}
            {!draft.unpaid && (
            <Field label={t.expenses.receipt} hint={t.expenses.receiptHint}>
                <div className="flex flex-wrap items-center gap-2">
                  {draft.hasReceipt && (
                    <a
                      href={`/api/c/${slug}/expenses/${draft.id}/receipt`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[13px] font-medium text-brand-700 hover:underline"
                    >
                      {t.expenses.viewReceipt}
                    </a>
                  )}
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      className="hidden"
                      accept="image/*,application/pdf"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        // Cleared so picking the same file again still fires.
                        e.target.value = "";
                        if (!f) return;
                        // Nothing to attach to yet: hold it for Save.
                        if (!draft.id) {
                          setPendingReceipt(f);
                          return;
                        }
                        setUploading(true);
                        const ok = await uploadReceipt(draft.id, f);
                        setUploading(false);
                        if (!ok) return;
                        toast(t.common.saved);
                        setDraft({ ...draft, hasReceipt: true });
                        router.refresh();
                      }}
                    />
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:border-brand-400">
                      <Paperclip className="h-3.5 w-3.5" />
                      {uploading
                        ? t.common.saving
                        : pendingReceipt
                          ? pendingReceipt.name
                          : draft.hasReceipt
                            ? t.expenses.replaceReceipt
                            : t.expenses.attachReceipt}
                    </span>
                  </label>
                </div>
            </Field>
            )}
            <Field label={t.expenses.note} hint={t.common.optional}>
              <Textarea
                value={draft.note}
                maxLength={500}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setDraft(null);
                  setPendingReceipt(null);
                }}
              >
                {t.common.cancel}
              </Button>
              <Button
                loading={pending}
                disabled={!draft.amount || !draft.spentOn || (draft.unpaid && !draft.vendor.trim())}
                data-expense-save
                onClick={() =>
                  draft.unpaid
                    ? run(
                        () =>
                          saveBillAction(slug, {
                            id: draft.billId,
                            categoryId: draft.categoryId,
                            amount: draft.amount,
                            vendor: draft.vendor,
                            note: draft.note,
                            incurredOn: draft.spentOn,
                            dueOn: draft.dueOn || null,
                          }),
                        () => setDraft(null),
                        () => setDraft(draft)
                      )
                    : start(async () => {
                    const r = await saveExpenseAction(slug, {
                      id: draft.id,
                      categoryId: draft.categoryId,
                      amount: draft.amount,
                      vendor: draft.vendor,
                      note: draft.note,
                      spentOn: draft.spentOn,
                      method: draft.method,
                    });
                    if (r.error) {
                      toast(t.common.genericError, "error");
                      return;
                    }
                    /*
                      The bill, now that there is a row to pin it to. A failure
                      here has already been reported and leaves the expense
                      saved — losing what somebody typed because a photo would
                      not upload would be the worse trade.

                      The save itself came back with the page redrawn, so only an
                      upload after it leaves the list behind.
                    */
                    if (pendingReceipt && r.id) {
                      await uploadReceipt(r.id, pendingReceipt);
                      router.refresh();
                    }
                    toast(t.common.saved);
                    setPendingReceipt(null);
                    setDraft(null);
                  })
                }
              >
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* --------------------------------------------------------- category */}
      <Modal
        open={!!catDraft}
        onClose={() => setCatDraft(null)}
        title={catDraft?.id ? t.common.edit : t.expenses.addCategory}
      >
        {catDraft && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.expenses.name} required>
                <Input
                  value={catDraft.name}
                  maxLength={60}
                  onChange={(e) => setCatDraft({ ...catDraft, name: e.target.value })}
                />
              </Field>
              <Field label={t.expenses.nameAr}>
                <Input
                  dir="rtl"
                  value={catDraft.nameAr}
                  maxLength={60}
                  onChange={(e) => setCatDraft({ ...catDraft, nameAr: e.target.value })}
                />
              </Field>
            </div>
            <Field label={t.expenses.color}>
              <input
                type="color"
                value={catDraft.color}
                onChange={(e) => setCatDraft({ ...catDraft, color: e.target.value })}
                className="h-9 w-14 cursor-pointer rounded-md border border-line-strong"
              />
            </Field>
            <label className="flex items-center gap-2.5">
              <Toggle
                checked={catDraft.active}
                onChange={(v) => setCatDraft({ ...catDraft, active: v })}
              />
              <span className="text-[13px] font-medium">
                {catDraft.active ? t.expenses.shown : t.expenses.hidden}
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCatDraft(null)}>
                {t.common.cancel}
              </Button>
              <Button
                loading={pending}
                disabled={!catDraft.name.trim()}
                onClick={() =>
                  run(
                    () => saveExpenseCategoryAction(slug, catDraft),
                    () => setCatDraft(null),
                    () => setCatDraft(catDraft)
                  )
                }
              >
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* -------------------------------------------------------- schedule */}
      <Modal
        open={!!schedDraft}
        onClose={() => setSchedDraft(null)}
        title={schedDraft?.id ? t.common.edit : t.expenses.addRepeating}
      >
        {schedDraft && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.expenses.amount} required>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.5}
                  dir="ltr"
                  value={schedDraft.amount}
                  onChange={(e) => setSchedDraft({ ...schedDraft, amount: e.target.value })}
                />
              </Field>
              <Field label={t.expenses.dayOfMonth} hint={t.expenses.dayOfMonthHint}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={31}
                  dir="ltr"
                  value={schedDraft.dayOfMonth}
                  onChange={(e) => setSchedDraft({ ...schedDraft, dayOfMonth: e.target.value })}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.expenses.category}>
                <Select
                  value={schedDraft.categoryId ?? ""}
                  onChange={(e) =>
                    setSchedDraft({ ...schedDraft, categoryId: e.target.value || null })
                  }
                >
                  <option value="">{t.expenses.unfiled}</option>
                  {categories
                    .filter((c) => c.active || c.id === schedDraft.categoryId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {label(c)}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label={t.expenses.method}>
                <Select
                  value={schedDraft.method}
                  onChange={(e) =>
                    setSchedDraft({ ...schedDraft, method: e.target.value as Method })
                  }
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t.expenses.methods[m]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={t.expenses.vendor} hint={t.common.optional}>
              <Input
                value={schedDraft.vendor}
                maxLength={120}
                onChange={(e) => setSchedDraft({ ...schedDraft, vendor: e.target.value })}
              />
            </Field>
            <label className="flex items-center gap-2.5">
              <Toggle
                checked={schedDraft.active}
                onChange={(v) => setSchedDraft({ ...schedDraft, active: v })}
              />
              <span className="text-[13px] font-medium">
                {schedDraft.active ? t.expenses.running : t.expenses.paused}
              </span>
            </label>
            <p className="text-[12px] leading-relaxed text-ink-500">{t.expenses.repeatingNote}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSchedDraft(null)}>
                {t.common.cancel}
              </Button>
              <Button
                loading={pending}
                disabled={!schedDraft.amount || !schedDraft.dayOfMonth}
                onClick={() =>
                  run(
                    () => saveExpenseScheduleAction(slug, schedDraft),
                    () => setSchedDraft(null),
                    () => setSchedDraft(schedDraft)
                  )
                }
              >
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title={t.common.confirmDeleteTitle}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        danger
        loading={pending}
        body={(() => {
          const row = rows.find((r) => r.id === deleteId);
          // A payment toward a bill puts the bill back under To pay, whatever it paid for.
          if (row?.towardBill) return E.confirmDeletePayment;
          return row?.fromStock ? t.expenses.confirmDeleteStock.replace("{product}", row.fromStock) : t.expenses.confirmDeleteBody;
        })()}
        onConfirm={() =>
          run(() => deleteExpenseAction(slug, deleteId!), () => setDeleteId(null))
        }
      />
      <ConfirmDialog
        open={!!deleteCatId}
        onClose={() => setDeleteCatId(null)}
        title={t.common.confirmDeleteTitle}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        danger
        loading={pending}
        body={t.expenses.confirmDeleteCategoryBody}
        onConfirm={() =>
          run(() => deleteExpenseCategoryAction(slug, deleteCatId!), () => setDeleteCatId(null))
        }
      />
      <ConfirmDialog
        open={!!deleteSchedId}
        onClose={() => setDeleteSchedId(null)}
        title={t.common.confirmDeleteTitle}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        danger
        loading={pending}
        body={t.expenses.confirmDeleteScheduleBody}
        onConfirm={() =>
          run(() => deleteExpenseScheduleAction(slug, deleteSchedId!), () => setDeleteSchedId(null))
        }
      />
      <ConfirmDialog
        open={!!deleteBillId}
        onClose={() => setDeleteBillId(null)}
        title={t.common.confirmDeleteTitle}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        danger
        loading={pending}
        body={E.confirmDeleteBill}
        onConfirm={() => run(() => deleteBillAction(slug, deleteBillId!), () => setDeleteBillId(null))}
      />

      {/* ------------------------------------------------------------- pay */}
      <Modal open={!!paying} onClose={() => setPaying(null)} title={paying ? E.payTitle.replace("{name}", paying.group.name || "—") : undefined}>
        {paying &&
          (() => {
            const amt = Number(paying.amount);
            const left = Math.round((paying.group.owed - (amt || 0)) * 100) / 100;
            return (
              <div className="grid gap-4" data-pay-form>
                <p className="text-[13px] leading-relaxed text-ink-500">{E.payOwed.replace("{amount}", money(paying.group.owed))}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t.expenses.amount} required>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.01}
                      dir="ltr"
                      value={paying.amount}
                      onChange={(e) => setPaying({ ...paying, amount: e.target.value })}
                      data-pay-amount
                    />
                  </Field>
                  <Field label={E.paidOn} required>
                    <Input type="date" value={paying.paidOn} onChange={(e) => setPaying({ ...paying, paidOn: e.target.value })} />
                  </Field>
                </div>
                <Field label={t.expenses.method}>
                  <Select value={paying.method} onChange={(e) => setPaying({ ...paying, method: e.target.value as Method })} data-pay-method>
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t.expenses.methods[m]}
                      </option>
                    ))}
                  </Select>
                </Field>
                {amt > 0 && left > 0.005 && <p className="text-[12.5px] text-ink-700">{E.payPart.replace("{left}", money(left))}</p>}
                {left < -0.005 && <p className="text-[12.5px] font-semibold text-danger">{E.payTooMuch}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setPaying(null)}>
                    {t.common.cancel}
                  </Button>
                  <Button disabled={!(amt > 0) || left < -0.005 || !paying.paidOn} onClick={() => pay(paying)} data-pay-save>
                    {E.paySave.replace("{amount}", money(amt || 0))}
                  </Button>
                </div>
              </div>
            );
          })()}
      </Modal>
    </>
  );
}
