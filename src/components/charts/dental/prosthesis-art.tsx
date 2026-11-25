"use client";

/*
  A prosthesis, drawn as the one thing it is.

  A bridge is crowns fused where they touch; a full arch is a bar of teeth set
  in a pink base and carried by implants that stand where the surgeon found
  bone. Drawn tooth by tooth they never looked like either (Yamen, 2026-11-25:
  "make sure everything looks perfect, not just lines … realistic"). Here a
  whole piece is one drawing, from pictures rendered for it
  (scripts/render-prosthesis-art.tsx): its teeth meet at their contacts, its
  base runs unbroken under them, and one fine edge round the whole piece says
  whether it is planned, under way, done or was there before.

  Everything is in the chart's units, drawn as an upper jaw; whoever places it
  turns it over for a lower one, as they do for a tooth. `x` is the left edge
  of a column.
*/

import { tooth, type Arch, type Tooth } from "@/lib/charts/dental/teeth";
import type { Paint } from "@/lib/charts/dental/state";
import { DEFAULT_DIA, DEFAULT_LEN, type Place } from "@/lib/charts/dental/implant-place";
import type { Stage } from "@/lib/charts/dental/prosthesis";
import { ART_VERSION, C, CW, GUM_PAD, INK, OCC, SIDE_H, Y0, ellipse, gumArt, presence, roundRect, topArt, topHalf, url, TINTS, type Material } from "./art-base";
import { ABUT_BOX, BASE_BOX, BASE_PAP, BASE_TOP, BASE_ZEN, IMPLANT_BOX, IMPLANT_DIA, IMPLANT_LEN, MM, PLATFORM, UNIT_BOTTOM, UNIT_PAD, UNIT_TOP, basePath } from "./prosthesis-shape";
import { UNIT_OUTLINES } from "./prosthesis-units";

const art = (name: string) => `/charts/teeth/${name}.webp?v=${ART_VERSION}`;

type UnitKey = keyof typeof UNIT_OUTLINES;

/** Which photograph a bridge tooth is drawn from. */
export function unitKey(t: Tooth): UnitKey {
  if (t.kind === "incisor") return t.arch === "upper" && t.position === 1 ? "i1" : "i2";
  if (t.kind === "canine") return "c";
  return t.kind === "premolar" ? "p" : "m";
}

/** A prosthesis's material as a tint over its porcelain, or none when it is porcelain. */
function tintFor(material: string | null): Material | null {
  switch (material) {
    case "metal":
      return "metal";
    case "gold":
      return "gold";
    case "temporary":
    case "pmma":
      return "temp";
    case "peek":
      return "peek";
    case "acrylic":
      return "acrylic";
    case "zirconia":
      return "zirconia";
    default:
      return null;
  }
}
const filterFor = (material: string | null) => {
  const m = tintFor(material);
  return m && TINTS[m] ? url(`tint-${m}`) : undefined;
};
/** The chewing surfaces are enamel until tinted: porcelain, unless the piece is metal, gold or a temporary. */
const topFilterFor = (material: string | null) => {
  const m = tintFor(material);
  return url(`tint-${m && m !== "zirconia" && m !== "acrylic" ? m : "porcelain"}`);
};

/** The status' edge round a whole piece: wide enough to show past it, since half of it is under the piece. */
function rim(p: Paint): { style: React.CSSProperties; dash?: string } {
  const loud = p === "planned" || p === "progress";
  return {
    style: { fill: "none", stroke: INK[p], strokeWidth: loud ? 2.4 : 1.4, strokeOpacity: loud ? 1 : 0.85, strokeLinejoin: "round", strokeLinecap: "butt" },
    dash: p === "planned" ? "4 2.6" : p === "progress" ? "5 2" : undefined,
  };
}

/** How solid a piece is drawn, and in what: a plan is a ghost, a temporary is what is in the mouth now. */
export function bodyOf(paint: Paint, stage: Stage | null | undefined, material: string | null): { on: number; material: string | null } {
  if (stage === "temp" && (paint === "planned" || paint === "progress")) return { on: 1, material: "temporary" };
  if (paint === "planned") return { on: presence(paint), material };
  if (paint === "progress") return { on: 0.5, material };
  return { on: 1, material };
}

/* ── From the side ───────────────────────────────────────────────────────── */

export type ArtUnit = { t: Tooth; x: number };

