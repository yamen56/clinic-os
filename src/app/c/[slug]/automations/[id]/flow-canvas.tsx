"use client";

import "./flow-canvas.css";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getSmoothStepPath,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { Maximize, Minus, Network, Plus, Redo2, Undo2, X, Zap } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { stepDef, stepOutputs } from "@/lib/automation/catalog";
import type { FlowEdge, FlowNode, Issue } from "@/lib/automation/graph";
import {
  STEP_ICONS,
  TRIGGER_ICONS,
  fill,
  handleLabel,
  stepSummary,
  toneOf,
  triggerSummary,
  type Lookups,
} from "../flow-meta";
import { NODE_H, NODE_W, TRIGGER_W, arrange, stepWidth, type XY } from "./auto-arrange";

export type StepStats = { ok: number; skipped: number; failed: number; waiting: number };

export type CanvasProps = {
  trigger: string | null;
  triggerConfig: Record<string, unknown>;
  triggerPos: XY | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
  issues: Issue[];
  stats: Record<string, StepStats>;
  lookups: Lookups;
  selectedId: string | null;
  /** Bumped to pan to `selectedId`, e.g. from the list of problems. */
  focusNonce: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSelect: (id: string | null) => void;
  /** New positions. `baseline` marks a layout nobody asked for, which is not an edit. */
  onMove: (positions: Record<string, XY>, opts: { history: boolean; baseline?: boolean }) => void;
  onConnect: (edge: FlowEdge) => void;
  onRemoveEdge: (edge: FlowEdge) => void;
  onRemoveNodes: (ids: string[]) => void;
  onAddFrom: (from: string | null, handle: string, at: XY | null) => void;
  onInsertOnEdge: (edge: FlowEdge, at: XY) => void;
  canConnect: (from: string | null, to: string) => boolean;
};

const edgeKey = (e: FlowEdge) => `${e.from ?? "trigger"}|${e.handle}`;

type Ctx = {
  props: CanvasProps;
  issuesById: Map<string, Issue[]>;
  connected: Map<string, Set<string>>;
  edgeByKey: Map<string, FlowEdge>;
};
const CanvasCtx = createContext<Ctx | null>(null);
const useCanvas = () => useContext(CanvasCtx)!;

export function FlowCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}

