"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Copy, MoreHorizontal, Play, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { PageHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Toggle } from "@/components/ui/input";
import { Avatar, Skeleton, Tabs } from "@/components/ui/misc";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  defaultSettingsFor,
  defaultStepConfig,
  defaultTriggerConfig,
  normalizeStepConfig,
  stepOutputs,
  triggerDef,
  EXIT_NEEDS,
  type FlowSettings,
  type StepKey,
  type TriggerKey,
} from "@/lib/automation/catalog";
import { blocking, validateFlow, type FlowEdge, type FlowNode, type Issue } from "@/lib/automation/graph";
import type { RunRow } from "@/lib/automation/store";
import type { FeatureMap } from "@/lib/features";
import {
  deleteAutomationAction,
  duplicateAutomationAction,
  saveAutomationAction,
  testRunAction,
} from "../actions";
import { fill, type Lookups } from "../flow-meta";
import type { CanvasProps, StepStats } from "./flow-canvas";
import { NODE_W, type XY } from "./auto-arrange";
import { StepPicker, TriggerPicker } from "./pickers";
import { StepInspector, TriggerInspector } from "./inspector";
import type { ReplyOption } from "./inspector-fields";
import { ActivityTab } from "./activity-tab";
import { SettingsTab } from "./settings-tab";

export type { StepStats };

const FlowCanvas = dynamic<CanvasProps>(() => import("./flow-canvas").then((m) => m.FlowCanvas), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full !rounded-none" />,
});

export type BuilderInitial = {
  id: string | null;
  name: string;
  description: string;
  trigger: string | null;
  triggerConfig: Record<string, unknown>;
  settings: FlowSettings;
  triggerPos: XY | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
  active: boolean;
  updatedAt: string | null;
};

type FlowState = Omit<BuilderInitial, "id" | "updatedAt">;

/** A step id the server will keep. randomUUID needs a secure context; a LAN test does not have one. */
function newId(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** Everything downstream of a step, for making room when one is inserted above it. */
function descendants(edges: FlowEdge[], start: string): Set<string> {
  const out = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges) if (e.from === id && !out.has(e.to)) {
      out.add(e.to);
      queue.push(e.to);
    }
  }
  return out;
}

