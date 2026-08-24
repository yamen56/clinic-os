"use client";

import { useI18n } from "@/lib/i18n/client";
import { Toggle } from "@/components/ui/input";
import { FEATURES, type Feature, type FeatureMap } from "@/lib/features";
import {
  MessageCircle,
  CalendarDays,
  Users,
  FileSignature,
  Receipt,
  Megaphone,
  Workflow,
  Sparkles,
  Landmark,
} from "lucide-react";

const icons: Record<Feature, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  conversations: MessageCircle,
  calendar: CalendarDays,
  patients: Users,
  documents: FileSignature,
  invoices: Receipt,
  campaigns: Megaphone,
  automations: Workflow,
  ai: Sparkles,
  einvoicing: Landmark,
};

/**
 * What a clinic is licensed for, as a switch each.
 *
 * Deliberately the plain product names rather than plan tiers. "Standard" and
 * "Pro" would need a table of what each contains, kept in step with the product
 * by hand, and the first clinic that negotiates a different mix breaks it — so
 * the plan stays a free-text label on the invoice and this is what actually
 * decides anything.
 *
 * Wording comes from `t.caps`, which is the staff-permissions dictionary. Same
 * modules, so the same words: an agency reading "WhatsApp inbox" here and an
 * owner reading it on their staff screen are looking at one thing.
 */
export function FeaturePicker({
  value,
  onChange,
  disabled,
}: {
  value: FeatureMap;
  onChange: (next: FeatureMap) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const on = FEATURES.filter((f) => value[f]).length;

  const setAll = (v: boolean) =>
    onChange(Object.fromEntries(FEATURES.map((f) => [f, v])) as FeatureMap);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[13px] text-ink-500 tnum">
          {on === FEATURES.length
            ? t.admin.featuresAll
            : t.admin.featuresOf
                .replace("{n}", String(on))
                .replace("{total}", String(FEATURES.length))}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setAll(true)}
            className="rounded-full px-2.5 py-1 text-[12px] font-medium text-ink-500 hover:bg-ink-900/5 hover:text-ink-900 disabled:opacity-50"
          >
            {t.common.all}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setAll(false)}
            className="rounded-full px-2.5 py-1 text-[12px] font-medium text-ink-500 hover:bg-ink-900/5 hover:text-ink-900 disabled:opacity-50"
          >
            {t.common.none}
          </button>
        </div>
      </div>

      <div className="grid gap-px overflow-hidden rounded-ctl border border-line bg-line sm:grid-cols-2">
        {FEATURES.map((f) => {
          const Icon = icons[f];
          return (
            <label
              key={f}
              className={`flex cursor-pointer items-center gap-2.5 bg-surface px-3 py-2.5 transition-colors ${
                value[f] ? "" : "text-ink-400"
              }`}
            >
              <Icon
                className={`h-4 w-4 shrink-0 ${value[f] ? "text-brand-600" : "text-ink-300"}`}
                strokeWidth={1.75}
              />
              <span className="flex-1 text-[13px] font-medium">{t.caps[f]}</span>
              <Toggle
                checked={value[f]}
                disabled={disabled}
                label={t.caps[f]}
                onChange={(v) => onChange({ ...value, [f]: v })}
              />
            </label>
          );
        })}
      </div>

      {/* The sentence that makes the switch usable. Without it, nobody dares
          turn one off on a clinic that has real work in it. */}
      <p className="mt-2 text-[12px] leading-relaxed text-ink-400">{t.admin.featuresHint}</p>

      {/* One field, so the whole map survives a plain form POST — see
          featureListSchema in the admin actions. */}
      <input type="hidden" name="features" value={FEATURES.filter((f) => value[f]).join(",")} />
    </div>
  );
}