/**
 * A piece from the cheek. `open` leaves its ends un-rounded: a slice of a
 * longer piece, drawn on one tooth.
 */
export function PieceSide({
  units,
  arch,
  base,
  material,
  paint,
  stage,
  seams,
  uid,
  open = false,
  still = false,
}: {
  units: ArtUnit[];
  arch: Arch;
  base: boolean;
  material: string | null;
  paint: Paint;
  stage?: Stage | null;
  /** The sides where the next section of the same arch begins. */
  seams?: { left: boolean; right: boolean };
  uid: string;
  open?: boolean;
  /** Without the pop of something new: while it is being set up it changes with every tap. */
  still?: boolean;
}) {
  if (!units.length) return null;
  const body = bodyOf(paint, stage, material);
  const filter = filterFor(body.material);
  const edge = rim(paint);
  const n = units.length;
  const ends = (i: number): ["join" | "end", "join" | "end"] => [
    open || i > 0 || seams?.left ? "join" : "end",
    open || i < n - 1 || seams?.right ? "join" : "end",
  ];
  const tile = (i: number) => {
    const [l, r] = ends(i);
    return `base-${arch === "upper" ? "u" : "l"}-${l === "end" ? (r === "end" ? "one" : "left") : r === "end" ? "right" : "mid"}`;
  };
  return (
    <g className={still ? undefined : "tooth-pop"}>
      <g opacity={body.on}>
        {/* The edge first, and the piece over it: what is left showing is a line round the whole, never one between two teeth. */}
        <g style={edge.style} strokeDasharray={edge.dash}>
          {units.map((u) => (
            <path key={u.t.fdi} d={UNIT_OUTLINES[unitKey(u.t)]} transform={`translate(${u.x} 0)`} />
          ))}
          {base && units.map((u, i) => <path key={`b${u.t.fdi}`} d={basePath(...ends(i))} transform={`translate(${u.x} 0)`} />)}
        </g>
        {/* A contact's dark hair, where neither picture quite reaches. */}
        {units.slice(0, -1).map((u) => (
          <rect key={`j${u.t.fdi}`} x={u.x + CW - 0.5} y={Y0 + 17} width={1} height={12} style={{ fill: "var(--color-mat-joint)" }} />
        ))}
        {units.map((u) => (
          <image
            key={u.t.fdi}
            href={art(`unit-${unitKey(u.t)}`)}
            x={u.x - UNIT_PAD}
            y={UNIT_TOP}
            width={CW + 2 * UNIT_PAD}
            height={UNIT_BOTTOM - UNIT_TOP}
            filter={filter}
            preserveAspectRatio="none"
          />
        ))}
        {/* Porcelain on metal shows its metal as a fine line at the neck. */}
        {body.material === "pfm" &&
          units.map((u) => (
            <path
              key={`m${u.t.fdi}`}
              d={`M ${u.x + 6} ${Y0 + 9} C ${u.x + 9.4} ${Y0 + 4.6} ${u.x + 14.5} ${Y0 + 2.5} ${u.x + C} ${Y0 + 2.5} C ${u.x + CW - 14.5} ${Y0 + 2.5} ${u.x + CW - 9.4} ${Y0 + 4.6} ${u.x + CW - 6} ${Y0 + 9}`}
              style={{ fill: "none", stroke: "var(--color-mat-titanium)", strokeWidth: 1.7 }}
              strokeLinecap="round"
            />
          ))}
        {base && (
          <>
            {/* The base's shadow on the necks of its teeth. */}
            {units.map((u, i) => {
              const [l, r] = ends(i);
              return (
                <path
                  key={`s${u.t.fdi}`}
                  transform={`translate(${u.x} 0)`}
                  d={margin(l, r)}
                  style={{ fill: "none", stroke: "var(--color-gum-shadow)", strokeWidth: 2.6, strokeOpacity: 0.28 }}
                  strokeLinecap="round"
                />
              );
            })}
            {units.map((u, i) => (
              <image
                key={`i${u.t.fdi}`}
                href={art(tile(i))}
                x={u.x - UNIT_PAD}
                y={BASE_BOX.top}
                width={CW + 2 * UNIT_PAD}
                height={BASE_BOX.bottom - BASE_BOX.top}
                preserveAspectRatio="none"
              />
            ))}
            {/* Split from the next section: a hairline through the base, down to where the two teeth touch. */}
            {seams?.right && (
              <line
                x1={units[n - 1].x + CW}
                y1={BASE_TOP + 1}
                x2={units[n - 1].x + CW}
                y2={BASE_PAP + 4}
                style={{ stroke: "var(--color-gum-shadow)", strokeWidth: 0.9, strokeOpacity: 0.7 }}
              />
            )}
            {/* Acrylic is carried by a titanium bar: its edge shows along the gum. */}
            {body.material === "acrylic" && !open && n > 1 && (
              <path
                d={`M ${units[0].x + 8} ${BASE_TOP + 0.4} L ${units[n - 1].x + CW - 8} ${BASE_TOP + 0.4}`}
                style={{ fill: "none", stroke: url("bar"), strokeWidth: 1.9 }}
                strokeLinecap="round"
              />
            )}
          </>
        )}
      </g>
      {/* A bridge on its own teeth comes out of the gum: the gum's edge again, over its necks. */}
      {!base && (
        <>
          <clipPath id={`${uid}-gum`}>
            {units.map((u) => (
              <rect key={u.t.fdi} x={u.x - GUM_PAD} y={57.5} width={CW + 2 * GUM_PAD} height={SIDE_H - 57.5} />
            ))}
          </clipPath>
          <g clipPath={`url(#${uid}-gum)`}>
            {units.map((u) => (
              <image key={u.t.fdi} href={gumArt(u.t)} x={u.x - GUM_PAD} y={0} width={CW + 2 * GUM_PAD} height={SIDE_H} />
            ))}
          </g>
        </>
      )}
    </g>
  );
}

