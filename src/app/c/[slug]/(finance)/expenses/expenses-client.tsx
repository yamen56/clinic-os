"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { DateTime } from "luxon";
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
  Tags,
  CalendarClock,
  Repeat,
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
  /**
   * Paid, but only part of it (2026-11-20): saved as a bill for the full
   * amount with `paidNow` paid toward it on the day, so the rest is owed.
   * Only while adding a paid one.
   */
  partPaid: boolean;
  paidNow: string;
  dueOn: string;
  /** Editing a bill rather than an expense. */
  billId?: string;
  /** A stock company's bill: who it is owed to is the company, not something typed. */
  fixedVendor?: boolean;
  /**
   * Every month (expense_schedules): saved as a rule, which writes this
   * month's expense at once and the rest on their day. Added from the same
   * form as any expense since 2026-11-16 — it used to be a form of its own.
   */
  repeat: boolean;
  /** For a repeating one: the day of the month it lands on, "1"–"31". */
  dayOfMonth: string;
  /** For a repeating one being edited: running or paused. */
  active: boolean;
  /** Editing a repeating rule rather than an expense. */
  scheduleId?: string;
};

/** Which of the three an expense being added is. */
type Kind = "paid" | "owed" | "monthly";

/** Paying a supplier: how much of what they are owed, on which day, how. */
type PayDraft = { group: SupplierOwed; amount: string; paidOn: string; method: Method };

/** The three lists of the screen: what was spent, what is owed, what repeats. */
export type ExpensesView = "spent" | "pay" | "monthly";
type View = ExpensesView;

