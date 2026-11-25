"use client";

/*
  Setting up a bridge — on teeth or on implants.

  The chart proposes the span (bridge.ts): the gap and what stands either side
  of it. The doctor sees the bridge as it will be, on the teeth it will be on,
  and corrects it: a tooth more or less, a support that should be replaced, a
  cantilever — an end tooth set to replaced. What it is made of is chosen here
  and can be changed at the preparation, as before. Whether it is a bridge on
  teeth or on implants follows from what carries it.
*/

import { useId, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { BUILT_IN_BY_KEY } from "@/lib/charts/dental/catalog";
import { bridgeKey, bridgeProblem, hasImplant, roleAt, suggestSpan, type BridgeTooth } from "@/lib/charts/dental/bridge";
import { archTeeth } from "@/lib/charts/dental/full-arch";
import { colOf } from "@/lib/charts/dental/implant-place";
import { tooth } from "@/lib/charts/dental/teeth";
import { stateOf, type Status, type ToothState } from "@/lib/charts/dental/state";
import { CW, INK, OCC, PaintSwatch, SIDE_H, SOFT, ToothSide, ToothTop } from "./tooth-art";
import { PieceSide, PieceTop } from "./prosthesis-art";

const STATUSES: Status[] = ["planned", "done", "existing"];
const NUM = 18;
/** A stand-in for the new bridge on the teeth it covers; drawn by the bridge itself. */
const NEW = "__new-bridge";
const ONLY_NEW = new Set([NEW]);

export function BridgeSheet({
  seed,
  states,
  status,
  onStatus,
  onRecord,
  onCancel,
}: {
  /** The teeth in hand when the bridge was picked. */
  seed: string[];
  states: Map<string, ToothState>;
  status: Status;
  onStatus: (s: Status) => void;
  onRecord: (key: "bridge" | "implant_bridge", teeth: BridgeTooth[], material: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const T = t.dental;
  const B = T.bridge;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [teeth, setTeeth] = useState<BridgeTooth[]>(() => suggestSpan(seed, states));
  const materials = BUILT_IN_BY_KEY.get("bridge")!.details![0].options;
  const [material, setMaterial] = useState(materials[0].key);
  const arch = teeth.length ? tooth(teeth[0].site).arch : seed.length ? tooth(seed[0]).arch : "upper";
  const row = archTeeth(arch);
  const cols = teeth.map((x) => colOf(x.site));
  const from = Math.min(...cols);
  const to = Math.max(...cols);
  const problem = bridgeProblem(teeth);
  const key = bridgeKey(teeth, states);
  const supports = teeth.filter((x) => x.role === "abutment").length;

  /** A tooth outside joins, with every tooth between; an end tooth leaves; one in the middle changes its part. */
  const tap = (site: string) => {
    const c = colOf(site);
    setTeeth((prev) => {
      const at = prev.findIndex((x) => x.site === site);
      if (at < 0) {
        if (!prev.length) return [{ site, role: roleAt(site, states) }];
        const a = Math.min(c, ...prev.map((x) => colOf(x.site)));
        const b = Math.max(c, ...prev.map((x) => colOf(x.site)));
        return row.slice(a, b + 1).map((s) => prev.find((x) => x.site === s) ?? { site: s, role: roleAt(s, states) });
      }
      if (prev.length > 1 && (at === 0 || at === prev.length - 1)) return prev.filter((x) => x.site !== site);
      return prev.map((x) => (x.site === site ? { ...x, role: x.role === "abutment" ? "pontic" : "abutment" } : x));
    });
  };
  const turn = (site: string) => setTeeth((prev) => prev.map((x) => (x.site === site ? { ...x, role: x.role === "abutment" ? "pontic" : "abutment" } : x)));

  // The picture: the bridge and a neighbour either side of it.
  const view = useMemo(() => {
    const a = Math.max(0, from - 1);
    const b = Math.min(15, to + 1);
    return { a, b, x: a * CW - 4, w: (b - a + 1) * CW + 8 };
  }, [from, to]);
  const flip = arch === "lower" ? `matrix(1 0 0 -1 0 ${SIDE_H})` : undefined;
  const sideY = arch === "upper" ? 0 : OCC + NUM;
  const topY = arch === "upper" ? SIDE_H + NUM : 0;
  const numY = arch === "upper" ? SIDE_H : OCC;
  const units = teeth.map((x) => ({ t: tooth(x.site), x: colOf(x.site) * CW }));
  // The result, not the plan: solid, whatever is being recorded.
  const paint = "existing" as const;

  return (
    <div className="grid gap-4" data-bridge-sheet={key}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-full bg-sunken px-2.5 py-1 text-[0.78125rem] font-semibold text-ink-700">{key === "implant_bridge" ? B.onImplants : B.onTeeth}</span>
        <p className="text-[0.8125rem] text-ink-500 tnum" data-bridge-summary={`${teeth.length}/${supports}`}>
          {(supports === 1 ? B.summaryOne : B.summary).replace("{n}", String(teeth.length)).replace("{s}", String(supports))}
        </p>
      </div>

      {/* The bridge, on its teeth. */}
      <div className="rounded-card bg-canvas p-2" dir="ltr">
        <svg viewBox={`${view.x} -4 ${view.w} ${SIDE_H + NUM + OCC + 8}`} className="mx-auto block h-auto max-h-72 w-full" role="img" aria-label={teeth.map((x) => x.site).join(", ")}>
          {row.slice(view.a, view.b + 1).map((site) => {
            const x = colOf(site) * CW;
            const own = stateOf(states, site);
            const mine = teeth.length > 1 ? teeth.find((y) => y.site === site) : undefined;
            // Under the bridge as it will be: cut down, or shaped to it.
            const st: ToothState = mine ? { ...own, layers: [...own.layers, { markId: NEW, look: "crown", paint: "existing", surfaces: [], detail: {}, role: mine.role, groupId: NEW }] } : own;
            const c = colOf(site);
            const gone = (n: number) => (row[n] ? stateOf(states, row[n]).gone : true);
            return (
              <g key={site}>
                <g transform={`translate(${x} ${sideY})`}>
                  <ToothSide t={tooth(site)} st={st} uid={`${uid}-b`} drawn={ONLY_NEW} gone={st.gone ? { left: gone(c - 1), right: gone(c + 1) } : undefined} />
                </g>
                <g transform={`translate(${x} ${topY})`}>
                  <ToothTop t={tooth(site)} st={st} uid={`${uid}-b`} drawn={ONLY_NEW} />
                </g>
              </g>
            );
          })}
          {teeth.length > 1 && (
            <>
              <g transform={`translate(0 ${sideY})`}>
                <g transform={flip}>
                  <PieceSide units={units} arch={arch} base={false} material={material} paint={paint} uid={`${uid}-p`} still />
                </g>
              </g>
              <g transform={`translate(0 ${topY})`}>
                <PieceTop units={units} base={false} material={material} paint={paint} still />
              </g>
            </>
          )}
          {row.slice(view.a, view.b + 1).map((site) => {
            const x = colOf(site) * CW;
            const mine = teeth.find((y) => y.site === site);
            return (
              <g key={`n${site}`}>
                <text x={x + CW / 2} y={numY + 13} textAnchor="middle" fontSize={11} fontWeight={mine ? 700 : 600} className={`tnum ${mine ? "fill-ink-900" : "fill-ink-400"}`} style={{ fontFamily: "var(--font-sans)" }}>
                  {site}
                </text>
                {mine && (
                  <rect x={x} y={-4} width={CW} height={SIDE_H + NUM + OCC + 8} fill="transparent" className="cursor-pointer" onClick={() => turn(site)} data-bridge-unit={site} />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Which teeth. */}
      <div>
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[0.75rem] font-semibold text-ink-500">{B.teeth}</span>
          <span className="text-[0.75rem] text-ink-500">{B.hint}</span>
        </div>
        <div className="grid grid-cols-8 gap-1 sm:grid-cols-16" dir="ltr">
          {row.map((f) => {
            const on = teeth.some((x) => x.site === f);
            return (
              <button
                key={f}
                type="button"
                onClick={() => tap(f)}
                aria-pressed={on}
                data-bridge-tooth={f}
                className={`grid h-11 place-items-center rounded-ctl border text-[0.8125rem] font-bold tnum transition-colors duration-140 ${
                  on ? "border-brand-600 bg-brand-600 text-on-brand" : stateOf(states, f).gone ? "border-dashed border-line-strong bg-canvas text-ink-400" : "border-line bg-surface text-ink-700 hover:bg-sunken"
                }`}
              >
                {f}
              </button>
            );
          })}
        </div>
      </div>

      {/* And which of them carry it. */}
      <div>
        <div className="mb-1.5 text-[0.75rem] font-semibold text-ink-500">{B.roles}</div>
        <div className="flex flex-wrap gap-1.5" dir="ltr">
          {teeth.map((x) => {
            const support = x.role === "abutment";
            return (
              <button
                key={x.site}
                type="button"
                onClick={() => turn(x.site)}
                data-bridge-role={`${x.site}:${x.role}`}
                className={`inline-flex h-10 items-center gap-1.5 rounded-ctl border px-2.5 text-[0.8125rem] font-semibold transition-colors duration-140 ${
                  support ? "border-line-strong bg-surface text-ink-900" : "border-dashed border-line-strong bg-canvas text-ink-500"
                }`}
              >
                <span className="font-bold tnum">{x.site}</span>
                {support ? (hasImplant(stateOf(states, x.site)) ? B.supportImplant : B.support) : B.replaced}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[0.75rem] font-semibold text-ink-500">{B.material}</div>
        <div className="flex flex-wrap gap-1.5">
          {materials.map((o) => (
            <button
              key={o.key}
              type="button"
              aria-pressed={material === o.key}
              onClick={() => setMaterial(o.key)}
              data-bridge-material={o.key}
              className={`h-10 rounded-full border px-3 text-[0.8125rem] font-semibold transition-colors duration-140 ${
                material === o.key ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line bg-surface text-ink-700 hover:bg-sunken"
              }`}
            >
              {o.en}
            </button>
          ))}
        </div>
      </div>

      {problem && (
        <p className="rounded-ctl bg-sunken px-3 py-2 text-[0.8125rem] text-ink-700" role="status">
          {problem === "few" ? B.tooFew : B.noSupport}
        </p>
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
              className="inline-flex h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-[0.8125rem] font-semibold"
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
          <Button disabled={!!problem} onClick={() => onRecord(key, teeth, material)} data-record-bridge>
            {B.record}
          </Button>
        </div>
      </div>
    </div>
  );
}