/** The base's margin over one tooth, the lower edge of basePath. */
function margin(l: "join" | "end", r: "join" | "end"): string {
  const right = r === "join" ? `M ${CW} ${BASE_PAP} C ${CW - 2.4} ${BASE_PAP} ${CW - 4.4} ${BASE_PAP - 2} ${CW - 6} ${BASE_PAP - 5} C ${CW - 8.6} ${Y0 + 3.6} ${C + 8} ${BASE_ZEN} ${C} ${BASE_ZEN}` : `M ${CW - 12} ${Y0 + 2.6} C ${CW - 15} ${BASE_ZEN + 0.2} ${C + 4} ${BASE_ZEN} ${C} ${BASE_ZEN}`;
  const left = l === "join" ? ` C ${C - 8} ${BASE_ZEN} 8.6 ${Y0 + 3.6} 6 ${BASE_PAP - 5} C 4.4 ${BASE_PAP - 2} 2.4 ${BASE_PAP} 0 ${BASE_PAP}` : ` C ${C - 4} ${BASE_ZEN} 15 ${BASE_ZEN + 0.2} 12 ${Y0 + 2.6}`;
  return right + left;
}

/* ── An implant ──────────────────────────────────────────────────────────── */

export type ImplantTop = "heal" | "multi" | "post" | "none";

/** An implant's outline, its platform at the origin and its tip up. */
export function implantOutline(len: number, dia: number): string {
  const L = len * MM;
  const r = (dia * MM) / 2;
  return `M ${-r} 0.8 L ${r} 0.8 L ${r * 1.03} ${-L * 0.3} L ${r * 0.8} ${-L * 0.86} Q ${r * 0.55} ${-L * 1.005} 0 ${-L * 1.005} Q ${-r * 0.55} ${-L * 1.005} ${-r * 0.8} ${-L * 0.86} L ${-r * 1.03} ${-L * 0.3} Z`;
}

/** The level an implant of a full arch stands at: under the base, with the jaw levelled for it. */
export const ARCH_PLATFORM = Y0 - 5;

/**
 * An implant, where it stands: `x` the middle of its platform, leaning by its
 * tilt about it, its abutment upright on it however it leans — the way an
 * angled abutment brings a tilted implant back to the bridge.
 */
