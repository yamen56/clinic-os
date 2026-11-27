"use client";

import { useI18n } from "@/lib/i18n/client";
import { PLANS, PLAN_PROFILES, planAdds, type Plan } from "@/lib/plans";
import { FEATURE_ICONS } from "./feature-picker";
import { Check } from "lucide-react";

/**
 * The three plans as cards, one tap each. Each card says who it is for, how
 * many people it takes, and what it adds over the one before — the question
 * the agency is actually answering while a clinic owner is on the phone.
 */
export function PlanPicker({
  value,
  onChange,
  disabled,
  name,
}: {
  value: Plan;
  onChange: (p: Plan) => void;
  disabled?: boolean;
  /** Set to post the choice with a plain form. */
  name?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t.admin.plan}>
      {PLANS.map((p) => {
        const on = p === value;
        const limit = PLAN_PROFILES[p].memberLimit;
        const adds = planAdds(p);
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            data-plan-card={p}
            onClick={() => onChange(p)}
            className={`grid content-start gap-2 rounded-card border p-3 text-start transition-colors disabled:opacity-60 ${
              on ? "border-brand-700 bg-brand-50 ring-1 ring-brand-700" : "border-line bg-surface hover:border-ink-300"
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-ink-900">{t.plans.names[p]}</span>
              {on && <Check className="h-4 w-4 text-brand-700" />}
            </span>
            <span className="text-[0.75rem] leading-snug text-ink-500">{t.plans.blurbs[p]}</span>
            <span className="text-[0.75rem] text-ink-700">
              {t.plans.users}: <b className="tnum">{limit ?? t.plans.unlimited}</b>
            </span>
            <span className="eyebrow mt-1">{p === "doctor" ? t.plans.includes : t.plans.adds}</span>
            <span className="flex flex-wrap gap-1">
              {adds.map((f) => {
                const Icon = FEATURE_ICONS[f];
                return (
                  <span
                    key={f}
                    className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[0.6875rem] text-ink-700"
                  >
                    <Icon className="h-3 w-3" strokeWidth={1.75} />
                    {t.caps[f]}
                  </span>
                );
              })}
            </span>
          </button>
        );
      })}
      {name && <input type="hidden" name={name} value={value} />}
    </div>
  );
}
