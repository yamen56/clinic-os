"use client";

/*
  How a member is paid, on the add form and the edit form alike (0086): a
  percentage of what they bill, a monthly salary, a fee for each visit they are
  called in for, or nothing recorded yet. One at a time — choosing one clears
  the others on the server (pay.ts).

  Only ever rendered for the clinic's owner; the server refuses the deal from
  anybody else, and does not send a colleague's pay to their browser.
*/

import { useI18n } from "@/lib/i18n/client";
import { Field, Input, Select } from "@/components/ui/input";
import { fmtMoney } from "@/lib/dates";
import type { Pay } from "./pay";

export type PayKind = Pay["kind"];

/** The form's copy of a deal: what is typed, before it is a number. */
export type PayDraft = {
  kind: PayKind;
  percent: string;
  costsRule: "shared" | "doctor";
  salary: string;
  day: string;
  fee: string;
};

export const emptyPay = (kind: PayKind = "none"): PayDraft => ({
  kind,
  percent: "",
  costsRule: "shared",
  salary: "",
  day: "1",
  fee: "",
});

/** What a member's row says about them, for the form to start from. */
export function payDraftOf(m: {
  commission_percent: string | null;
  costs_rule: "shared" | "doctor" | null;
  salary_amount: string | null;
  salary_day: number | null;
  on_call_fee: string | null;
}): PayDraft {
  const d = emptyPay();
  d.costsRule = m.costs_rule ?? "shared";
  if (m.commission_percent != null) return { ...d, kind: "percent", percent: String(Number(m.commission_percent)) };
  if (m.salary_amount != null)
    return { ...d, kind: "salary", salary: String(Number(m.salary_amount)), day: String(m.salary_day ?? 1) };
  if (m.on_call_fee != null) return { ...d, kind: "on_call", fee: String(Number(m.on_call_fee)) };
  return d;
}

/** The deal the server is sent, or null while what is typed is not one yet. */
export function payOf(d: PayDraft): Pay | null {
  const n = (s: string) => (s.trim() === "" ? NaN : Number(s));
  switch (d.kind) {
    case "none":
      return { kind: "none" };
    case "percent": {
      const v = n(d.percent);
      return Number.isFinite(v) && v >= 0 && v <= 100 ? { kind: "percent", percent: v, costsRule: d.costsRule } : null;
    }
    case "salary": {
      const v = n(d.salary);
      const day = n(d.day);
      return Number.isFinite(v) && v > 0 && Number.isInteger(day) && day >= 1 && day <= 31
        ? { kind: "salary", amount: v, day }
        : null;
    }
    case "on_call": {
      const v = n(d.fee);
      return Number.isFinite(v) && v >= 0 ? { kind: "on_call", fee: v } : null;
    }
  }
}

/** A share and a per-visit fee are paid on a doctor's own work; anybody can be on a salary. */
export const payKindsFor = (role: string): PayKind[] =>
  role === "doctor" ? ["percent", "salary", "on_call", "none"] : ["salary", "none"];

/** One line for the staff list: "40% share", "Salary · JOD 800 a month". */
export function payLine(
  m: { commission_percent: string | null; salary_amount: string | null; on_call_fee: string | null },
  currency: string,
  locale: string,
  words: { payListPercent: string; payListSalary: string; payListOnCall: string }
): string | null {
  if (m.commission_percent != null) return words.payListPercent.replace("{n}", String(Number(m.commission_percent)));
  if (m.salary_amount != null) return words.payListSalary.replace("{amount}", fmtMoney(Number(m.salary_amount), currency, locale));
  if (m.on_call_fee != null) return words.payListOnCall.replace("{amount}", fmtMoney(Number(m.on_call_fee), currency, locale));
  return null;
}

export function PayEditor({
  role,
  value,
  onChange,
  currency,
}: {
  role: string;
  value: PayDraft;
  onChange: (next: PayDraft) => void;
  currency: string;
}) {
  const { t } = useI18n();
  const S = t.staff;
  /*
    A member already on a deal their job no longer fits — a doctor's share
    left on somebody since filed as "other" — still sees it, so the form tells
    the truth about what is stored; choosing again is what changes it.
  */
  const kinds = payKindsFor(role);
  if (!kinds.includes(value.kind)) kinds.unshift(value.kind);
  const set = (patch: Partial<PayDraft>) => onChange({ ...value, ...patch });
  const money = (
    <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-[12px] font-semibold text-ink-400">
      {currency}
    </span>
  );

  return (
    <div className="rounded-lg border border-line p-3" data-pay-editor={value.kind}>
      <div className="mb-2.5">
        <div className="text-[13px] font-semibold">{S.pay}</div>
        <p className="text-[12px] text-ink-500">{S.payHint}</p>
      </div>
      {/* Two by two on a phone, where four words in a row truncate; one row from a tablet up. */}
      <div role="radiogroup" aria-label={S.pay} className="flex w-full gap-0.5 rounded-ctl bg-sunken p-1 ring-1 ring-line max-sm:grid max-sm:grid-cols-2">
        {kinds.map((k) => {
          const on = value.kind === k;
          return (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={on}
              data-pay-kind={k}
              onClick={() => set({ kind: k })}
              className={`flex h-9 min-w-0 flex-1 touch-manipulation items-center justify-center rounded-[6px] px-1.5 text-[13px] font-semibold transition-colors duration-140 ease-out ${
                on ? "bg-surface text-ink-900 shadow-card ring-1 ring-line" : "text-ink-500 hover:text-ink-900"
              }`}
            >
              <span className="truncate">{S.payKinds[k]}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        {value.kind === "percent" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={S.payPercentLabel} hint={S.payPercentHint}>
              <div className="relative">
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={0.5}
                  dir="ltr"
                  value={value.percent}
                  onChange={(e) => set({ percent: e.target.value })}
                  className="pe-9"
                  data-pay-percent
                />
                <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-[13px] font-semibold text-ink-400">%</span>
              </div>
            </Field>
            <Field label={S.costsRule} hint={S.costsRuleHint}>
              <Select
                value={value.costsRule}
                onChange={(e) => set({ costsRule: e.target.value === "doctor" ? "doctor" : "shared" })}
                data-costs-rule
              >
                <option value="shared">{S.costsShared}</option>
                <option value="doctor">{S.costsDoctor}</option>
              </Select>
            </Field>
          </div>
        )}
        {value.kind === "salary" && (
          <>
            <div className="grid grid-cols-[1fr_7rem] gap-3">
              <Field label={S.paySalaryLabel}>
                <div className="relative">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    dir="ltr"
                    value={value.salary}
                    onChange={(e) => set({ salary: e.target.value })}
                    className="pe-14"
                    data-pay-salary
                  />
                  {money}
                </div>
              </Field>
              <Field label={S.paySalaryDay}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={31}
                  dir="ltr"
                  value={value.day}
                  onChange={(e) => set({ day: e.target.value })}
                  data-pay-day
                />
              </Field>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-500">{S.paySalaryHint}</p>
          </>
        )}
        {value.kind === "on_call" && (
          <Field label={S.payOnCallLabel} hint={S.payOnCallHint}>
            <div className="relative sm:max-w-60">
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                dir="ltr"
                value={value.fee}
                onChange={(e) => set({ fee: e.target.value })}
                className="pe-14"
                data-pay-fee
              />
              {money}
            </div>
          </Field>
        )}
        {value.kind === "none" && <p className="text-[12px] leading-relaxed text-ink-500">{S.payNoneHint}</p>}
      </div>
    </div>
  );
}
