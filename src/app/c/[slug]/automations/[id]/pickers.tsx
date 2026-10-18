"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Modal } from "@/components/ui/modal";
import {
  STEPS,
  STEP_CATEGORIES,
  TRIGGERS,
  TRIGGER_CATEGORIES,
  TRIGGER_PRESETS,
  type Ctx,
  type StepKey,
  type TriggerKey,
} from "@/lib/automation/catalog";
import type { FeatureMap } from "@/lib/features";
import { CATEGORY_TONE, PRESET_ICONS, STEP_ICONS, TRIGGER_ICONS } from "../flow-meta";

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative mb-4">
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 w-full rounded-ctl border border-line bg-surface ps-9 pe-3 text-base outline-none focus:border-brand-600 md:text-sm"
      />
    </div>
  );
}

function Card({
  icon: Icon,
  tone,
  title,
  hint,
  disabledReason,
  onClick,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  title: string;
  hint: string;
  disabledReason?: string | null;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      disabled={Boolean(disabledReason)}
      onClick={onClick}
      data-pick={testId}
      className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 text-start transition-colors hover:border-brand-400 hover:bg-brand-50/50 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-line disabled:hover:bg-surface"
    >
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${tone}`}>
        <Icon className="h-4.5 w-4.5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-ink-900">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-ink-500">{disabledReason || hint}</span>
      </span>
    </button>
  );
}

const matches = (q: string, ...texts: string[]) => {
  const s = q.trim().toLowerCase();
  return !s || texts.some((x) => x.toLowerCase().includes(s));
};

export function StepPicker({
  open,
  onClose,
  onPick,
  provides,
  modules,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (type: StepKey) => void;
  provides: Ctx[];
  modules: FeatureMap;
}) {
  const { t } = useI18n();
  const f = t.automations.flow;
  const [q, setQ] = useState("");
  const groups = useMemo(
    () =>
      STEP_CATEGORIES.map((cat) => ({
        cat,
        items: STEPS.filter((s) => s.category === cat)
          .filter((s) => !s.module || modules[s.module])
          .filter((s) =>
            matches(q, (t.automations.steps as Record<string, string>)[s.key] ?? "", (f.stepHints as Record<string, string>)[s.key] ?? "")
          ),
      })).filter((g) => g.items.length),
    [q, modules, t, f]
  );

  return (
    <Modal open={open} onClose={onClose} title={f.pickStep} wide>
      <SearchBox value={q} onChange={setQ} placeholder={f.search} />
      {!groups.length && <p className="py-6 text-center text-sm text-ink-500">{f.noMatches}</p>}
      <div className="grid gap-5">
        {groups.map((g) => (
          <section key={g.cat}>
            <h3 className="eyebrow mb-2">{(f.stepCategories as Record<string, string>)[g.cat]}</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {g.items.map((s) => {
                const missing = s.needs.find((n) => !provides.includes(n));
                return (
                  <Card
                    key={s.key}
                    testId={s.key}
                    icon={STEP_ICONS[s.key]}
                    tone={CATEGORY_TONE[s.category].chip}
                    title={(t.automations.steps as Record<string, string>)[s.key]}
                    hint={(f.stepHints as Record<string, string>)[s.key]}
                    disabledReason={missing ? (f.needs as Record<string, string>)[missing] : null}
                    onClick={() => {
                      onPick(s.key);
                      setQ("");
                    }}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}

export function TriggerPicker({
  open,
  onClose,
  onPick,
  modules,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (trigger: TriggerKey, config: Record<string, unknown>) => void;
  modules: FeatureMap;
}) {
  const { t } = useI18n();
  const f = t.automations.flow;
  const [q, setQ] = useState("");
  const triggerName = (k: string) => (t.automations.triggers as Record<string, string>)[k] ?? k;
  const presets = TRIGGER_PRESETS.filter(
    (p) =>
      modules.calendar &&
      matches(q, (f.presets as Record<string, string>)[p.id], (f.presetHints as Record<string, string>)[p.id])
  );
  const groups = TRIGGER_CATEGORIES.map((cat) => ({
    cat,
    items: TRIGGERS.filter((d) => d.category === cat)
      .filter((d) => modules[d.module])
      .filter((d) => matches(q, triggerName(d.key), (f.triggerHints as Record<string, string>)[d.key] ?? "")),
  })).filter((g) => g.items.length);

  const pick = (k: TriggerKey, cfg: Record<string, unknown>) => {
    onPick(k, cfg);
    setQ("");
  };

  return (
    <Modal open={open} onClose={onClose} title={f.pickTrigger} wide>
      <SearchBox value={q} onChange={setQ} placeholder={f.search} />
      {!presets.length && !groups.length && <p className="py-6 text-center text-sm text-ink-500">{f.noMatches}</p>}
      <div className="grid gap-5">
        {presets.length > 0 && (
          <section>
            <h3 className="eyebrow mb-2">{f.shortcuts}</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {presets.map((p) => (
                <Card
                  key={p.id}
                  testId={p.id}
                  icon={PRESET_ICONS[p.id]}
                  tone="bg-brand-50 text-brand-700"
                  title={(f.presets as Record<string, string>)[p.id]}
                  hint={(f.presetHints as Record<string, string>)[p.id]}
                  onClick={() => pick(p.trigger, p.config)}
                />
              ))}
            </div>
          </section>
        )}
        {groups.map((g) => (
          <section key={g.cat}>
            <h3 className="eyebrow mb-2">{(f.triggerCategories as Record<string, string>)[g.cat]}</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {g.items.map((d) => (
                <Card
                  key={d.key}
                  testId={d.key}
                  icon={TRIGGER_ICONS[d.key]}
                  tone="bg-brand-50 text-brand-700"
                  title={triggerName(d.key)}
                  hint={(f.triggerHints as Record<string, string>)[d.key] ?? ""}
                  onClick={() => pick(d.key, {})}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}