export function BuilderClient({
  slug,
  tz,
  modules,
  initial,
  lookups,
  stats,
  runs,
  initialTab,
}: {
  slug: string;
  tz: string;
  modules: FeatureMap;
  initial: BuilderInitial;
  lookups: Lookups;
  stats: Record<string, StepStats>;
  runs: RunRow[];
  initialTab: "flow" | "activity" | "settings";
}) {
  const { t } = useI18n();
  const f = t.automations.flow;
  const router = useRouter();
  const { toast } = useToast();
  const wide = useWide();

  const [id, setId] = useState(initial.id);
  const [updatedAt, setUpdatedAt] = useState(initial.updatedAt);
  const [state, setState] = useState<FlowState>(() => {
    const { id: _id, updatedAt: _u, ...rest } = initial;
    void _id;
    void _u;
    return rest;
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const [baseline, setBaseline] = useState(() => JSON.stringify(state));
  const dirty = JSON.stringify(state) !== baseline;

  /* Undo / redo. Structural changes push at once; editing a step's settings
     pushes once, when the step is put down, so undo takes back the whole edit. */
  const past = useRef<FlowState[]>([]);
  const future = useRef<FlowState[]>([]);
  const [, bump] = useState(0);
  const commit = useCallback((next: FlowState) => {
    past.current = [...past.current.slice(-49), stateRef.current];
    future.current = [];
    setState(next);
    bump((n) => n + 1);
  }, []);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(stateRef.current);
    setState(prev);
    bump((n) => n + 1);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(stateRef.current);
    setState(next);
    bump((n) => n + 1);
  }, []);

  const [tab, setTab] = useState(initialTab);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const editStart = useRef<FlowState | null>(null);
  const select = useCallback((next: string | null) => {
    if (selectedRef.current === next) return;
    // Putting a step down: what changed while it was open becomes one undo.
    if (editStart.current && JSON.stringify(editStart.current) !== JSON.stringify(stateRef.current)) {
      past.current = [...past.current.slice(-49), editStart.current];
      future.current = [];
      bump((n) => n + 1);
    }
    editStart.current = next ? stateRef.current : null;
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const [stepPicker, setStepPicker] = useState<{ from: string | null; handle: string; at: XY | null; insertOn?: FlowEdge } | null>(null);
  const [triggerPicker, setTriggerPicker] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [pending, start] = useTransition();

  const provides = useMemo(() => triggerDef(state.trigger ?? "")?.provides ?? [], [state.trigger]);
  const hasReplyStep = state.nodes.some((n) => n.type === "wait_for_reply");
  const issues: Issue[] = useMemo(
    () =>
      state.trigger
        ? validateFlow({
            trigger: state.trigger,
            triggerConfig: state.triggerConfig,
            nodes: state.nodes,
            edges: state.edges,
            settings: state.settings,
          })
        : [{ nodeId: null, code: "bad_trigger", severity: "error" }],
    [state]
  );
  const errors = issues.filter((i) => i.severity === "error");
  const canEnable = !blocking(issues);

  // A brand-new flow opens on the question that starts it.
  useEffect(() => {
    if (!initial.trigger) setTriggerPicker(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Leaving with unsaved work asks first: a reload or a closed tab, and any
     link inside the app. */
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      if (!window.confirm(f.leaveConfirm)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, f.leaveConfirm]);

  // Undo and redo from the keyboard, but never out of a text box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  /* -----------------------------------------------------------------------
     Changes
     ----------------------------------------------------------------------- */

  const positionOf = (nodeId: string | null): XY => {
    if (nodeId === null) return stateRef.current.triggerPos ?? { x: 0, y: 0 };
    return stateRef.current.nodes.find((n) => n.id === nodeId)?.position ?? { x: 0, y: 0 };
  };

  const canConnect = useCallback((from: string | null, to: string) => {
    if (from === to) return false;
    if (from === null) return true;
    // No way round in a circle: the target must not already lead back here.
    return !descendants(stateRef.current.edges, to).has(from);
  }, []);

  const addStep = (type: StepKey) => {
    const req = stepPicker;
    setStepPicker(null);
    if (!req) return;
    const s = stateRef.current;
    const node: FlowNode = { id: newId(), type, config: defaultStepConfig(type), position: null, label: "" };
    let nodes = s.nodes;
    let edges = s.edges;
    if (req.insertOn) {
      const old = req.insertOn;
      const below = descendants(edges, old.to);
      node.position = { x: positionOf(old.to).x, y: positionOf(old.to).y };
      // Make room: everything from the old target down moves one row.
      nodes = nodes.map((n) => (below.has(n.id) && n.position ? { ...n, position: { x: n.position.x, y: n.position.y + 150 } } : n));
      edges = edges.filter((e) => !(e.from === old.from && e.handle === old.handle));
      edges = [...edges, { from: old.from, handle: old.handle, to: node.id }];
      const out = stepOutputs(type, node.config)[0];
      if (out) edges.push({ from: node.id, handle: out, to: old.to });
    } else {
      const outs = req.from === null ? ["next"] : stepOutputs(s.nodes.find((n) => n.id === req.from)?.type ?? "", s.nodes.find((n) => n.id === req.from)?.config ?? {});
      const i = Math.max(0, outs.indexOf(req.handle));
      const p = positionOf(req.from);
      const spread = outs.length > 1 ? (i - (outs.length - 1) / 2) * (NODE_W + 40) : 0;
      node.position = req.at ?? { x: p.x + spread + (req.from === null ? 14 : 0), y: p.y + (req.from === null ? 150 : 170) };
      edges = edges.filter((e) => !(e.from === req.from && e.handle === req.handle));
      edges = [...edges, { from: req.from, handle: req.handle, to: node.id }];
    }
    const next = { ...s, nodes: [...nodes, node], edges };
    commit(next);
    // Opened straight away for its settings; the add itself is already one undo.
    editStart.current = next;
    selectedRef.current = node.id;
    setSelected(node.id);
  };

  const removeNodes = (ids: string[]) => {
    if (!ids.length) return;
    const s = stateRef.current;
    let edges = s.edges;
    for (const nid of ids) {
      const node = s.nodes.find((n) => n.id === nid);
      if (!node) continue;
      // A plain step taken out of a chain: what led into it now leads past it.
      const outs = stepOutputs(node.type, node.config);
      const onward = outs.length === 1 ? edges.find((e) => e.from === nid && e.handle === outs[0])?.to : undefined;
      edges = edges
        .map((e) => (e.to === nid && onward && onward !== e.from ? { ...e, to: onward } : e))
        .filter((e) => e.from !== nid && e.to !== nid);
    }
    commit({ ...s, nodes: s.nodes.filter((n) => !ids.includes(n.id)), edges });
    if (selectedRef.current && ids.includes(selectedRef.current)) {
      editStart.current = null;
      selectedRef.current = null;
      setSelected(null);
    }
  };

  const duplicateNode = (nid: string) => {
    const s = stateRef.current;
    const n = s.nodes.find((x) => x.id === nid);
    if (!n) return;
    const copy: FlowNode = {
      ...n,
      id: newId(),
      config: JSON.parse(JSON.stringify(n.config)),
      position: n.position ? { x: n.position.x + 40, y: n.position.y + 40 } : null,
    };
    commit({ ...s, nodes: [...s.nodes, copy] });
    select(copy.id);
  };

  /** Settings edits: no history of their own (see `select`). */
  const updateNode = (nid: string, patch: Partial<FlowNode>) => {
    setState((s) => {
      const nodes = s.nodes.map((n) => (n.id === nid ? { ...n, ...patch } : n));
      const node = nodes.find((n) => n.id === nid)!;
      // An output that no longer exists cannot keep an edge.
      const outs = stepOutputs(node.type, node.config);
      const edges = s.edges.filter((e) => e.from !== nid || outs.includes(e.handle));
      return { ...s, nodes, edges };
    });
  };

  /*
    Answers are outputs, numbered. Taking out the second of three must move
    the third's connection up one, or it would quietly start receiving the
    second answer's patients; and going from "replied" to a list of answers
    keeps the replies flowing, through "anything else".
  */
  const updateReplyOptions = (nid: string, options: ReplyOption[], removed: number | null) => {
    setState((s) => {
      const node = s.nodes.find((n) => n.id === nid);
      if (!node) return s;
      const before = ((normalizeStepConfig("wait_for_reply", node.config).options as ReplyOption[]) ?? []).length;
      const remap = (h: string): string | null => {
        if (before === 0 && options.length > 0 && h === "replied") return "other";
        if (before > 0 && options.length === 0) {
          if (h === "other") return "replied";
          if (h.startsWith("opt:")) return null;
        }
        if (h.startsWith("opt:") && removed !== null) {
          const i = Number(h.slice(4));
          if (i === removed) return null;
          if (i > removed) return `opt:${i - 1}`;
        }
        return h;
      };
      const edges = s.edges
        .map((e) => (e.from === nid ? { ...e, handle: remap(e.handle) ?? "" } : e))
        .filter((e) => e.handle);
      const nodes = s.nodes.map((n) => (n.id === nid ? { ...n, config: { ...normalizeStepConfig(n.type, n.config), options } } : n));
      return { ...s, nodes, edges };
    });
  };

  const connect = (e: FlowEdge) => {
    const s = stateRef.current;
    if (!canConnect(e.from, e.to)) return;
    const edges = s.edges.filter((x) => !(x.from === e.from && x.handle === e.handle));
    commit({ ...s, edges: [...edges, e] });
  };

  const removeEdge = (e: FlowEdge) => {
    const s = stateRef.current;
    commit({ ...s, edges: s.edges.filter((x) => !(x.from === e.from && x.handle === e.handle)) });
  };

  const move = (positions: Record<string, XY>, opts: { history: boolean; baseline?: boolean }) => {
    const s = stateRef.current;
    const next: FlowState = {
      ...s,
      triggerPos: positions.trigger ?? s.triggerPos,
      nodes: s.nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)),
    };
    if (opts.baseline) {
      // A layout nobody asked for: not an edit, so the baseline moves with it.
      setState(next);
      if (!dirty) setBaseline(JSON.stringify(next));
      return;
    }
    if (opts.history) commit(next);
    else setState(next);
  };

  const pickTrigger = (trigger: TriggerKey, cfg: Record<string, unknown>) => {
    setTriggerPicker(false);
    const s = stateRef.current;
    const def = triggerDef(trigger);
    const fresh = !s.trigger && !s.nodes.length;
    // Early stops that this trigger cannot see are dropped rather than left to fail.
    const settings: FlowSettings = fresh
      ? defaultSettingsFor(trigger)
      : {
          ...s.settings,
          exit_on: s.settings.exit_on.filter(
            (ev) => def?.provides.includes(EXIT_NEEDS[ev]) || (ev === "patient_replied" && def?.provides.includes("conversation"))
          ),
        };
    commit({ ...s, trigger, triggerConfig: { ...defaultTriggerConfig(trigger), ...cfg }, settings });
    if (fresh) select("trigger");
  };

  /* -----------------------------------------------------------------------
     Save
     ----------------------------------------------------------------------- */

  const save = (overrides: Partial<FlowState> = {}) =>
    start(async () => {
      const s = { ...stateRef.current, ...overrides };
      if (!s.trigger) {
        setTriggerPicker(true);
        return;
      }
      const r = await saveAutomationAction(slug, {
        id: id ?? undefined,
        baseUpdatedAt: updatedAt,
        name: s.name.trim() || f.untitled,
        description: s.description,
        trigger: s.trigger,
        triggerConfig: s.triggerConfig,
        settings: s.settings,
        canvas: { trigger: s.triggerPos },
        nodes: s.nodes,
        edges: s.edges,
        active: s.active,
      });
      if (r.error || !r.id) {
        const msg =
          r.error === "conflict"
            ? f.conflict
            : r.error === "invalid_flow"
              ? f.invalidFlow
              : r.error === "bad_media"
                ? f.badMedia
                : r.error === "bad_target"
                  ? f.badTarget
                  : t.common.genericError;
        if (r.error === "invalid_flow") setIssuesOpen(true);
        toast(msg, "error");
        return;
      }
      const savedState = { ...s, name: s.name.trim() || f.untitled };
      if (overrides.active !== undefined) setState((cur) => ({ ...cur, active: overrides.active! }));
      setState((cur) => (cur.name.trim() ? cur : { ...cur, name: savedState.name }));
      setBaseline(JSON.stringify(savedState));
      setUpdatedAt(r.updatedAt ?? null);
      if (r.cancelledRuns) toast(fill(f.runsCancelled, { n: r.cancelledRuns }));
      toast(t.automations.saved);
      if (!id) {
        setId(r.id);
        router.replace(`/c/${slug}/automations/${r.id}`);
      }
    });

  /* -----------------------------------------------------------------------
     View
     ----------------------------------------------------------------------- */

  const selectedNode = selected && selected !== "trigger" ? state.nodes.find((n) => n.id === selected) : null;
  const inspector =
    selected === "trigger" && state.trigger ? (
      <TriggerInspector
        trigger={state.trigger}
        config={state.triggerConfig}
        onChange={(triggerConfig) => setState((s) => ({ ...s, triggerConfig }))}
        onChangeTrigger={() => setTriggerPicker(true)}
        lookups={lookups}
        issues={issues.filter((i) => i.nodeId === null && i.code !== "empty" && i.code !== "no_start")}
      />
    ) : selectedNode ? (
      <StepInspector
        key={selectedNode.id}
        slug={slug}
        node={selectedNode}
        provides={provides}
        hasReplyStep={hasReplyStep}
        lookups={lookups}
        issues={issues.filter((i) => i.nodeId === selectedNode.id)}
        onConfig={(config) => updateNode(selectedNode.id, { config })}
        onReplyOptions={(options, removed) => updateReplyOptions(selectedNode.id, options, removed)}
        onLabel={(label) => updateNode(selectedNode.id, { label })}
        onDelete={() => removeNodes([selectedNode.id])}
        onDuplicate={() => duplicateNode(selectedNode.id)}
      />
    ) : null;

  const statusPill = dirty ? (
    <span className="rounded-full bg-st-noshow-soft px-2.5 py-1 text-[12px] font-medium text-st-noshow">{f.unsaved}</span>
  ) : id ? (
    <span className="rounded-full bg-sunken px-2.5 py-1 text-[12px] font-medium text-ink-500">{f.allSaved}</span>
  ) : null;

  return (
    <>
      <PageHeader
        title={
          <input
            value={state.name}
            onChange={(e) => setState((s) => ({ ...s, name: e.target.value.slice(0, 80) }))}
            placeholder={f.namePlaceholder}
            aria-label={f.namePlaceholder}
            className="w-full min-w-0 max-w-full rounded-md border border-transparent bg-transparent text-xl font-semibold tracking-tight outline-none hover:border-line focus:border-brand-500 focus:bg-surface sm:min-w-64"
          />
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {statusPill}
            <label className="flex items-center gap-2 pe-1" title={!canEnable && !state.active ? fill(f.cantEnable, { n: errors.length }) : undefined}>
              <Toggle
                checked={state.active}
                label={t.automations.enable}
                onChange={(v) => {
                  if (v && !canEnable) {
                    setIssuesOpen(true);
                    toast(fill(f.cantEnable, { n: errors.length }), "error");
                    return;
                  }
                  setState((s) => ({ ...s, active: v }));
                }}
              />
              <span className="text-[13px] font-medium">{state.active ? f.on : f.off}</span>
            </label>
            {id && (
              <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
                <Play className="h-4 w-4" />
                {t.automations.testRun}
              </Button>
            )}
            {id && (
              <div className="relative">
                <Button variant="ghost" size="icon" aria-label={f.duplicate} onClick={() => setMenuOpen((o) => !o)}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                    <div className="absolute end-0 top-full z-40 mt-1 grid min-w-44 gap-0.5 rounded-ctl border border-line bg-surface p-1 shadow-pop">
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          start(async () => {
                            const r = await duplicateAutomationAction(slug, id, fill(f.copyName, { name: state.name || f.untitled }));
                            if (r.error || !r.id) return toast(t.common.genericError, "error");
                            toast(f.duplicated);
                            router.push(`/c/${slug}/automations/${r.id}`);
                          });
                        }}
                        className="flex items-center gap-2 rounded-md px-2.5 py-2 text-start text-[13px] hover:bg-sunken"
                      >
                        <Copy className="h-4 w-4 text-ink-500" />
                        {f.duplicate}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          setDeleteOpen(true);
                        }}
                        className="flex items-center gap-2 rounded-md px-2.5 py-2 text-start text-[13px] text-danger hover:bg-danger-soft"
                      >
                        <Trash2 className="h-4 w-4" />
                        {f.delete}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            <Button onClick={() => save()} loading={pending} disabled={!dirty && Boolean(id)}>
              {t.common.save}
            </Button>
          </div>
        }
      />

      <div className="mb-4">
        <Tabs
          tabs={[
            { key: "flow", label: f.tabCanvas },
            ...(id ? [{ key: "activity", label: f.tabActivity, count: runs.length }] : []),
            { key: "settings", label: f.tabSettings },
          ]}
          active={tab}
          onChange={(k) => setTab(k as typeof tab)}
        />
      </div>

      {tab === "flow" && (
        <div className="flex min-w-0 gap-4">
          <div className="relative h-[68dvh] min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-card border border-line bg-canvas shadow-card lg:h-[calc(100dvh-15rem)]">
            <FlowCanvas
              trigger={state.trigger}
              triggerConfig={state.triggerConfig}
              triggerPos={state.triggerPos}
              nodes={state.nodes}
              edges={state.edges}
              issues={issues}
              stats={stats}
              lookups={lookups}
              selectedId={selected}
              focusNonce={focusNonce}
              canUndo={past.current.length > 0}
              canRedo={future.current.length > 0}
              onUndo={undo}
              onRedo={redo}
              onSelect={(nid) => {
                if (nid === "trigger" && !state.trigger) setTriggerPicker(true);
                select(nid);
              }}
              onMove={move}
              onConnect={connect}
              onRemoveEdge={removeEdge}
              onRemoveNodes={removeNodes}
              onAddFrom={(from, handle, at) => setStepPicker({ from, handle, at })}
              onInsertOnEdge={(edge, at) => setStepPicker({ from: edge.from, handle: edge.handle, at, insertOn: edge })}
              canConnect={canConnect}
            />
            {/*
              Opposite the toolbar, which the canvas keeps on the physical right
              in both languages; and at the bottom of a phone, where there is no
              room beside it.
            */}
            <div className="pointer-events-none absolute left-3 top-3 max-w-[min(360px,calc(100%-200px))] max-sm:bottom-3 max-sm:top-auto max-sm:max-w-[calc(100%-24px)]">
              <div className="pointer-events-auto flex flex-col items-start max-sm:flex-col-reverse">
                <button
                  type="button"
                  data-flow-issues={errors.length}
                  onClick={() => setIssuesOpen((o) => !o)}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold shadow-card ${
                    errors.length
                      ? "border-danger/40 bg-danger-soft text-danger"
                      : issues.length
                        ? "border-line bg-surface text-st-noshow"
                        : "border-line bg-surface text-st-confirmed"
                  }`}
                >
                  {errors.length ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  {errors.length
                    ? fill(f.problems, { n: errors.length })
                    : issues.length
                      ? fill(f.warnings, { n: issues.length })
                      : f.ready}
                </button>
                {issuesOpen && issues.length > 0 && (
                  <div className="mt-2 max-h-72 overflow-auto rounded-xl border border-line bg-surface p-2 shadow-pop max-sm:mb-2 max-sm:mt-0">
                    <div className="px-1.5 pb-1.5 text-[12px] font-semibold text-ink-500">{f.issuesTitle}</div>
                    <ul className="grid gap-1">
                      {issues.map((i, n) => {
                        const node = i.nodeId ? state.nodes.find((x) => x.id === i.nodeId) : null;
                        return (
                          <li key={n}>
                            <button
                              type="button"
                              onClick={() => {
                                select(i.nodeId ?? (i.code === "exit_unavailable" ? null : "trigger"));
                                if (i.code === "exit_unavailable") setTab("settings");
                                if (i.code === "bad_trigger" && !state.trigger) setTriggerPicker(true);
                                setFocusNonce((x) => x + 1);
                              }}
                              className="flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-start text-[12px] hover:bg-sunken"
                            >
                              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${i.severity === "error" ? "bg-danger" : "bg-warning"}`} />
                              <span className="min-w-0">
                                {node && (
                                  <span className="block font-semibold text-ink-900">
                                    {node.label || (t.automations.steps as Record<string, string>)[node.type]}
                                  </span>
                                )}
                                <span className="block text-ink-700">
                                  {fill((f.issue as Record<string, string>)[i.code] ?? i.code, { detail: i.detail ?? "" })}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <p className="pointer-events-none absolute bottom-2 start-3 hidden max-w-[50%] text-[11px] text-ink-400 md:block">{f.canvasHint}</p>
          </div>
          {wide && inspector && (
            <aside data-inspector className="w-[380px] shrink-0 overflow-auto rounded-card border border-line bg-surface p-4 shadow-card lg:h-[calc(100dvh-15rem)]">
              {inspector}
            </aside>
          )}
        </div>
      )}

      {tab === "activity" && id && <ActivityTab slug={slug} automationId={id} initialRuns={runs} tz={tz} nodes={state.nodes} />}

      {tab === "settings" && (
        <SettingsTab
          description={state.description}
          onDescription={(description) => setState((s) => ({ ...s, description }))}
          settings={state.settings}
          onSettings={(settings) => commit({ ...stateRef.current, settings })}
          provides={provides}
          hasReplyStep={hasReplyStep}
        />
      )}

      {!wide && inspector && tab === "flow" && (
        <Modal open onClose={() => select(null)} title={f.inspector}>
          {inspector}
        </Modal>
      )}

      <StepPicker open={Boolean(stepPicker)} onClose={() => setStepPicker(null)} onPick={addStep} provides={provides} modules={modules} />
      <TriggerPicker open={triggerPicker} onClose={() => setTriggerPicker(false)} onPick={pickTrigger} modules={modules} />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t.automations.deleteAutomation}
        body={f.deleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        loading={pending}
        onConfirm={() =>
          start(async () => {
            if (!id) return;
            await deleteAutomationAction(slug, id);
            setBaseline(JSON.stringify(stateRef.current));
            setDeleteOpen(false);
            router.push(`/c/${slug}/automations`);
          })
        }
      />

      {id && <TestRunModal open={testOpen} onClose={() => setTestOpen(false)} slug={slug} automationId={id} />}
    </>
  );
}

