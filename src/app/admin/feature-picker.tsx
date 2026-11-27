"use client";

import { useI18n } from "@/lib/i18n/client";
import { Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FEATURES, TEST_FEATURES, type Feature, type FeatureMap } from "@/lib/features";
import { PLAN_MODULES, PLAN_PROFILES, applyPlan, type Plan } from "@/lib/plans";
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
  ScanFace,
  Route,
  Send,
  Globe,
  MonitorSmartphone,
  GitBranch,
  Building2,
  Palette,
} from "lucide-react";
import { Tooth } from "@/components/ui/tooth-icon";

export const FEATURE_ICONS: Record<Feature, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  conversations: MessageCircle,
  calendar: CalendarDays,
  patients: Users,
  documents: FileSignature,
  invoices: Receipt,
  campaigns: Megaphone,
  automations: Workflow,
  ai: Sparkles,
  einvoicing: Landmark,
  dental: Tooth,
  aesthetic: ScanFace,
  coordinator: Route,
  esign_remote: Send,
  booking: Globe,
  devices: MonitorSmartphone,
  automations_advanced: GitBranch,
  branches: Building2,
  branding: Palette,
};
const icons = FEATURE_ICONS;

/**
 * What a clinic is licensed for, as a switch each.
 *
 * Since 2026-11-27 a clinic's plan (lib/plans) sets these, and this picker is
 * the agency's exceptions on top of it — a Doctor plan sold with the booking
 * link, say. A switch that differs from the plan is marked, so an exception is
 * never mistaken for the plan.
 *
 * Wording comes from `t.caps`, which is the staff-permissions dictionary. Same
 * modules, so the same words: an agency reading "WhatsApp inbox" here and an
 * owner reading it on their staff screen are looking at one thing.
 */
export function FeaturePicker({
  value,
  onChange,
  disabled,
  plan,
}: {
  value: FeatureMap;
  onChange: (next: FeatureMap) => void;
  disabled?: boolean;
  /** The clinic's plan: switches that differ from it are marked, and "Reset to plan" replaces All/None. */
  plan?: Plan;
}) {
  const { t } = useI18n();
  const counted = FEATURES.filter((f) => !TEST_FEATURES.has(f));
  const on = counted.filter((f) => value[f]).length;
  const planOn = plan ? new Set(PLAN_PROFILES[plan].modules) : null;
  const differs = (f: Feature) => !!planOn && PLAN_MODULES.includes(f) && value[f] !== planOn.has(f);

  // "All" never switches a test on; "None" switches everything off, tests included.
  const setAll = (v: boolean) =>
    onChange(Object.fromEntries(FEATURES.map((f) => [f, v && TEST_FEATURES.has(f) ? value[f] : v])) as FeatureMap);

  const chip =
    "rounded-full px-2.5 py-1 text-[0.75rem] font-medium text-ink-500 hover:bg-ink-900/5 hover:text-ink-900 disabled:opacity-50";

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[0.8125rem] text-ink-500 tnum">
          {on === counted.length
            ? t.admin.featuresAll
            : t.admin.featuresOf
                .replace("{n}", String(on))
                .replace("{total}", String(counted.length))}
        </span>
        <div className="flex items-center gap-1">
          {plan ? (
            <button type="button" disabled={disabled} onClick={() => onChange(applyPlan(value, plan))} className={chip}>
              {t.admin.resetToPlan}
            </button>
          ) : (
            <>
              <button type="button" disabled={disabled} onClick={() => setAll(true)} className={chip}>
                {t.common.all}
              </button>
              <button type="button" disabled={disabled} onClick={() => setAll(false)} className={chip}>
                {t.common.none}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-px overflow-hidden rounded-ctl border border-line bg-line sm:grid-cols-2">
        {FEATURES.map((f) => {
          const Icon = icons[f];
          return (
            <label
              key={f}
              data-feature={f}
              data-differs={differs(f) ? "1" : undefined}
              className={`flex cursor-pointer items-center gap-2.5 bg-surface px-3 py-2.5 transition-colors ${
                value[f] ? "" : "text-ink-400"
              }`}
            >
              <Icon
                className={`h-4 w-4 shrink-0 ${value[f] ? "text-brand-700" : "text-ink-300"}`}
                strokeWidth={1.75}
              />
              <span className="flex-1 text-[0.8125rem] font-medium">
                {t.caps[f]}
                {differs(f) && (
                  <Badge status="pending" className="ms-1.5">
                    {t.plans.differs}
                  </Badge>
                )}
              </span>
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
      <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-400">{t.admin.featuresHint}</p>

      {/* One field, so the whole map survives a plain form POST — see
          featureListSchema in the admin actions. */}
      <input type="hidden" name="features" value={FEATURES.filter((f) => value[f]).join(",")} />
    </div>
  );
}
