"use client";

/*
  Doing work again — beside the emergency, because it starts the same way: a
  patient comes back and says something is wrong with what was done.

  The doctor picks which work it is (on a tooth there may be a filling, a
  root canal and the crown over it), says what is wrong, and starts the redo:
  a new treatment of the same kind — a root canal's is a retreatment — with
  its own steps and price, pointing back at the one it redoes. A redo of a
  bridge is the bridge again, on the same teeth. Work with no steps (a
  filling) can be recorded as redone today in the same tap.
*/

import { useState } from "react";
import { Repeat } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/dates";
import { BUILT_IN_BY_KEY, findTreatment, type Treatment } from "@/lib/charts/dental/catalog";
import { paintAt, type Mark } from "@/lib/charts/dental/state";
import { protocolFor } from "@/lib/charts/dental/protocols";
import { attemptOf, redoKey } from "@/lib/charts/dental/redo";
import { isToothSite } from "@/lib/charts/dental/state";
import { tooth as toothOf } from "@/lib/charts/dental/teeth";
import { TreatmentGlyph } from "./treatment-picker";
import { markLabel } from "./labels";

export function RedoSheet({
  candidates,
  marks,
  custom,
  initial,
  tz,
  onRedo,
  onCancel,
}: {
  /** The work on the tooth that can be done again, newest first. */
  candidates: Mark[];
  marks: Mark[];
  custom: Treatment[];
  /** Opened from one treatment's card: that one, chosen already. */
  initial: string | null;
  tz: string;
  onRedo: (r: { original: Mark; as: Treatment; why: string; now: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const P = T.treatment;
  const [pick, setPick] = useState<string | null>(initial ?? candidates[0]?.id ?? null);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const original = candidates.find((m) => m.id === pick) ?? null;
  const as = original ? (findTreatment(redoKey(original.treatmentKey), custom) ?? null) : null;
  const withSteps = !!as && !!protocolFor(as.key);
  const go = async (now: boolean) => {
    if (!original || !as) return;
    setBusy(true);
    await onRedo({ original, as, why: why.trim(), now });
    setBusy(false);
  };

  if (!candidates.length) {
    return (
      <div className="grid gap-4" data-redo-sheet>
        <p className="rounded-ctl border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-ink-500" data-redo-nothing>
          {P.redoNothing}
        </p>
        <div className="flex justify-end">
          <Button variant="outline" onClick={onCancel}>
            {T.cancel}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4" data-redo-sheet>
      <div className="flex items-start gap-3 rounded-card bg-brand-50 px-3 py-2.5">
        <Repeat className="mt-0.5 h-5 w-5 shrink-0 text-brand-700" />
        <p className="text-[13px] text-ink-900">{P.redoIntro}</p>
      </div>

      <div>
        <div className="mb-1.5 text-[12px] font-semibold text-ink-500">{P.redoWhich}</div>
        <div className="grid gap-1.5" role="radiogroup" aria-label={P.redoWhich}>
          {candidates.map((m) => {
            const on = m.id === pick;
            const tr = findTreatment(m.treatmentKey, custom) ?? BUILT_IN_BY_KEY.get(m.treatmentKey);
            const n = attemptOf(m, marks);
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPick(m.id)}
                className={`flex items-center gap-3 rounded-ctl border p-2 text-start transition-colors duration-140 ${
                  on ? "border-brand-600 bg-brand-50" : "border-line bg-surface hover:bg-sunken"
                }`}
                data-redo-option={m.id}
              >
                {tr && <TreatmentGlyph tr={tr} paint={paintAt(m, null) ?? "existing"} context={isToothSite(m.site) ? toothOf(m.site) : null} size={38} />}
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold text-ink-900">
                    {isToothSite(m.site) ? `${m.site} · ` : ""}
                    {markLabel(m, locale)}
                  </span>
                  <span className="block text-[12px] text-ink-500">
                    {[T.status[m.status], fmtDate(m.doneAt ?? m.createdAt, tz, locale), m.performedBy?.name, n > 1 ? P.redoTimes.replace("{n}", String(n - 1)) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {original && as && as.key !== original.treatmentKey && (
          <p className="mt-1.5 text-[12px] text-ink-500" data-redo-as={as.key}>
            {P.redoAs.replace("{name}", locale === "ar" ? as.ar : as.en)}
          </p>
        )}
      </div>

      <label className="block">
        <span className="mb-1 block text-[12px] font-semibold text-ink-500">{P.redoWhy}</span>
        <input
          dir="auto"
          value={why}
          onChange={(e) => setWhy(e.target.value.slice(0, 300))}
          placeholder={P.redoWhyPlaceholder}
          className="h-10 w-full rounded-ctl border border-line bg-surface px-3 text-base md:text-sm"
          data-redo-why
        />
      </label>

      <div className="flex flex-wrap justify-end gap-2 max-sm:flex-col-reverse max-sm:items-stretch">
        <Button variant="outline" onClick={onCancel}>
          {T.cancel}
        </Button>
        {!withSteps && (
          <Button variant="outline" loading={busy} disabled={!as} onClick={() => void go(true)} data-redo-now>
            {P.redoNow}
          </Button>
        )}
        <Button loading={busy} disabled={!as} onClick={() => void go(false)} data-redo-start>
          <Repeat className="h-4 w-4" />
          {P.redoPlan}
        </Button>
      </div>
    </div>
  );
}