function TestRunModal({
  open,
  onClose,
  slug,
  automationId,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  automationId: string;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; full_name: string }[]>([]);
  const [pending, start] = useTransition();
  const seq = useRef(0);

  return (
    <Modal open={open} onClose={onClose} title={t.automations.testRun}>
      <p className="mb-3 text-[13px] text-ink-500">{t.automations.testRunHint}</p>
      <Input
        value={q}
        placeholder={t.patients.searchPlaceholder}
        onChange={async (e) => {
          const val = e.target.value;
          setQ(val);
          const mine = ++seq.current;
          if (val.trim().length < 2) return setResults([]);
          const res = await fetch(`/api/c/${slug}/patients/search?q=${encodeURIComponent(val)}`);
          if (res.ok && mine === seq.current) setResults((await res.json()).results ?? []);
        }}
      />
      <div className="mt-2 grid gap-1">
        {results.map((r) => (
          <button
            key={r.id}
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await testRunAction(slug, automationId, r.id);
                toast(res.error ? t.common.genericError : t.common.done, res.error ? "error" : "success");
                onClose();
              })
            }
            className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-start text-sm hover:bg-sunken"
          >
            <Avatar name={r.full_name} size={26} />
            {r.full_name}
          </button>
        ))}
      </div>
    </Modal>
  );
}
