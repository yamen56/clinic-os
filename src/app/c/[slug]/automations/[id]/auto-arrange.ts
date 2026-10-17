import { graphlib, layout } from "@dagrejs/dagre";

/**
 * Lays a flow out top to bottom: the trigger first, each step under whatever
 * leads to it, branches side by side.
 *
 * Used for "Tidy up", and on first opening a flow that has never been drawn —
 * every flow made before the canvas existed, and every template.
 *
 * Not called layout.ts: a file of that name anywhere under app/ is a route.
 */

export const NODE_W = 272;
export const NODE_H = 104;
export const TRIGGER_W = 300;
export const TRIGGER_H = 88;

export type XY = { x: number; y: number };

export function arrange(
  nodes: { id: string; width?: number; height?: number }[],
  edges: { from: string | null; to: string }[]
): Record<string, XY> {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 56, ranksep: 72, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  const size = new Map<string, { w: number; h: number }>();
  for (const n of nodes) {
    const w = n.width ?? (n.id === "trigger" ? TRIGGER_W : NODE_W);
    const h = n.height ?? (n.id === "trigger" ? TRIGGER_H : NODE_H);
    size.set(n.id, { w, h });
    g.setNode(n.id, { width: w, height: h });
  }
  for (const e of edges) {
    const from = e.from ?? "trigger";
    if (size.has(from) && size.has(e.to)) g.setEdge(from, e.to);
  }
  layout(g);
  const out: Record<string, XY> = {};
  for (const n of nodes) {
    const p = g.node(n.id);
    const s = size.get(n.id)!;
    if (p) out[n.id] = { x: Math.round(p.x - s.w / 2), y: Math.round(p.y - s.h / 2) };
  }
  return out;
}

/**
 * A step with many ways out is drawn wider, so each answer's label has room
 * under its own dot instead of four labels fighting over 272px.
 */
export function stepWidth(outputs: number): number {
  return outputs > 2 ? Math.max(NODE_W, outputs * 104) : NODE_W;
}
