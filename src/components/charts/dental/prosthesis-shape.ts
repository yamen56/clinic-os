/*
  The shapes a prosthesis is made of, in the chart's own units (a 44-wide
  column, 104 tall, drawn as an upper tooth). Shared by the drawing
  (prosthesis-art.tsx) and by the script that renders its pictures
  (scripts/render-prosthesis-art.tsx), so an edge drawn round a piece follows
  the picture of it exactly. Plain numbers and paths: no React, no theme.
*/

export const COL = 44;
const C = COL / 2;
const NECK = 62; // GEOM.Y0

/** How far each bridge tooth's picture reaches past its column, so neighbours meet without a hairline. */
export const UNIT_PAD = 1;
/** The rows of the column a bridge tooth's picture covers. */
export const UNIT_TOP = 58;
export const UNIT_BOTTOM = 102;

/** The pink base: where its tissue edge is, how far its papillae reach between the teeth, and its margin over each. */
export const BASE_TOP = NECK - 10;
export const BASE_PAP = NECK + 12.5;
export const BASE_ZEN = NECK + 1.5;
/** The rows of the column the base's picture covers. */
export const BASE_BOX = { top: 40, bottom: 80 };

/**
 * One column of the pink base. A side is `join` where the next tooth is part
 * of the same piece, and `end` where the piece stops: rounded off, behind the
 * last tooth.
 */
export function basePath(left: "join" | "end", right: "join" | "end"): string {
  const top = BASE_TOP;
  // Along the tissue edge, left to right.
  let d =
    left === "join"
      ? `M 0 ${top + 0.6} Q ${C * 0.5} ${top - 0.9} ${C} ${top - 0.6}`
      : `M ${C - 6} ${top - 0.3} Q ${C - 3} ${top - 0.6} ${C} ${top - 0.6}`;
  d +=
    right === "join"
      ? ` Q ${C * 1.5} ${top - 0.9} ${COL} ${top + 0.6} L ${COL} ${BASE_PAP}`
      : ` Q ${C + 3} ${top - 0.6} ${C + 6} ${top - 0.3} C ${COL - 4} ${top + 0.6} ${COL - 0.6} ${top + 6} ${COL - 0.6} ${NECK - 4} C ${COL - 0.6} ${NECK + 2.6} ${COL - 1.6} ${NECK + 6.4} ${COL - 4.6} ${NECK + 6.4}`;
  // And back along the margin over the teeth, right to left.
  d +=
    right === "join"
      ? ` C ${COL - 2.4} ${BASE_PAP} ${COL - 4.4} ${BASE_PAP - 2} ${COL - 6} ${BASE_PAP - 5} C ${COL - 8.6} ${NECK + 3.6} ${C + 8} ${BASE_ZEN} ${C} ${BASE_ZEN}`
      : ` C ${COL - 7.8} ${NECK + 6.4} ${COL - 9} ${NECK + 3.4} ${COL - 12.4} ${NECK + 2.4} C ${COL - 15} ${BASE_ZEN + 0.2} ${C + 4} ${BASE_ZEN} ${C} ${BASE_ZEN}`;
  d +=
    left === "join"
      ? ` C ${C - 8} ${BASE_ZEN} 8.6 ${NECK + 3.6} 6 ${BASE_PAP - 5} C 4.4 ${BASE_PAP - 2} 2.4 ${BASE_PAP} 0 ${BASE_PAP} Z`
      : ` C ${C - 4} ${BASE_ZEN} 15 ${BASE_ZEN + 0.2} 12.4 ${NECK + 2.4} C 9 ${NECK + 3.4} 7.8 ${NECK + 6.4} 4.6 ${NECK + 6.4} C 1.6 ${NECK + 6.4} 0.6 ${NECK + 2.6} 0.6 ${NECK - 4} C 0.6 ${top + 6} 4 ${top + 0.6} ${C - 6} ${top - 0.3} Z`;
  return d;
}

/* ── Implants ────────────────────────────────────────────────────────────── */

/**
 * A millimetre in chart units: a central incisor's crown is about 10.5 mm, and
 * 38 units on the chart. An implant is drawn to this scale, so a 13 mm one is
 * longer than a 10 mm one and a 3.5 mm one slimmer than a 5 mm one.
 */
export const MM = 38 / 10.5;
/** The implant as rendered: 11.5 mm long and 4.1 mm wide, its platform at 0 and its tip up. */
export const IMPLANT_LEN = 11.5 * MM;
export const IMPLANT_DIA = 4.1 * MM;
/** The picture's box round the platform's middle: x either side, `up` toward the tip, `down` toward the tooth. */
export const IMPLANT_BOX = { x: 11, up: 45, down: 2 };
/** The abutments' box, round the same point; they stand down from the platform, toward the tooth. */
export const ABUT_BOX = { x: 11, up: 1.5, down: 14.5 };
/** The platform's level: a hair above the neck, under the gum's edge. */
export const PLATFORM = NECK - 2;

/* ── The healed ridge, where a tooth is gone ─────────────────────────────── */

const PAP = NECK + 11; // GEOM.PAP
export const RIDGE = NECK + 4;

/**
 * Gum over healed bone, from `top` down to its edge: level where the next
 * tooth is gone too, rising to the papilla where it stands.
 */
export function ridgePath(leftGone: boolean, rightGone: boolean, top: number): string {
  const right = rightGone
    ? `L ${COL} ${RIDGE} L ${C + 8} ${RIDGE}`
    : `L ${COL} ${PAP} C ${COL - 3} ${PAP} ${COL - 5} ${PAP - 2.4} ${COL - 7.5} ${PAP - 4.4} C ${COL - 10} ${RIDGE + 1} ${COL - 12} ${RIDGE} ${C + 4} ${RIDGE}`;
  const left = leftGone
    ? `L 0 ${RIDGE} Z`
    : `L ${C - 4} ${RIDGE} C 12 ${RIDGE} 10 ${RIDGE + 1} 7.5 ${PAP - 4.4} C 5 ${PAP - 2.4} 3 ${PAP} 0 ${PAP} Z`;
  return `M 0 ${top} L ${COL} ${top} ${right} ${left}`;
}
