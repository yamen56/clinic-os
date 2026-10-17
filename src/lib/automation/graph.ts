import {
  type Ctx,
  type Rule,
  RULE_NEEDS,
  EXIT_NEEDS,
  isStepKey,
  normalizeStepConfig,
  parseStepConfig,
  parseTriggerConfig,
  ruleComplete,
  stepDef,
  stepOutputs,
  triggerDef,
  type FlowSettings,
} from "./catalog";
import { unavailableVariables } from "./variables";

/**
 * A flow as the canvas holds it: steps, and the edges between their outputs.
 * `from: null` is the trigger.
 */
export type FlowNode = {
  id: string;
  type: string;
  config: Record<string, unknown>;
  position: { x: number; y: number } | null;
  label: string;
};
export type FlowEdge = { from: string | null; handle: string; to: string };

export type IssueCode =
  | "bad_trigger"
  | "empty"
  | "no_start"
  | "unknown_step"
  | "invalid_config"
  | "empty_message"
  | "no_template"
  | "no_tag"
  | "no_target"
  | "no_rules"
  | "incomplete_rule"
  | "no_title"
  | "no_recipients"
  | "no_member"
  | "no_field"
  | "empty_note"
  | "option_no_keywords"
  | "needs_patient"
  | "needs_appointment"
  | "needs_invoice"
  | "needs_document"
  | "needs_conversation"
  | "bad_edge"
  | "cycle"
  | "unreachable"
  | "unavailable_variable"
  | "exit_unavailable";

export type Issue = {
  nodeId: string | null;
  code: IssueCode;
  severity: "error" | "warning";
  /** A variable name, a rule number — whatever makes the message specific. */
  detail?: string;
};