export function ImplantArt({
  x,
  place,
  paint,
  top,
  arch = false,
  solid = false,
}: {
  x: number;
  place?: Pick<Place, "tilt" | "depth" | "len" | "dia">;
  paint: Paint;
  top: ImplantTop;
  /** Part of a full arch: it stands at the levelled jaw. */
  arch?: boolean;
  /** Drawn whole whatever its status: while it is being placed. */
  solid?: boolean;
}) {
  const tilt = place?.tilt ?? 0;
  const len = place?.len ?? DEFAULT_LEN;
  const dia = place?.dia ?? DEFAULT_DIA;
  const y = (arch ? ARCH_PLATFORM : PLATFORM) - (place?.depth ?? 0) * MM;
  const on = solid ? 1 : paint === "planned" ? 0.62 : paint === "progress" ? 0.85 : 1;
  const loud = paint === "planned" || paint === "progress";
  const outline = implantOutline(len, dia);
  const sx = dia / DEFAULT_DIA;
  const sy = len / DEFAULT_LEN;
  const abut = top === "none" ? null : art(`abut-${top}`);
  return (
    <g className="tooth-pop">
      <g transform={`translate(${x} ${y})`}>
        <g transform={`rotate(${tilt})`}>
          <path
            d={outline}
            style={{ fill: "none", stroke: INK[paint], strokeWidth: loud ? 2.2 : 1.2, strokeLinejoin: "round", strokeOpacity: loud ? 1 : 0.7 }}
            strokeDasharray={paint === "planned" ? "3.4 2.2" : paint === "progress" ? "5 2" : undefined}
          />
          <image
            href={art("implant")}
            x={-IMPLANT_BOX.x * sx}
            y={-IMPLANT_BOX.up * sy}
            width={IMPLANT_BOX.x * 2 * sx}
            height={(IMPLANT_BOX.up + IMPLANT_BOX.down) * sy}
            preserveAspectRatio="none"
            opacity={on}
          />
          {/* It is in the jaw, not on it: the gum's colour over all but its collar. */}
          <path d={outline} style={{ fill: "var(--color-gum)" }} opacity={0.15 * on} />
        </g>
        {/* Where the abutment turns: a ball joint covers the angle. */}
        {abut && Math.abs(tilt) > 6 && (
          <ellipse cx={0} cy={0.4} rx={((dia * MM) / 2) * 0.96} ry={((dia * MM) / 2) * 0.62} style={{ fill: url("titanium") }} opacity={on} />
        )}
        {abut && <image href={abut} x={-ABUT_BOX.x * sx} y={-ABUT_BOX.up} width={ABUT_BOX.x * 2 * sx} height={ABUT_BOX.up + ABUT_BOX.down} preserveAspectRatio="none" opacity={on} />}
      </g>
    </g>
  );
}

/* ── From above ──────────────────────────────────────────────────────────── */

/** A chewing surface wide enough to meet its neighbours, as a bridge's do. */
function wideOutline(t: Tooth): string {
  const c = OCC / 2;
  const [, ry] = topHalf(t);
  if (t.kind === "molar") return roundRect(c - 22.2, c - ry, 44.4, ry * 2, 12);
  return ellipse(c, c, 22.2, ry);
}

export function PieceTop({
  units,
  base,
  material,
  paint,
  stage,
  holes,
  still = false,
}: {
  units: ArtUnit[];
  base: boolean;
  material: string | null;
  paint: Paint;
  stage?: Stage | null;
  /** Where its screws go in, by x: the access holes, closed. */
  holes?: number[];
  still?: boolean;
}) {
  if (!units.length) return null;
  const body = bodyOf(paint, stage, material);
  const filter = topFilterFor(body.material);
  const edge = rim(paint);
  const c = OCC / 2;
  return (
    <g className={still ? undefined : "tooth-pop"}>
      <g opacity={body.on}>
        <g style={{ ...edge.style, strokeWidth: (edge.style.strokeWidth as number) + (base ? 5.2 : 0) }} strokeDasharray={edge.dash}>
          {units.map((u) => (
            <path key={u.t.fdi} d={wideOutline(u.t)} transform={`translate(${u.x} 0)`} />
          ))}
        </g>
        {/* The pink of the base, seen past the teeth. */}
        {base && (
          <g style={{ fill: "var(--color-gum)", stroke: "var(--color-gum)", strokeWidth: 5, strokeLinejoin: "round" }}>
            {units.map((u) => (
              <path key={u.t.fdi} d={wideOutline(u.t)} transform={`translate(${u.x} 0)`} />
            ))}
          </g>
        )}
        {/* The connectors: porcelain from one tooth into the next. */}
        {units.slice(0, -1).map((u, i) => {
          const h = Math.min(topHalf(u.t)[1], topHalf(units[i + 1].t)[1]) * 0.62;
          const b = u.x + CW;
          return (
            <path
              key={`k${u.t.fdi}`}
              d={`M ${b - 9} ${c - h} Q ${b} ${c - h * 0.5} ${b + 9} ${c - h} L ${b + 9} ${c + h} Q ${b} ${c + h * 0.5} ${b - 9} ${c + h} Z`}
              style={{ fill: url("joint") }}
            />
          );
        })}
        {units.map((u) => {
          const k = 22.3 / topHalf(u.t)[0];
          return (
            <image
              key={u.t.fdi}
              href={topArt(u.t)}
              x={0}
              y={0}
              width={OCC}
              height={OCC}
              filter={filter}
              transform={`translate(${u.x + c} 0) scale(${k.toFixed(4)} 1) translate(${-c} 0)`}
            />
          );
        })}
        {holes?.map((x) => (
          <g key={x} transform={`translate(${x} ${c})`}>
            <circle r={4} style={{ fill: url("plug"), stroke: "var(--color-mat-joint)", strokeWidth: 0.7 }} />
            <circle r={2.1} style={{ fill: "none", stroke: "var(--color-mat-joint)", strokeWidth: 0.35, strokeOpacity: 0.6 }} />
          </g>
        ))}
      </g>
    </g>
  );
}

