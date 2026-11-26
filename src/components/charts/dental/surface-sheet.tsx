"use client";

/*
  Which surfaces? — asked when a filling is picked without them (2026-11-26).

  A filling needs its surfaces, and the chart used to say so with a red toast:
  "choose the surfaces on the tooth first", sending the doctor back up the
  screen to a small drawing. Now picking the filling asks, on a tooth drawn
  large enough for a thumb, with every surface named, and records it from
  there. Surfaces chosen first still record at once, as before.
*/

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { surfaceLabel, tooth as toothOf, type Surface } from "@/lib/charts/dental/teeth";
import type { Treatment } from "@/lib/charts/dental/catalog";
import type { Status, ToothState } from "@/lib/charts/dental/state";
import { ToothTop } from "./tooth-art";
import { SurfaceChips } from "./tooth-panel";

export function SurfaceSheet({
  tr,
  fdi,
  st,
  status,
  onRecord,
  onCancel,
}: {
  tr: Treatment;
  fdi: string;
  st: ToothState;
  status: Status;
  onRecord: (surfaces: Surface[]) => void;
  onCancel: () => void;
}) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const R = T.record;
  const [chosen, setChosen] = useState<Surface[]>([]);
  const toggle = (s: Surface) => setChosen((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  const tt = toothOf(fdi);
  const name = locale === "ar" ? tr.ar : tr.en;
  const as = tr.kind === "finding" ? "finding" : status;
  return (
    <div className="grid gap-4" data-surface-sheet={fdi}>
      <p className="text-[0.875rem] text-ink-700">{R.surfacesAsk.replace("{name}", name).replace("{n}", fdi)}</p>
      <div className="flex justify-center" dir="ltr">
        <svg viewBox="-8 -8 60 60" className="h-44 w-44 rounded-2xl bg-canvas" role="group" aria-label={R.surfacesTap}>
          <ToothTop t={tt} st={st} uid="surface-sheet" picked={chosen} onSurface={toggle} />
        </svg>
      </div>
      <SurfaceChips fdi={fdi} picked={chosen} onToggle={toggle} />
      <p className="text-center text-[0.8125rem] font-semibold text-ink-900 tnum" data-surface-summary={chosen.join("")}>
        {chosen.length ? `${name} · ${fdi} ${chosen.map((s) => surfaceLabel(tt, s, locale).short).join("")}` : <span className="font-normal text-ink-500">{R.surfacesTap}</span>}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          {T.cancel}
        </Button>
        <Button disabled={!chosen.length} onClick={() => onRecord(chosen)} data-record-surfaces>
          {R.button[as]}
        </Button>
      </div>
    </div>
  );
}