type CatDraft = { id?: string; name: string; nameAr: string; color: string; active: boolean };


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
  initialView,
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
  /** From `?view=`, so a link or a refresh opens the same list. */
  initialView: View;
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
  const [catsOpen, setCatsOpen] = useState(false);

  /*
    Which list is open. Local, so the switch answers the tap; mirrored into the
    URL without a navigation, so a refresh — and router.refresh() after a save —
    keeps it. An old link to "#to-pay" (Stock used one) opens To pay.
  */
  const [view, setView] = useState<View>(initialView);
  useEffect(() => {
    if (window.location.hash === "#to-pay") setView("pay");
  }, []);
  const show = (v: View) => {
    setView(v);
    const u = new URL(window.location.href);
    if (v === "spent") u.searchParams.delete("view");
    else u.searchParams.set("view", v);
    window.history.replaceState(window.history.state, "", u.pathname + u.search);
  };

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

  const todayDay = String(Number(todayLocal.slice(8, 10)) || 1);
  const emptyDraft = (): Draft => ({
    categoryId: categories.find((c) => c.active)?.id ?? null,
    amount: "",
    vendor: "",
    note: "",
    spentOn: defaultDate,
    method: "cash",
    hasReceipt: false,
    unpaid: false,
    partPaid: false,
    paidNow: "",
    dueOn: "",
    repeat: false,
    dayOfMonth: todayDay,
    active: true,
  });

  const billDraft = (b: Bill): Draft => ({
    billId: b.id,
    unpaid: true,
    partPaid: false,
    paidNow: "",
    fixedVendor: !!b.companyId,
    categoryId: b.categoryId,
    amount: String(b.amount),
    vendor: b.vendor,
    note: b.note,
    spentOn: b.incurredOn,
    dueOn: b.dueOn ?? "",
    method: "cash",
    hasReceipt: false,
    repeat: false,
    dayOfMonth: todayDay,
    active: true,
  });

  /** A repeating rule, opened in the same form it was added from. */
  const scheduleDraft = (r: Schedule): Draft => ({
    scheduleId: r.id,
    repeat: true,
    unpaid: false,
    partPaid: false,
    paidNow: "",
    categoryId: r.category_id,
    amount: String(r.amount),
    vendor: r.vendor,
    note: r.note,
    method: r.method,
    dayOfMonth: String(r.day_of_month),
    active: r.active,
    spentOn: defaultDate,
    dueOn: "",
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
  const overdue = suppliers.reduce((n, s) => n + s.bills.filter((b) => !!b.dueOn && b.dueOn < todayLocal).length, 0);
  const openBills = suppliers.reduce((n, s) => n + s.bills.length, 0) + (labsOwed ? 1 : 0);
  const intl = locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB";

  /* The month's expenses by day, newest first — the order the server lists them in. */
  const days = useMemo(() => {
    const out: { day: string; total: number; rows: ExpenseRow[] }[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.day === r.spentOn) {
        last.rows.push(r);
        last.total += r.amount;
      } else out.push({ day: r.spentOn, total: r.amount, rows: [r] });
    }
    return out;
  }, [rows]);

  /* Each list with the picture its kind wears in the add form: paid, owed, every month. */
  const views: [View, string, number, typeof Banknote][] = [
    ["spent", E.views.spent, rows.length, Banknote],
    ["pay", E.views.pay, openBills, CalendarClock],
    ["monthly", E.views.monthly, schedules.length, Repeat],
  ];

  const kindOf = (d: Draft): Kind => (d.repeat ? "monthly" : d.unpaid ? "owed" : "paid");
  /** A new paid one, of which only part was paid. */
  const partOn = (d: Draft) => !d.id && !d.billId && !d.scheduleId && !d.unpaid && !d.repeat && d.partPaid;
  /** What would still be owed, once both amounts are typed; null until then. */
  const partLeft = (d: Draft): number | null => {
    const total = Number(d.amount);
    const now = Number(d.paidNow);
    if (!d.amount || !d.paidNow || !(total > 0) || !(now > 0)) return null;
    return Math.round((total - now) * 100) / 100;
  };
  /** Where a new one is listed, so the screen can show it there once it is saved. */
  const listOf: Record<Kind, View> = { paid: "spent", owed: "pay", monthly: "monthly" };

  const editExpense = (e: ExpenseRow) =>
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
      partPaid: false,
      paidNow: "",
      dueOn: "",
      repeat: false,
      dayOfMonth: todayDay,
      active: true,
    });

  const stepMonth = (to: number) => {
    show("spent");
    router.push(`/c/${slug}/expenses?m=${to}`);
  };

  return (
    <>
      <PageHeader
        title={t.nav.expenses}
        sub={E.sub}
        action={
          <>
            <a
              href={`/api/c/${slug}/expenses/export?from=${monthFrom}&to=${monthTo}`}
              download
              className={buttonClass({ variant: "outline" })}
            >
              <Download className="h-4 w-4" />
              {t.invoices.exportCsv}
            </a>
            <Button onClick={() => setDraft(emptyDraft())}>
              <Plus className="h-4 w-4" />
              {t.expenses.add}
            </Button>
          </>
        }
      />

      {/*
        Two answers first, before any list (Yamen, 2026-11-15: the screen was
        "not easy to understand the first time"). What the clinic spent — with
        the month it is about, because only this side changes by month — and
        what it still owes, which is owed until it is paid whatever month is on
        screen. Everything below is the detail behind one of them.
      */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-ink-500">{E.views.spent}</span>
            <div className="flex items-center gap-1">
              <button
                aria-label={t.earnings.previousMonth}
                onClick={() => stepMonth(offset - 1)}
                className="grid h-7 w-7 place-items-center rounded-full text-ink-500 transition-colors hover:bg-ink-900/5 hover:text-ink-900"
              >
                <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
              </button>
              <span className="min-w-28 text-center text-[13px] font-semibold text-ink-900 tabular-nums">
                {monthLabel(timezone, offset, locale)}
              </span>
              <button
                aria-label={t.earnings.nextMonth}
                disabled={offset >= 0}
                onClick={() => stepMonth(offset + 1)}
                className="grid h-7 w-7 place-items-center rounded-full text-ink-500 transition-colors hover:bg-ink-900/5 hover:text-ink-900 disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronRight className="h-4 w-4 rtl:rotate-180" />
              </button>
            </div>
          </div>
          <div className="mt-2 font-display text-[26px] font-bold leading-tight text-ink-900" data-month-spent={total}>
            {money(total)}
          </div>
          <div className="mt-1 text-[12px] text-ink-400">{E.expensesCount.replace("{n}", String(rows.length))}</div>
        </Card>

        {/* The whole card opens what is owed. A raw button, not Card: the hook has to reach the element. */}
        <button
          type="button"
          onClick={() => show("pay")}
          data-to-pay={owedTotal}
          className="min-w-0 rounded-card border border-line bg-surface p-5 text-start shadow-card transition-shadow duration-220 ease-out hover:shadow-pop"
        >
          <div className="flex h-7 items-center justify-between gap-3">
            <span className="text-[13px] text-ink-500">{E.stillToPay}</span>
            <ChevronRight className="h-4 w-4 text-ink-400 rtl:rotate-180" aria-hidden />
          </div>
          <div className="mt-2 font-display text-[26px] font-bold leading-tight text-ink-900">{money(owedTotal)}</div>
          <div className="mt-1 flex flex-wrap gap-x-2 text-[12px] text-ink-400">
            {owedTotal <= 0 ? (
              E.nothingOwedShort
            ) : (
              <>
                <span>{E.suppliersCount.replace("{n}", String(suppliers.length + (labsOwed ? 1 : 0)))}</span>
                {overdue > 0 && (
                  <span className="font-semibold text-danger">{E.overdueCount.replace("{n}", String(overdue))}</span>
                )}
              </>
            )}
          </div>
        </button>
      </div>

      {/*
        One list at a time. A switch, held here and mirrored into the URL
        (`?view=pay`) so a refresh or a link opens the same one — the page does
        not reload to change it.
      */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label={t.nav.expenses} className="inline-flex max-w-full overflow-x-auto rounded-full bg-ink-900/5 p-0.5">
          {views.map(([key, label, count, Icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => show(key)}
              data-expenses-view={key}
              className={`flex touch-manipulation items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-1.5 text-[13px] font-semibold transition-colors duration-140 ease-out ${
                view === key ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-700"
              }`}
            >
              {/* From a tablet up: on a phone the icons push Categories onto a line of its own. */}
              <Icon className="h-3.5 w-3.5 shrink-0 max-sm:hidden" aria-hidden />
              {label}
              {count > 0 && <span className="text-[12px] font-medium text-ink-400 tnum">{count}</span>}
            </button>
          ))}
        </div>
        {/* The word on a wider screen; on a phone the icon alone, so it stays on the switch's line. */}
        <Button size="sm" variant="ghost" onClick={() => setCatsOpen(true)} data-categories-open>
          <Tags className="h-4 w-4" />
          <span className="max-sm:sr-only">{E.categories}</span>
        </Button>
      </div>

      {/* ------------------------------------------------------------ spent */}
      {view === "spent" &&
        (rows.length === 0 ? (
          <EmptyState
            icon={<Banknote className="h-6 w-6" />}
            title={E.emptyTitle}
            body={E.emptyBody}
            action={<Button onClick={() => setDraft(emptyDraft())}>{E.add}</Button>}
          />
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-3">
            <Card className="overflow-hidden lg:col-span-2">
              {days.map((d) => (
                <section key={d.day}>
                  {/* The day, and what went out on it. */}
                  <div className="flex items-baseline justify-between gap-3 border-b border-line bg-sunken/70 px-5 py-2 text-[12px]">
                    <span className="font-semibold text-ink-700">
                      {DateTime.fromISO(d.day).setLocale(intl).toFormat("cccc d LLLL")}
                    </span>
                    <span className="text-ink-500 tnum">{money(d.total)}</span>
                  </div>
                  <ul className="divide-y divide-line border-b border-line">
                    {d.rows.map((e) => {
                      const cat = label({ name: e.categoryName, name_ar: e.categoryNameAr });
                      return (
                        <li key={e.id} className="flex items-center gap-3 py-3 ps-5 pe-3">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: e.categoryColor ?? "var(--color-ink-300)" }}
                            aria-hidden
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="truncate text-[14px] font-medium text-ink-900" dir="auto">
                                {e.vendor || cat}
                              </span>
                              {e.recurring && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-500">
                                  <RotateCw className="h-3 w-3" />
                                  {E.recurring}
                                </span>
                              )}
                              {e.fromStock &&
                                (stockHref ? (
                                  <Link
                                    href={stockHref}
                                    className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold text-brand-700 hover:underline"
                                    data-expense-stock
                                  >
                                    <Package className="h-3 w-3" />
                                    {E.fromDelivery.replace("{product}", e.fromStock)}
                                  </Link>
                                ) : (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-500" data-expense-stock>
                                    <Package className="h-3 w-3" />
                                    {E.fromDelivery.replace("{product}", e.fromStock)}
                                  </span>
                                ))}
                              {/* A delivery's payment already says which delivery; anything else paid toward a bill says so. */}
                              {e.towardBill && !e.fromStock && (
                                <span className="inline-flex items-center whitespace-nowrap rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-500" data-expense-bill>
                                  {E.towardBill}
                                </span>
                              )}
                              {e.hasReceipt && <Paperclip className="h-3.5 w-3.5 text-ink-400" aria-label={E.receipt} />}
                            </div>
                            <div className="truncate text-[12px] text-ink-500" dir="auto">
                              {[e.vendor ? cat : null, (E.methods as Record<string, string>)[e.method] ?? e.method, e.note || null]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </div>
                          <span className="shrink-0 text-[14px] font-semibold text-ink-900 tnum">{money(e.amount)}</span>
                          <div className="flex shrink-0 items-center">
                            <Button variant="ghost" size="icon" aria-label={t.common.edit} onClick={() => editExpense(e)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" aria-label={t.common.delete} onClick={() => setDeleteId(e.id)}>
                              <Trash2 className="h-4 w-4 text-danger" />
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </Card>

            {byCategory.length > 0 && (
              <Card>
                <CardHeader title={E.byCategory} />
                <ul className="divide-y divide-line">
                  {byCategory.map((b) => (
                    <li key={b.categoryId ?? "__unfiled"} className="px-5 py-3">
                      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: b.color ?? "var(--color-ink-300)" }}
                            aria-hidden
                          />
                          <span className="truncate text-ink-900">{label(b)}</span>
                        </span>
                        <span className="shrink-0 tnum">
                          <span className="font-semibold text-ink-900">{money(b.total)}</span>
                          <span className="ms-2 inline-block w-9 text-end text-[12px] text-ink-400">
                            {total > 0 ? Math.round((b.total / total) * 100) : 0}%
                          </span>
                        </span>
                      </div>
                      {/* Positive by construction — `amount > 0` — which is the only reason a bar is safe here at all. */}
                      <RowBar value={b.total} max={maxCategory} />
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        ))}

      {/* ----------------------------------------------------------- to pay */}
      {view === "pay" && (
        <div id="to-pay" className="scroll-mt-24">
          <Card>
            <CardHeader
              title={E.views.pay}
              sub={E.toPaySub}
              action={
                <Button size="sm" variant="outline" onClick={() => setDraft({ ...emptyDraft(), unpaid: true })} data-bill-add>
                  <Plus className="h-4 w-4" />
                  {E.addBill}
                </Button>
              }
            />
            {owedTotal <= 0 ? (
              <p className="px-5 py-8 text-center text-[13px] text-ink-400">{E.nothingOwed}</p>
            ) : (
              <ul className="divide-y divide-line">
                {suppliers.map((s) => (
                  <li key={s.key} className="px-5 py-4" data-supplier={s.name}>
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
                    <ul className="mt-2.5 grid gap-1.5">
                      {s.bills.map((b) => {
                        const late = !!b.dueOn && b.dueOn < todayLocal;
                        return (
                          <li key={b.id} className="flex items-center gap-2 rounded-ctl bg-sunken py-1.5 ps-3 pe-1 text-[12.5px]" data-bill={b.id}>
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
                  <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-4" data-labs-owed={labsOwed.owed}>
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
            )}
          </Card>
        </div>
      )}

      {/* ------------------------------------------------------ every month */}
      {view === "monthly" && (
        <Card>
          <CardHeader
            title={E.views.monthly}
            sub={E.repeatingSub}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraft({ ...emptyDraft(), repeat: true })}
              >
                <Plus className="h-4 w-4" />
                {E.addRepeating}
              </Button>
            }
          />
          {schedules.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-ink-400">{E.noRepeating}</p>
          ) : (
            <ul className="divide-y divide-line">
              {schedules.map((s) => (
                <li key={s.id} className={`flex items-center gap-3 py-3 ps-5 pe-3 ${s.active ? "" : "opacity-60"}`}>
                  {/* The day of the month it lands on, as a date would be printed on a calendar. */}
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-ctl bg-sunken text-[15px] font-bold text-ink-900 tnum" aria-hidden>
                    {s.day_of_month}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-ink-900" dir="auto">
                        {s.vendor || label({ name: s.category_name, name_ar: s.category_name_ar })}
                      </span>
                      {!s.active && <Badge status="cancelled">{E.paused}</Badge>}
                    </div>
                    <div className="truncate text-[12px] text-ink-500">
                      {E.everyMonthOn.replace("{d}", String(s.day_of_month))} · {label({ name: s.category_name, name_ar: s.category_name_ar })}
                    </div>
                  </div>
                  <span className="shrink-0 text-[14px] font-semibold text-ink-900 tnum">{money(s.amount)}</span>
                  <div className="flex shrink-0 items-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t.common.edit}
                      onClick={() => setDraft(scheduleDraft(s))}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={t.common.delete} onClick={() => setDeleteSchedId(s.id)}>
                      <Trash2 className="h-4 w-4 text-danger" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* ------------------------------------------------------- categories */}
      {/*
        The clinic's own filing, kept out of the way: it is set up once and
        touched rarely, and as a card at the bottom of the screen it was the
        longest thing on it. Editing one opens over this window.
      */}
      <Modal open={catsOpen} onClose={() => setCatsOpen(false)} title={E.categories}>
        <div className="grid gap-4" data-categories>
          <p className="text-[13px] leading-relaxed text-ink-500">{E.categoriesSub}</p>
          <ul className="divide-y divide-line rounded-ctl border border-line">
            {categories.map((c) => (
              <li key={c.id} className={`flex items-center gap-3 py-1.5 ps-3.5 pe-1.5 ${c.active ? "" : "opacity-50"}`}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
                <span className="flex-1 text-[13px]">{label(c)}</span>
                {!c.active && <Badge status="cancelled">{E.hidden}</Badge>}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t.common.edit}
                  onClick={() => setCatDraft({ id: c.id, name: c.name, nameAr: c.name_ar ?? "", color: c.color, active: c.active })}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" aria-label={t.common.delete} onClick={() => setDeleteCatId(c.id)}>
                  <Trash2 className="h-4 w-4 text-danger" />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setCatDraft({ name: "", nameAr: "", color: "#6989a6", active: true })}>
              <Plus className="h-4 w-4" />
              {E.addCategory}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ---------------------------------------------------------- expense */}
      <Modal
        open={!!draft}
        onClose={() => {
          setDraft(null);
          setPendingReceipt(null);
        }}
        title={draft?.billId ? E.editBill : draft?.scheduleId ? E.editRepeating : draft?.id ? t.common.edit : t.expenses.add}
      >
        {draft && (
          <div className="grid gap-4" data-expense-form={draft.repeat ? "monthly" : draft.unpaid ? "bill" : "expense"}>
            {/*
              One place to add any expense (Yamen, 2026-11-16): paid now, not
              paid yet, or every month. The repeating kind was a form of its
              own, with its own questions; here it is one tap, and it asks the
              day of the month instead of the date. Only while adding: an
              expense stays an expense, a bill a bill, a rule a rule.
            */}
            {!draft.id && !draft.billId && !draft.scheduleId && (
              <div role="radiogroup" aria-label={E.payment} className="grid grid-cols-3 gap-0.5 rounded-ctl bg-ink-900/5 p-0.5" data-expense-kind={kindOf(draft)}>
                {(
                  [
                    ["paid", E.kinds.paid, Banknote],
                    ["owed", E.kinds.owed, CalendarClock],
                    ["monthly", E.kinds.monthly, Repeat],
                  ] as const
                ).map(([k, text, Icon]) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kindOf(draft) === k}
                    onClick={() => setDraft({ ...draft, unpaid: k === "owed", repeat: k === "monthly" })}
                    data-kind={k}
                    className={`flex touch-manipulation items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[13px] font-semibold transition-colors duration-140 ease-out ${
                      kindOf(draft) === k ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-700"
                    }`}
                  >
                    {/* Words only on a phone: three labels and three icons do not fit a third of 358px. */}
                    <Icon className="h-4 w-4 shrink-0 max-sm:hidden" aria-hidden />
                    <span className="truncate">{text}</span>
                  </button>
                ))}
              </div>
            )}
            {draft.repeat && !draft.scheduleId && <p className="-mt-1 text-[12px] leading-relaxed text-ink-500">{E.repeatHint}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={partOn(draft) ? E.totalAmount : t.expenses.amount} required>
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
              {draft.repeat ? (
                <Field label={E.dayOfMonth} required hint={Number(draft.dayOfMonth) > 28 ? E.dayOfMonthHint : undefined}>
                  <Select value={draft.dayOfMonth} onChange={(e) => setDraft({ ...draft, dayOfMonth: e.target.value })} data-expense-day>
                    {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <Field label={draft.unpaid ? E.billDate : t.common.date} required>
                  <Input
                    type="date"
                    value={draft.spentOn}
                    onChange={(e) => setDraft({ ...draft, spentOn: e.target.value })}
                  />
                </Field>
              )}
            </div>
            {/*
              Paid, but not all of it (Yamen, 2026-11-20). One switch under the
              amount, only while adding a paid one: on, the amount is the full
              price and a second box takes what was handed over today. The rest
              is owed to the supplier and listed under To pay.
            */}
            {!draft.id && !draft.unpaid && !draft.repeat && (
              <div className="grid gap-3 rounded-ctl border border-line px-3 py-2.5" data-part-paid={draft.partPaid}>
                <label className="flex min-h-10 cursor-pointer items-center gap-2.5">
                  <Toggle checked={draft.partPaid} onChange={(v) => setDraft({ ...draft, partPaid: v })} />
                  <span className="text-[13px] font-medium">{E.partPaid}</span>
                </label>
                {draft.partPaid && (
                  <>
                    <Field
                      label={E.paidNow}
                      required
                      hint={
                        partLeft(draft) !== null
                          ? partLeft(draft)! > 0
                            ? E.leftAfter.replace("{left}", money(partLeft(draft)!))
                            : E.paidNowTooMuch
                          : E.partPaidHint
                      }
                    >
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={0.5}
                        dir="ltr"
                        value={draft.paidNow}
                        onChange={(e) => setDraft({ ...draft, paidNow: e.target.value })}
                        data-expense-paid-now
                      />
                    </Field>
                  </>
                )}
              </div>
            )}
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
              label={draft.unpaid || partOn(draft) ? E.supplier : t.expenses.vendor}
              required={draft.unpaid || partOn(draft)}
              hint={draft.unpaid || partOn(draft) ? undefined : t.common.optional}
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
            {!draft.unpaid && !draft.repeat && (
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
            {/* Pausing is a change to a rule that exists, so it is only asked of one. */}
            {draft.scheduleId && (
              <label className="flex items-center gap-2.5">
                <Toggle checked={draft.active} onChange={(v) => setDraft({ ...draft, active: v })} />
                <span className="text-[13px] font-medium">{draft.active ? E.running : E.paused}</span>
              </label>
            )}
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
                disabled={
                  !draft.amount ||
                  (draft.repeat ? !draft.dayOfMonth : !draft.spentOn) ||
                  ((draft.unpaid || partOn(draft)) && !draft.vendor.trim()) ||
                  (partOn(draft) && !((partLeft(draft) ?? 0) > 0))
                }
                data-expense-save
                onClick={() =>
                  partOn(draft)
                    ? start(async () => {
                        const r = await saveBillAction(slug, {
                          categoryId: draft.categoryId,
                          amount: draft.amount,
                          vendor: draft.vendor,
                          note: draft.note,
                          incurredOn: draft.spentOn,
                          dueOn: null,
                          paidNow: draft.paidNow,
                          method: draft.method,
                        });
                        if (r.error) {
                          toast(r.error === "paid_now" ? E.paidNowTooMuch : t.common.genericError, "error");
                          return;
                        }
                        // The receipt is the payment's, so it goes on the expense the part paid wrote.
                        if (pendingReceipt && r.expenseId) {
                          await uploadReceipt(r.expenseId, pendingReceipt);
                          router.refresh();
                        }
                        toast(E.partPaidToast.replace("{left}", money(partLeft(draft) ?? 0)));
                        setPendingReceipt(null);
                        setDraft(null);
                        // Shown where the news is: what is still owed.
                        show(listOf.owed);
                      })
                    : draft.repeat
                    ? run(
                        () =>
                          saveExpenseScheduleAction(slug, {
                            id: draft.scheduleId,
                            categoryId: draft.categoryId,
                            amount: draft.amount,
                            vendor: draft.vendor,
                            note: draft.note,
                            method: draft.method,
                            dayOfMonth: draft.dayOfMonth,
                            active: draft.active,
                          }),
                        // A new one is shown where it went: the Every month list.
                        () => {
                          setDraft(null);
                          if (!draft.scheduleId) show(listOf.monthly);
                        },
                        () => setDraft(draft)
                      )
                    : draft.unpaid
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
                        () => {
                          setDraft(null);
                          if (!draft.billId) show(listOf.owed);
                        },
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
                    if (!draft.id) show(listOf.paid);
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