/** An implant from above, its middle at x: its connection, an abutment, or a healing cap. */
export function ImplantTopArt({ x, paint, top, dia = DEFAULT_DIA }: { x: number; paint: Paint; top: ImplantTop; dia?: number }) {
  const r = (dia * MM) / 2;
  const k = dia / DEFAULT_DIA;
  const loud = paint === "planned" || paint === "progress";
  const name = top === "multi" || top === "post" ? "abut-top" : top === "heal" ? "heal-top" : "implant-top";
  return (
    // The place on the outer group: the pop animates a transform of its own, and would take this one's.
    <g transform={`translate(${x} ${OCC / 2})`}>
      <g className="tooth-pop" opacity={paint === "planned" ? 0.7 : 1}>
        <circle r={r + 0.6} style={{ fill: "none", stroke: INK[paint], strokeWidth: loud ? 1.6 : 1.1 }} strokeDasharray={paint === "planned" ? "3 2" : paint === "progress" ? "4 1.6" : undefined} />
        <image href={art(name)} x={-10 * k} y={-10 * k} width={20 * k} height={20 * k} />
      </g>
    </g>
  );
}

/* ── Small pictures of them, for the list of treatments ──────────────────── */

/** A three-tooth bridge the size of a treatment's picture: on teeth, or on two implants. */
export function BridgeGlyph({ paint, size, implants = false }: { paint: Paint; size: number; implants?: boolean }) {
  const teeth = ["14", "15", "16"].map(tooth).reverse();
  const uid = `bg-${paint}-${implants ? "i" : "t"}`;
  const units = teeth.map((t, i) => ({ t, x: i * CW }));
  return (
    <svg viewBox={`-2 ${implants ? 18 : 30} ${CW * 3 + 4} ${implants ? 86 : 74}`} width={size * 0.94} height={size * (implants ? 0.62 : 0.54)} aria-hidden className="shrink-0 overflow-visible">
      {implants && [0, 2].map((i) => <ImplantArt key={i} x={i * CW + C} paint={paint} top="none" />)}
      <PieceSide units={units} arch="upper" base={false} material={null} paint={paint} uid={uid} />
    </svg>
  );
}

/** A full arch in little: four implants, the back two leaning, and the bridge on them. */
export function ArchGlyph({ paint, size, implants = true }: { paint: Paint; size: number; implants?: boolean }) {
  const units = ["14", "13", "12", "11", "21", "22", "23", "24"].map((f, i) => ({ t: tooth(f), x: i * CW }));
  const at: [number, number][] = [
    [0.4, 30],
    [2.6, 0],
    [4.4, 0],
    [6.6, -30],
  ];
  return (
    <svg viewBox={`-4 -2 ${CW * 8 + 8} 106`} width={size} height={size * 0.31} aria-hidden className="shrink-0 overflow-visible">
      {implants && at.map(([p, tilt]) => <ImplantArt key={p} arch x={p * CW + C} place={{ tilt, depth: 0, len: 13, dia: 5 }} paint={paint} top="none" />)}
      <PieceSide units={units} arch="upper" base material={null} paint={paint} uid={`ag-${paint}`} />
    </svg>
  );
}

export { IMPLANT_DIA, IMPLANT_LEN };
