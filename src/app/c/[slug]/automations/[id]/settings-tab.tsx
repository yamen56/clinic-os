"use client";

import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { NumberInput, Textarea, Toggle } from "@/components/ui/input";
import { EXIT_EVENTS, EXIT_NEEDS, type Ctx, type ExitEvent, type FlowSettings } from "@/lib/automation/catalog";

export function SettingsTab({
  description,
  onDescription,
  settings,
  onSettings,
  provides,
  hasReplyStep,
}: {
  description: string;
  onDescription: (v: string) => void;
  settings: FlowSettings;
  onSettings: (s: FlowSettings) => void;
  provides: Ctx[];
  hasReplyStep: boolean;
}) {
  const { t } = useI18n();
  const f = t.automations.flow;

  const available = (ev: ExitEvent): string | null => {
    if (ev === "patient_replied" && hasReplyStep) return f.exitReplyConflict;
    const need = EXIT_NEEDS[ev];
    const ok = provides.includes(need) || (ev === "patient_replied" && provides.includes("conversation"));
    return ok ? null : f.exitUnavailable;
  };

  return (
    <div className="mx-auto grid max-w-2xl gap-4">
      <Card className="grid gap-2 p-5">
        <div className="text-[13px] font-semibold text-ink-900">{f.description}</div>
        <Textarea
          value={description}
          maxLength={300}
          placeholder={f.descriptionPlaceholder}
          onChange={(e) => onDescription(e.target.value)}
        />
      </Card>

      <Card className="grid gap-3 p-5">
        <div className="text-[13px] font-semibold text-ink-900">{f.reentry}</div>
        <div className="grid gap-2" role="radiogroup">
          {(["always", "once", "cooldown"] as const).map((opt) => (
            <label
              key={opt}
              className={`flex cursor-pointer flex-wrap items-center gap-2.5 rounded-ctl border px-3 py-2.5 text-[13px] ${
                settings.reentry === opt ? "border-brand-600 bg-brand-50" : "border-line hover:border-line-strong"
              }`}
            >
              <input
                type="radio"
                name="reentry"
                checked={settings.reentry === opt}
                onChange={() => onSettings({ ...settings, reentry: opt })}
                className="accent-brand-600"
              />
              <span className="font-medium">{f.reentryOpt[opt]}</span>
              {opt === "cooldown" && (
                <span className="flex items-center gap-2">
                  <NumberInput
                    dir="ltr"
                    min={1}
                    max={3650}
                    value={settings.cooldown_days}
                    fallback={30}
                    className="!h-8 !w-20"
                    onChange={(v) => onSettings({ ...settings, reentry: "cooldown", cooldown_days: Math.round(v) })}
                  />
                  <span>{f.days}</span>
                </span>
              )}
            </label>
          ))}
        </div>
      </Card>

      <Card className="grid gap-3 p-5">
        <div>
          <div className="text-[13px] font-semibold text-ink-900">{f.exitTitle}</div>
          <p className="mt-0.5 text-[12px] text-ink-500">{f.exitSub}</p>
        </div>
        <div className="grid gap-2">
          {EXIT_EVENTS.map((ev) => {
            const reason = available(ev);
            const on = settings.exit_on.includes(ev);
            return (
              <div key={ev} className={`flex items-center gap-3 ${reason && !on ? "opacity-55" : ""}`}>
                <Toggle
                  checked={on}
                  label={f.exit[ev]}
                  onChange={(v) => {
                    if (v && reason) return;
                    onSettings({ ...settings, exit_on: v ? [...settings.exit_on, ev] : settings.exit_on.filter((x) => x !== ev) });
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] text-ink-900">{f.exit[ev]}</span>
                  {reason && <span className="block text-[12px] text-ink-500">{reason}</span>}
                </span>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