/** Whether this flow is allowed to be switched on. */
export function blocking(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

const NEEDS_CODE: Record<Ctx, IssueCode> = {
  patient: "needs_patient",
  appointment: "needs_appointment",
  invoice: "needs_invoice",
  document: "needs_document",
  conversation: "needs_conversation",
};

function stepIssues(node: FlowNode, provides: Ctx[], hasReplyStep: boolean): Issue[] {
  const out: Issue[] = [];
  const err = (code: IssueCode, detail?: string) => out.push({ nodeId: node.id, code, severity: "error", detail });
  const warn = (code: IssueCode, detail?: string) =>
    out.push({ nodeId: node.id, code, severity: "warning", detail });

  if (!isStepKey(node.type)) {
    err("unknown_step");
    return out;
  }
  const parsed = parseStepConfig(node.type, node.config);
  if (!parsed.success) {
    err("invalid_config");
    return out;
  }
  const cfg = parsed.data as Record<string, unknown>;

  for (const need of stepDef(node.type)!.needs) if (!provides.includes(need)) err(NEEDS_CODE[need]);

  const str = (k: string) => String(cfg[k] ?? "").trim();
  switch (node.type) {
    case "send_whatsapp":
      if (!str("message") && !cfg.media) err("empty_message");
      for (const v of unavailableVariables(str("message"), provides, hasReplyStep)) warn("unavailable_variable", v);
      break;
    case "send_document":
      if (!str("template_id")) err("no_template");
      break;
    case "add_tag":
    case "remove_tag":
      if (!str("tag")) err("no_tag");
      break;
    case "goto_automation":
      if (!str("automation_id")) err("no_target");
      break;
    case "condition": {
      const rules = (cfg.rules as Rule[]) ?? [];
      if (!rules.length) err("no_rules");
      rules.forEach((r, i) => {
        if (!ruleComplete(r)) err("incomplete_rule", String(i + 1));
        const need = RULE_NEEDS[r.kind];
        if (need && !provides.includes(need)) err(NEEDS_CODE[need], String(i + 1));
      });
      break;
    }
    case "wait":
      if (cfg.mode === "appointment" && !provides.includes("appointment")) err("needs_appointment");
      break;
    case "wait_for_reply": {
      const options = (cfg.options as { keywords: string[] }[]) ?? [];
      options.forEach((o, i) => {
        if (!o.keywords.length) err("option_no_keywords", String(i + 1));
      });
      break;
    }
    case "update_patient":
      if (cfg.field === "custom" && !str("key")) err("no_field");
      break;
    case "add_note":
      if (!str("body")) err("empty_note");
      break;
    case "assign_conversation":
      if (cfg.target === "member" && !str("member_id")) err("no_member");
      if (cfg.target === "appointment_doctor" && !provides.includes("appointment")) err("needs_appointment");
      break;
    case "create_task":
      if (!str("title")) err("no_title");
      if (cfg.assignee === "member" && !str("member_id")) err("no_member");
      if (cfg.assignee === "appointment_doctor" && !provides.includes("appointment")) err("needs_appointment");
      break;
    case "notify_staff": {
      if (!str("title")) err("no_title");
      const roles = (cfg.roles as string[]) ?? [];
      const members = (cfg.member_ids as string[]) ?? [];
      if (!roles.length && !members.length && !cfg.appointment_doctor) err("no_recipients");
      if (cfg.appointment_doctor && !provides.includes("appointment")) err("needs_appointment");
      break;
    }
  }
  return out;
}

/**
 * Everything wrong with a flow, each pinned to the step it is about.
 *
 * Errors stop a flow being switched on; warnings are shown and allowed. A step
 * nothing leads to is only a warning: it is somewhere to park an idea while
 * building, and it simply never runs.
 */
export function validateFlow(flow: {
  trigger: string;
  triggerConfig: Record<string, unknown>;
  nodes: FlowNode[];
  edges: FlowEdge[];
  settings?: FlowSettings;
}): Issue[] {
  const issues: Issue[] = [];
  const def = triggerDef(flow.trigger);
  if (!def || !parseTriggerConfig(flow.trigger, flow.triggerConfig).success) {
    issues.push({ nodeId: null, code: "bad_trigger", severity: "error" });
  }
  const provides = def?.provides ?? [];
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const hasReplyStep = flow.nodes.some((n) => n.type === "wait_for_reply");

  if (!flow.nodes.length) issues.push({ nodeId: null, code: "empty", severity: "error" });

  for (const n of flow.nodes) issues.push(...stepIssues({ ...n, config: normalizeStepConfig(n.type, n.config) }, provides, hasReplyStep));

  for (const ev of flow.settings?.exit_on ?? []) {
    const need = EXIT_NEEDS[ev];
    const ok = provides.includes(need) || (ev === "patient_replied" && provides.includes("conversation"));
    if (!ok) issues.push({ nodeId: null, code: "exit_unavailable", severity: "error", detail: ev });
  }

  // Edges: real ends, a real output, and one edge per output.
  const seen = new Set<string>();
  const out = new Map<string | null, string[]>();
  for (const e of flow.edges) {
    const from = e.from === null ? null : byId.get(e.from);
    const fromOk = e.from === null ? e.handle === "next" : Boolean(from);
    const handleOk =
      e.from === null || (from ? stepOutputs(from.type, normalizeStepConfig(from.type, from.config)).includes(e.handle) : false);
    const key = `${e.from ?? "∅"}|${e.handle}`;
    if (!fromOk || !handleOk || !byId.has(e.to) || seen.has(key) || e.from === e.to) {
      issues.push({ nodeId: e.from, code: "bad_edge", severity: "error", detail: e.handle });
      continue;
    }
    seen.add(key);
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }

  if (flow.nodes.length && !out.get(null)?.length) issues.push({ nodeId: null, code: "no_start", severity: "error" });

  // Reachable from the trigger, and no way back round. A loop would let one
  // run walk the same steps for ever, a message at every turn.
  const state = new Map<string, 1 | 2>();
  const inCycle = new Set<string>();
  const visit = (id: string, path: string[]) => {
    const s = state.get(id);
    if (s === 1) {
      for (const p of path.slice(path.indexOf(id))) inCycle.add(p);
      return;
    }
    if (s === 2) return;
    state.set(id, 1);
    for (const next of out.get(id) ?? []) visit(next, [...path, id]);
    state.set(id, 2);
  };
  for (const start of out.get(null) ?? []) visit(start, []);
  for (const id of inCycle) issues.push({ nodeId: id, code: "cycle", severity: "error" });
  for (const n of flow.nodes) {
    if (!state.has(n.id)) issues.push({ nodeId: n.id, code: "unreachable", severity: "warning" });
  }
  return issues;
}

/* -------------------------------------------------------------------------
   Recipes: written as nested lists, installed as a graph
   ------------------------------------------------------------------------- */

/**
 * A recipe step. Recipes stay written as nested lists because that is how a
 * person writes one down; the branches are keyed by output (`yes`, `no`,
 * `opt:0`, `timeout`…). An output with no list carries on with whatever comes
 * after the branching step, as the old engine did.
 */
export type RecipeStep = {
  step_type: string;
  config?: Record<string, unknown>;
  children?: Record<string, RecipeStep[] | undefined>;
};

export function treeToGraph(
  steps: RecipeStep[],
  newId: () => string
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  const build = (list: RecipeStep[], cont: string | null): string | null => {
    const ids = list.map(() => newId());
    list.forEach((s, i) => {
      const config = normalizeStepConfig(s.step_type, s.config ?? {});
      nodes.push({ id: ids[i], type: s.step_type, config, position: null, label: "" });
    });
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      const next = i + 1 < list.length ? ids[i + 1] : cont;
      const outputs = stepOutputs(s.step_type, nodes.find((n) => n.id === ids[i])!.config);
      for (const handle of outputs) {
        const branch = s.children?.[handle];
        const target = branch && branch.length ? build(branch, next) : next;
        if (target) edges.push({ from: ids[i], handle, to: target });
      }
    }
    return ids[0] ?? cont;
  };

  const start = build(steps, null);
  if (start) edges.push({ from: null, handle: "next", to: start });
  return { nodes, edges };
}

