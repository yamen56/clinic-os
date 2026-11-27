import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { defaultSettingsFor, normalizeSettings, type FlowSettings } from "./catalog";
import { treeToGraph, type FlowEdge, type FlowNode, type RecipeStep } from "./graph";
import { loadFlow } from "./store";

/**
 * What a clinic without advanced automations may save (lib/plans, 2026-11-27).
 *
 * Basic is "the gallery's flows, in your words": a flow starts as a template,
 * and from then on its steps' text and timing can change, its trigger's timing
 * can change, and it can be switched on and off — but no step is added,
 * removed or rewired, the trigger is not swapped for another, and the flow's
 * own settings stay as the template set them. The builder hides the controls
 * that would do those things; this is the rule that holds when it does not.
 *
 * Returns null when the save is within those bounds.
 */

/**
 * The flow's shape with its ids taken out: from the trigger, each step's type
 * and, by output, what follows it. Two flows with the same signature are the
 * same flow wired the same way, whatever ids they were given.
 */
function signature(nodes: Pick<FlowNode, "id" | "type">[], edges: FlowEdge[]): string {
  const type = new Map(nodes.map((n) => [n.id, n.type]));
  const out = new Map<string | null, FlowEdge[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const seen = new Map<string, number>();
  const walk = (id: string): string => {
    const at = seen.get(id);
    // A branch that rejoins is named by where it was first met, so loops and merges terminate.
    if (at !== undefined) return `@${at}`;
    seen.set(id, seen.size);
    const next = [...(out.get(id) ?? [])].sort((a, b) => a.handle.localeCompare(b.handle));
    return `${type.get(id) ?? "?"}(${next.map((e) => `${e.handle}:${walk(e.to)}`).join(",")})`;
  };
  const starts = [...(out.get(null) ?? [])].sort((a, b) => a.handle.localeCompare(b.handle));
  return `${starts.map((e) => `${e.handle}:${walk(e.to)}`).join(",")}|${nodes.length}`;
}

const sameSettings = (a: FlowSettings, b: FlowSettings) =>
  JSON.stringify(normalizeSettings(a)) === JSON.stringify(normalizeSettings(b));

export async function basicFlowProblem(
  c: PoolClient,
  clinicId: string,
  d: { id?: string; recipeKey?: string; trigger: string },
  nodes: FlowNode[],
  edges: FlowEdge[],
  settings: FlowSettings
): Promise<"not_licensed" | null> {
  if (!d.id) {
    // A new flow is a template's copy, exactly as the template draws it.
    if (!d.recipeKey) return "not_licensed";
    const tpl = (
      await c.query(`select trigger_type, steps from recipe_templates where key = $1 and active`, [d.recipeKey])
    ).rows[0];
    if (!tpl || tpl.trigger_type !== d.trigger) return "not_licensed";
    const g = treeToGraph((Array.isArray(tpl.steps) ? tpl.steps : []) as RecipeStep[], () => randomUUID());
    if (signature(g.nodes, g.edges) !== signature(nodes, edges)) return "not_licensed";
    if (!sameSettings(settings, defaultSettingsFor(d.trigger))) return "not_licensed";
    return null;
  }
  const stored = await loadFlow(c, clinicId, d.id);
  // Not ours to answer: the save itself reports a missing flow.
  if (!stored) return null;
  if (stored.trigger !== d.trigger) return "not_licensed";
  if (!sameSettings(stored.settings, settings)) return "not_licensed";
  const types = new Map(stored.nodes.map((n) => [n.id, n.type]));
  if (types.size !== nodes.length || nodes.some((n) => types.get(n.id) !== n.type)) return "not_licensed";
  const key = (e: FlowEdge) => `${e.from ?? "trigger"}|${e.handle}|${e.to}`;
  const before = new Set(stored.edges.map(key));
  const after = new Set(edges.map(key));
  if (before.size !== after.size || [...after].some((k) => !before.has(k))) return "not_licensed";
  return null;
}
