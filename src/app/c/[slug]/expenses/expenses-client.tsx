"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateOnly, fmtMoney, monthLabel } from "@/lib/dates";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { RowBar } from "@/components/ui/chart";
import type { ExpenseCategoryTotal, ExpenseRow } from "@/lib/expenses";
import {
  saveExpenseAction,
  deleteExpenseAction,
  saveExpenseCategoryAction,
  deleteExpenseCategoryAction,
  saveExpenseScheduleAction,
  deleteExpenseScheduleAction,
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
} from "lucide-react";

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
};

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
}) {
  const { t, locale } = useI18n();
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

  const money = (n: number | string) => fmtMoney(n, currency, locale);
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

  const emptyDraft = (): Draft => ({
    categoryId: categories.find((c) => c.active)?.id ?? null,
    amount: "",
    vendor: "",
    note: "",
    spentOn: defaultDate,
    method: "cash",
    hasReceipt: false,
  });

  const run = (fn: () => Promise<{ error?: string }>, ok: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.error) {
        toast(
          r.error === "duplicate" ? t.expenses.duplicateCategory : t.common.genericError,
          "error"
        );
        return;
      }
      toast(t.common.saved);
      ok();
      router.refresh();
    });

  const maxCategory = Math.max(1, ...byCategory.map((b) => b.total));

  return (
    <>
      <PageHeader
        title={t.nav.expenses}
        sub={t.expenses.sub}
        action={
          <div className="flex items-center gap-1">
            <button
              aria-label={t.earnings.previousMonth}
              onClick={() => router.push(`/c/${slug}/expenses?m=${offset - 1}`)}
              className="rounded-lg border border-line p-1.5 text-ink-500 hover:border-brand-400"
            >
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </button>
            <span className="min-w-36 text-center text-[13px] font-medium tabular-nums">
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
            <a
              href={`/api/c/${slug}/expenses/export?from=${monthFrom}&to=${monthTo}`}
              download
              className="ms-2"
            >
              <Button variant="outline" size="sm">
                <Download className="h-4 w-4" />
                {t.invoices.exportCsv}
              </Button>
            </a>
            <Button size="sm" className="ms-1" onClick={() => setDraft(emptyDraft())}>
              <Plus className="h-4 w-4" />
              {t.expenses.add}
            </Button>
          </div>
        }
      />

      <div className="grid gap-4">
        <Card className="p-5">
          <div className="text-[11px] uppercase tracking-wide text-ink-400">
            {t.expenses.thisMonth}
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-ink-900">{money(total)}</div>
        </Card>

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
        onClose={() => setDraft(null)}
        title={draft?.id ? t.common.edit : t.expenses.add}
      >
        {draft && (
          <div className="grid gap-4">
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
                />
              </Field>
              <Field label={t.common.date} required>
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
            </div>
            <Field label={t.expenses.vendor} hint={t.common.optional}>
              <Input
                value={draft.vendor}
                maxLength={120}
                placeholder={t.expenses.vendorPlaceholder}
                onChange={(e) => setDraft({ ...draft, vendor: e.target.value })}
              />
            </Field>
            {/*
              Only once the row exists: the upload is addressed by id, and a
              receipt with nothing to attach to has nowhere to go. Typing the
              expense first and attaching second is also the order it happens
              at a desk.
            */}
            {draft.id && (
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
                        if (!f || !draft.id) return;
                        setUploading(true);
                        const fd = new FormData();
                        fd.set("file", f);
                        const res = await fetch(
                          `/api/c/${slug}/expenses/${draft.id}/receipt`,
                          { method: "POST", body: fd }
                        );
                        setUploading(false);
                        if (res.status === 413) {
                          toast(t.expenses.receiptTooLarge, "error");
                          return;
                        }
                        if (!res.ok) {
                          toast(t.common.genericError, "error");
                          return;
                        }
                        toast(t.common.saved);
                        setDraft({ ...draft, hasReceipt: true });
                        router.refresh();
                      }}
                    />
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-[12px] font-medium text-ink-600 hover:border-brand-400">
                      <Paperclip className="h-3.5 w-3.5" />
                      {uploading
                        ? t.common.saving
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
              <Button variant="outline" onClick={() => setDraft(null)}>
                {t.common.cancel}
              </Button>
              <Button
                loading={pending}
                disabled={!draft.amount || !draft.spentOn}
                onClick={() =>
                  run(
                    () =>
                      saveExpenseAction(slug, {
                        id: draft.id,
                        categoryId: draft.categoryId,
                        amount: draft.amount,
                        vendor: draft.vendor,
                        note: draft.note,
                        spentOn: draft.spentOn,
                        method: draft.method,
                      }),
                    () => setDraft(null)
                  )
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
                  run(() => saveExpenseCategoryAction(slug, catDraft), () => setCatDraft(null))
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
                placeholder={t.expenses.vendorPlaceholder}
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
                    () => setSchedDraft(null)
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
        body={t.expenses.confirmDeleteBody}
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
    </>
  );
}