/* -------------------------------------------------------------------------
   Flows still written as a tree
   ------------------------------------------------------------------------- */

export type TreeRow = {
  id: string;
  parent_step_id: string | null;
  branch: string | null;
  sort: number;
  step_type: string;
};

/**
 * The edges an old-style tree implies, exactly as migration 0079 drew them.
 *
 * Anything that writes steps the old way — a script, the seed, or the previous
 * web server in the minutes a deploy takes — leaves a flow with steps and no
 * edges. Read as edges, it runs the way it always did instead of doing nothing.
 */
export function legacyTreeEdges(rows: TreeRow[]): FlowEdge[] {
  const order = (a: TreeRow, b: TreeRow) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const siblings = (r: TreeRow) =>
    rows.filter((x) => x.parent_step_id === r.parent_step_id && (r.parent_step_id === null || x.branch === r.branch)).sort(order);
  const cont = (r: TreeRow): string | null => {
    const sib = siblings(r);
    const i = sib.findIndex((x) => x.id === r.id);
    if (i >= 0 && i + 1 < sib.length) return sib[i + 1].id;
    if (!r.parent_step_id) return null;
    const parent = byId.get(r.parent_step_id);
    return parent ? cont(parent) : null;
  };
  const edges: FlowEdge[] = [];
  const root = rows.filter((r) => r.parent_step_id === null).sort(order)[0];
  if (root) edges.push({ from: null, handle: "next", to: root.id });
  for (const r of rows) {
    if (r.step_type === "stop") continue;
    if (r.step_type === "condition") {
      for (const br of ["yes", "no"]) {
        const child = rows.filter((x) => x.parent_step_id === r.id && x.branch === br).sort(order)[0];
        const to = child?.id ?? cont(r);
        if (to) edges.push({ from: r.id, handle: br, to });
      }
    } else {
      const to = cont(r);
      if (to) edges.push({ from: r.id, handle: "next", to });
    }
  }
  return edges;
}
