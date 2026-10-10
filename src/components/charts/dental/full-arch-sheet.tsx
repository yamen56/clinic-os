"use client";

/*
  Recording a whole arch: All-on-4, All-on-6, an overdenture on two implants,
  or a complete denture.

  Three questions, each answered before the next is asked: which arch, how many
  implants (pre-placed where they usually go, moved by tapping a tooth), and —
  when it is still to be done — whether the teeth standing in that arch come
  out first. The prosthesis's teeth follow from the answers and are shown, not
  asked: a fixed bridge runs first molar to first molar, a denture to the
  second molars.
*/

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import type { Treatment } from "@/lib/charts/dental/catalog";
import type { Arch } from "@/lib/charts/dental/teeth";
import type { Mark, Status, ToothState } from "@/lib/charts/dental/state";
import {
  IMPLANT_COUNTS,
  archTeeth,
  defaultImplantSites,
  inChartOrder,
  onImplants,
  prosthesisSites,
  standingTeeth,
} from "@/lib/charts/dental/full-arch";
import { INK, PaintSwatch, SOFT } from "./tooth-art";
import { TreatmentGlyph } from "./treatment-picker";

const STATUSES: Status[] = ["planned", "done", "existing"];

export function FullArchSheet({
  tr,
  initialArch,
  states,
  marks,
  status,
  onStatus,
  onRecord,
  onCancel,
}: {
  tr: Treatment;
  initialArch: Arch | null;
  states: Map<string, ToothState>;
  marks: Mark[];
  status: Status;
  onStatus: (s: Status) => void;
  onRecord: (arch: Arch, implants: string[], extract: string[]) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const T = t.dental;
  const F = T.fullArch;
  const implanted = onImplants(tr.key);
  const [arch, setArch] = useState<Arch | null>(initialArch);
  const [implants, setImplants] = useState<string[]>(() => (initialArch && implanted ? defaultImplantSites(initialArch, 4) : []));
  const [extract, setExtract] = useState(true);

  // A new arch starts again from the usual four.
  useEffect(() => {
    if (arch && implanted) setImplants(defaultImplantSites(arch, 4));
  }, [arch, implanted]);

  const row = arch ? archTeeth(arch) : [];
  const bridge = arch ? prosthesisSites(tr.key, arch, implants.length) : [];
  const standing = useMemo(() => (arch ? standingTeeth(arch, states, marks) : []), [arch, states, marks]);
  const planned = status === "planned";
  const ready = !!arch && (!implanted || implants.length > 0);

  const toggle = (f: string) => setImplants((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));
  const count = implants.length;

  return (
    <div className="grid gap-4" data-full-arch={tr.key}>
      <div className="flex items-center gap-3">
        <TreatmentGlyph tr={tr} paint={status} context={null} size={48} />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-ink-900">{tr.en}</div>
          <div className="text-[13px] text-ink-500">{implanted ? F.hintImplants : F.hintDenture}</div>
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[12px] font-semibold text-ink-500">{F.arch}</div>
        <div className="grid grid-cols-2 gap-2" dir="ltr">
          {(["upper", "lower"] as Arch[]).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setArch(a)}
              aria-pressed={arch === a}
              data-arch={a}
              className={`h-11 rounded-ctl border text-[14px] font-semibold transition-colors duration-140 ${
                arch === a ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-surface text-ink-700 hover:bg-sunken"
              }`}
            >
              {T.sites[a]}
            </button>
          ))}
        </div>
      </div>

      {arch && implanted && (
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-ink-500">{F.implants}</span>
            <div className="inline-flex rounded-ctl bg-sunken p-0.5" role="radiogroup">
              {IMPLANT_COUNTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={count === n}
                  onClick={() => setImplants(defaultImplantSites(arch, n))}
                  className={`h-8 min-w-10 rounded-[6px] px-2.5 text-[13px] font-semibold ${count === n ? "bg-surface text-ink-900 shadow-card" : "text-ink-500"}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          {/* The arch as the chart draws it, the patient's right first. */}
          <div className="grid grid-cols-8 gap-1 sm:grid-cols-16" dir="ltr">
            {row.map((f) => {
              const on = implants.includes(f);
              const inBridge = bridge.includes(f);
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => toggle(f)}
                  aria-pressed={on}
                  data-implant-site={f}
                  title={on ? F.implantHere : F.noImplantHere}
                  className={`grid h-11 place-items-center rounded-ctl border text-[13px] font-bold tnum transition-colors duration-140 ${
                    on ? "border-transparent text-white" : inBridge ? "border-line bg-surface text-ink-700 hover:bg-sunken" : "border-dashed border-line bg-canvas text-ink-400"
                  }`}
                  style={on ? { background: INK[planned ? "planned" : status] } : undefined}
                >
                  {f}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[12px] text-ink-500">
            {T.implantsAt.replace("{n}", String(count)).replace("{list}", inChartOrder(implants).join(" · ") || "—")} · {F.tapToMove}
          </p>
        </div>
      )}

      {arch && (
        <p className="rounded-ctl bg-canvas px-3 py-2 text-[13px] text-ink-700" data-bridge-teeth={bridge.join(",")}>
          {(implanted && count >= 4 ? F.bridgeTeeth : F.dentureTeeth).replace("{from}", bridge[0] ?? "").replace("{to}", bridge[bridge.length - 1] ?? "")}
        </p>
      )}

      {arch && planned && standing.length > 0 && (
        <label className="flex items-start gap-3 rounded-ctl border border-line px-3 py-2.5">
          <input type="checkbox" checked={extract} onChange={(e) => setExtract(e.target.checked)} className="mt-0.5 h-4.5 w-4.5 accent-brand-600" data-extract-standing />
          <span className="text-[13px] text-ink-900">
            {F.extract.replace("{n}", String(standing.length))}
            <span className="mt-0.5 block text-[12px] text-ink-500 tnum" dir="ltr">{standing.join(" · ")}</span>
          </span>
        </label>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex shrink-0 rounded-ctl bg-sunken p-0.5" role="radiogroup">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={status === s}
              title={T.statusHint[s]}
              onClick={() => onStatus(s)}
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] font-semibold"
              style={status === s ? { background: SOFT[s], color: INK[s], boxShadow: "var(--shadow-card)" } : { color: "var(--color-ink-500)" }}
            >
              <PaintSwatch paint={s} size={14} />
              {T.status[s]}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel}>
            {T.cancel}
          </Button>
          <Button
            disabled={!ready}
            onClick={() => arch && onRecord(arch, implanted ? implants : [], planned && extract ? standing : [])}
            data-record-full-arch
          >
            {F.record}
          </Button>
        </div>
      </div>
    </div>
  );
}