function Inner(props: CanvasProps) {
  const { t } = useI18n();
  const rf = useReactFlow();
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  const build = useCallback(
    (prev: Node[]): Node[] => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      const keep = (id: string) => {
        const p = byId.get(id);
        return p ? { measured: p.measured, width: p.width, height: p.height } : {};
      };
      return [
        {
          id: "trigger",
          type: "trigger",
          position: props.triggerPos ?? byId.get("trigger")?.position ?? { x: 0, y: 0 },
          data: {},
          deletable: false,
          selected: props.selectedId === "trigger",
          ...keep("trigger"),
        },
        ...props.nodes.map((n) => ({
          id: n.id,
          type: "step",
          position: n.position ?? byId.get(n.id)?.position ?? { x: 0, y: 0 },
          data: { node: n },
          selected: props.selectedId === n.id,
          ...keep(n.id),
        })),
      ];
    },
    [props.nodes, props.triggerPos, props.selectedId]
  );

  const [rfNodes, setRfNodes] = useState<Node[]>(() => build([]));
  useEffect(() => setRfNodes((prev) => build(prev)), [build]);

  /*
    A flow that has never been drawn — every one made before the canvas, and
    every template — is laid out once on opening. Reported as a baseline, so
    opening an old flow does not announce unsaved changes nobody made.
  */
  const laidOut = useRef(false);
  useEffect(() => {
    if (laidOut.current) return;
    laidOut.current = true;
    const missing = !props.triggerPos || props.nodes.some((n) => !n.position);
    if (missing) {
      const pos = arrange(
        [{ id: "trigger" }, ...props.nodes.map((n) => ({ id: n.id, width: stepWidth(stepOutputs(n.type, n.config).length) }))],
        props.edges
      );
      props.onMove(pos, { history: false, baseline: true });
    }
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
    The opening view: the whole flow if it fits at a size people can read,
    otherwise its top at a readable size. Fitting a twelve-step flow into the
    frame shrank every card to an unreadable 60%.
  */
  const box = useRef<HTMLDivElement>(null);
  const frame = useCallback(
    (duration = 0) => {
      const el = box.current;
      const nodes = rf.getNodes();
      if (!el || !nodes.length) return;
      const b = rf.getNodesBounds(nodes);
      const w = el.clientWidth;
      const h = el.clientHeight;
      const zoom = Math.min(1, Math.max(0.72, Math.min((w - 48) / b.width, (h - 120) / b.height)));
      const x = (w - b.width * zoom) / 2 - b.x * zoom;
      const y = Math.max(64, (h - b.height * zoom) / 2) - b.y * zoom;
      rf.setViewport({ x, y, zoom }, { duration });
    },
    [rf]
  );
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current || !rfNodes.length || !rfNodes.every((n) => n.measured?.width)) return;
    framed.current = true;
    requestAnimationFrame(() => frame());
  }, [rfNodes, frame]);

  // Pan to a step asked for from outside (the list of problems).
  useEffect(() => {
    if (!props.focusNonce || !props.selectedId) return;
    const n = rf.getNode(props.selectedId);
    if (n) {
      const w = n.measured?.width ?? NODE_W;
      const h = n.measured?.height ?? NODE_H;
      rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 300 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusNonce]);

  const tidy = () => {
    const measured = rf.getNodes();
    const pos = arrange(
      measured.map((n) => ({ id: n.id, width: n.measured?.width, height: n.measured?.height })),
      props.edges
    );
    props.onMove(pos, { history: true });
    requestAnimationFrame(() => requestAnimationFrame(() => frame(300)));
  };

  const issuesById = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const i of props.issues) {
      const k = i.nodeId ?? "trigger";
      m.set(k, [...(m.get(k) ?? []), i]);
    }
    return m;
  }, [props.issues]);

  const { connected, edgeByKey } = useMemo(() => {
    const c = new Map<string, Set<string>>();
    const byKey = new Map<string, FlowEdge>();
    for (const e of props.edges) {
      const k = e.from ?? "trigger";
      c.set(k, new Set([...(c.get(k) ?? []), e.handle]));
      byKey.set(edgeKey(e), e);
    }
    return { connected: c, edgeByKey: byKey };
  }, [props.edges]);

  const rfEdges: Edge[] = useMemo(
    () =>
      props.edges.map((e) => ({
        id: edgeKey(e),
        source: e.from ?? "trigger",
        sourceHandle: e.handle,
        target: e.to,
        targetHandle: "in",
        type: "flow",
        selected: selectedEdge === edgeKey(e),
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      })),
    [props.edges, selectedEdge]
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Removal goes through onNodesDelete, so the parent decides what is healed.
    setRfNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== "remove" && c.type !== "select"), nds));
  }, []);

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type === "select") setSelectedEdge(c.selected ? c.id : null);
        if (c.type === "remove") {
          const e = edgeByKey.get(c.id);
          if (e) props.onRemoveEdge(e);
        }
      }
    },
    [edgeByKey, props]
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      props.onConnect({ from: c.source === "trigger" ? null : c.source, handle: c.sourceHandle ?? "next", to: c.target });
    },
    [props]
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode || state.fromHandle?.type !== "source") return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      if (!point) return;
      const at = rf.screenToFlowPosition({ x: point.clientX, y: point.clientY });
      const from = state.fromNode.id === "trigger" ? null : state.fromNode.id;
      props.onAddFrom(from, state.fromHandle.id ?? "next", { x: at.x - NODE_W / 2, y: at.y });
    },
    [props, rf]
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) =>
      Boolean(c.source && c.target) &&
      c.target !== "trigger" &&
      c.source !== c.target &&
      props.canConnect(c.source === "trigger" ? null : c.source, c.target),
    [props]
  );

  const ctx = useMemo<Ctx>(() => ({ props, issuesById, connected, edgeByKey }), [props, issuesById, connected, edgeByKey]);

  return (
    <CanvasCtx.Provider value={ctx}>
      {/* The canvas is direction-neutral; the cards inside follow the language. */}
      <div ref={box} data-pannable className="flow-canvas h-full w-full" dir="ltr">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onNodeClick={(_, n) => {
            setSelectedEdge(null);
            props.onSelect(n.id);
          }}
          onPaneClick={() => {
            setSelectedEdge(null);
            props.onSelect(null);
          }}
          onNodeDragStop={(_, n) => {
            props.onMove({ [n.id]: { x: Math.round(n.position.x), y: Math.round(n.position.y) } }, { history: true });
          }}
          onNodesDelete={(deleted) => props.onRemoveNodes(deleted.map((n) => n.id).filter((id) => id !== "trigger"))}
          deleteKeyCode={["Delete", "Backspace"]}
          selectionOnDrag={false}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          minZoom={0.25}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          connectionRadius={36}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
          <Panel position="top-right">
            <div className="flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-card" dir="ltr">
              <ToolButton label={t.automations.flow.undo} onClick={props.onUndo} disabled={!props.canUndo}>
                <Undo2 className="h-4 w-4" />
              </ToolButton>
              <ToolButton label={t.automations.flow.redo} onClick={props.onRedo} disabled={!props.canRedo}>
                <Redo2 className="h-4 w-4" />
              </ToolButton>
              <span className="mx-0.5 h-5 w-px bg-line" />
              <ToolButton label={t.automations.flow.zoomOut} onClick={() => rf.zoomOut({ duration: 150 })}>
                <Minus className="h-4 w-4" />
              </ToolButton>
              <ToolButton label={t.automations.flow.zoomIn} onClick={() => rf.zoomIn({ duration: 150 })}>
                <Plus className="h-4 w-4" />
              </ToolButton>
              <ToolButton label={t.automations.flow.fit} onClick={() => rf.fitView({ padding: 0.2, maxZoom: 1, duration: 300 })}>
                <Maximize className="h-4 w-4" />
              </ToolButton>
              <ToolButton label={t.automations.flow.tidy} onClick={tidy} wide>
                <Network className="h-4 w-4" />
                <span className="hidden text-[12px] font-medium sm:inline">{t.automations.flow.tidy}</span>
              </ToolButton>
            </div>
          </Panel>
        </ReactFlow>
      </div>
    </CanvasCtx.Provider>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  wide,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-8 items-center justify-center gap-1.5 rounded-md text-ink-700 hover:bg-sunken disabled:opacity-35 disabled:hover:bg-transparent ${
        wide ? "px-2" : "w-8"
      }`}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------
   Nodes
   ------------------------------------------------------------------------- */

function AddButton({ label, onClick, big }: { label: string; onClick: () => void; big?: boolean }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      title={label}
      className={`nodrag nopan flex items-center gap-1.5 rounded-full border border-dashed border-brand-400 bg-surface text-brand-700 shadow-card transition-colors hover:border-solid hover:border-brand-600 hover:bg-brand-50 ${
        big ? "h-9 px-3.5 text-[13px] font-semibold" : "h-7 w-7 justify-center"
      }`}
    >
      <Plus className={big ? "h-4 w-4" : "h-3.5 w-3.5"} />
      {big && label}
    </button>
  );
}

function IssueDot({ issues }: { issues: Issue[] }) {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  if (!issues.length) return null;
  return (
    <span
      className={`grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1 text-[11px] font-bold text-white ${
        errors ? "bg-danger" : "bg-warning"
      }`}
    >
      {errors || warnings}
    </span>
  );
}

const TriggerNode = memo(function TriggerNode({ selected }: NodeProps) {
  const { t, locale, dir } = useI18n();
  const { props, issuesById, connected } = useCanvas();
  const Icon = (props.trigger && TRIGGER_ICONS[props.trigger]) || Zap;
  const sum = props.trigger
    ? triggerSummary(t.automations, props.trigger, props.triggerConfig, props.lookups, locale)
    : null;
  const hasStart = connected.get("trigger")?.has("next");
  const issues = (issuesById.get("trigger") ?? []).filter((i) => i.code === "bad_trigger");
  return (
    <div
      dir={dir}
      style={{ width: TRIGGER_W }}
      className={`relative rounded-xl bg-brand-600 text-start text-white shadow-pop ring-offset-2 ring-offset-canvas ${
        selected ? "ring-2 ring-brand-400" : ""
      }`}
    >
      <div className="flex items-start gap-3 p-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/12">
          <Icon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-wide text-white/60 uppercase rtl:normal-case">
            {t.automations.flow.when}
          </div>
          <div className="truncate text-sm font-semibold">{sum ? sum.title : t.automations.flow.chooseTrigger}</div>
          {sum?.detail && <div className="mt-0.5 line-clamp-2 text-[12px] text-white/70">{sum.detail}</div>}
        </div>
        <IssueDot issues={issues} />
      </div>
      <Handle type="source" position={Position.Bottom} id="next" />
      {props.trigger && !hasStart && (
        <div className="absolute start-1/2 top-full mt-5 -translate-x-1/2 rtl:translate-x-1/2">
          <AddButton big label={t.automations.flow.addFirstStep} onClick={() => props.onAddFrom(null, "next", null)} />
        </div>
      )}
    </div>
  );
});

const StepNode = memo(function StepNode({ id, data, selected }: NodeProps) {
  const { t, locale, dir } = useI18n();
  const { props, issuesById, connected } = useCanvas();
  const node = (data as { node: FlowNode }).node;
  const Icon = STEP_ICONS[node.type] ?? Zap;
  const tone = toneOf(node.type);
  const outputs = stepOutputs(node.type, node.config);
  const issues = issuesById.get(id) ?? [];
  const errors = issues.some((i) => i.severity === "error");
  const summary = stepSummary(t, node.type, node.config, props.lookups, locale);
  const name = (t.automations.steps as Record<string, string>)[node.type] ?? node.type;
  const stats = props.stats[id];
  const used = connected.get(id) ?? new Set<string>();
  const branching = outputs.length > 1;
  const def = stepDef(node.type);

  return (
    <div
      dir={dir}
      style={{ width: stepWidth(outputs.length) }}
      className={`group relative rounded-xl border bg-surface text-start shadow-card transition-[border-color,box-shadow] ${
        selected
          ? "border-brand-600 shadow-pop ring-2 ring-brand-600/15"
          : errors
            ? "border-danger/70"
            : "border-line hover:border-line-strong"
      }`}
    >
      <Handle type="target" position={Position.Top} id="in" />
      <div className={`absolute inset-y-3 start-0 w-[3px] rounded-e-full ${tone.bar}`} aria-hidden />
      <div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${tone.chip}`}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ink-900">{node.label || name}</div>
          <div className="mt-0.5 line-clamp-2 break-words text-[12px] leading-snug text-ink-500">
            {summary || (node.label ? name : def ? (t.automations.flow.stepHints as Record<string, string>)[node.type] : "")}
          </div>
        </div>
        <IssueDot issues={issues} />
      </div>
      {stats && stats.ok + stats.failed + stats.waiting > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-line px-3.5 py-1.5 text-[11px] font-medium" title={t.automations.flow.last30}>
          {stats.ok > 0 && (
            <span className="rounded bg-st-confirmed-soft px-1.5 py-0.5 text-st-confirmed">
              {fill(t.automations.flow.statsDone, { n: stats.ok })}
            </span>
          )}
          {stats.waiting > 0 && (
            <span className="rounded bg-st-waiting-soft px-1.5 py-0.5 text-st-waiting">
              {fill(t.automations.flow.statsWaiting, { n: stats.waiting })}
            </span>
          )}
          {stats.failed > 0 && (
            <span className="rounded bg-danger-soft px-1.5 py-0.5 text-danger">
              {fill(t.automations.flow.statsFailed, { n: stats.failed })}
            </span>
          )}
        </div>
      )}
      {outputs.map((h, i) => {
        const left = `${((i + 1) / (outputs.length + 1)) * 100}%`;
        return (
          <div key={h}>
            <Handle type="source" position={Position.Bottom} id={h} style={{ left }} />
            {(branching || !used.has(h)) && (
              <div
                className="pointer-events-none absolute top-full flex -translate-x-1/2 flex-col items-center gap-1.5 pt-2"
                style={{ left }}
                dir="ltr"
              >
                {branching && (
                  <span className="max-w-[96px] truncate rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-semibold text-ink-700 shadow-card" dir={dir}>
                    {handleLabel(t.automations, h, node.config)}
                  </span>
                )}
                {!used.has(h) && (
                  <span className="pointer-events-auto">
                    <AddButton label={t.automations.flow.addStep} onClick={() => props.onAddFrom(id, h, null)} />
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

const nodeTypes = { trigger: TriggerNode, step: StepNode };

/* -------------------------------------------------------------------------
   Edges
   ------------------------------------------------------------------------- */

function FlowEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
}: EdgeProps) {
  const { t } = useI18n();
  const { props, edgeByKey } = useCanvas();
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
    offset: 24,
  });
  const edge = edgeByKey.get(id);
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={24} />
      {edge && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex items-center gap-1"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <button
              type="button"
              title={t.automations.flow.insertStep}
              aria-label={t.automations.flow.insertStep}
              onClick={() => props.onInsertOnEdge(edge, { x: labelX - NODE_W / 2, y: labelY })}
              className="grid h-6 w-6 place-items-center rounded-full border border-line bg-surface text-ink-500 shadow-card transition-colors hover:border-brand-600 hover:bg-brand-50 hover:text-brand-700"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            {selected && (
              <button
                type="button"
                title={t.automations.flow.removeConnection}
                aria-label={t.automations.flow.removeConnection}
                onClick={() => props.onRemoveEdge(edge)}
                className="grid h-6 w-6 place-items-center rounded-full border border-danger/40 bg-surface text-danger shadow-card hover:bg-danger-soft"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { flow: FlowEdgeView };
