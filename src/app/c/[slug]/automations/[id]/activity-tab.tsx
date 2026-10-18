"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, History, OctagonX } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateTime, fmtRelative } from "@/lib/dates";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { FlowNode } from "@/lib/automation/graph";
import type { RunRow } from "@/lib/automation/store";
import { cancelRunAction, cancelWaitingRunsAction, loadRunsAction } from "../actions";
import { fill, handleLabel } from "../flow-meta";

const runBadge: Record<string, StatusKey> = {
  running: "scheduled",
  waiting: "pending",
  completed: "confirmed",
  failed: "no_show",
  cancelled: "cancelled",
};

const FILTERS = ["", "waiting", "running", "completed", "failed", "cancelled"] as const;
const PAGE = 40;

export function ActivityTab({
  slug,
  automationId,
  initialRuns,
  tz,
  nodes,
}: {
  slug: string;
  automationId: string;
  initialRuns: RunRow[];
  tz: string;
  nodes: FlowNode[];
}) {
  const { t, locale } = useI18n();
  const f = t.automations.flow;
  const { toast } = useToast();
  const [runs, setRuns] = useState(initialRuns);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("");
  const [more, setMore] = useState(initialRuns.length >= PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [pending, start] = useTransition();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const load = (status: string, before: string | null) =>
    start(async () => {
      const r = await loadRunsAction(slug, automationId, { status, before });
      const got = r.runs ?? [];
      setRuns((cur) => (before ? [...cur, ...got] : got));
      setMore(got.length >= PAGE);
    });

  const stepName = (stepId: string | null, type: string | null) => {
    const n = stepId ? byId.get(stepId) : null;
    if (n?.label) return n.label;
    const key = n?.type ?? type;
    return key ? ((t.automations.steps as Record<string, string>)[key] ?? key) : "—";
  };

  const describe = (log: RunRow["logs"][number]): string => {
    const d = log.detail ?? {};
    const parts: string[] = [];
    if (typeof d.exited === "string") {
      parts.push(fill(f.exitedBecause, { reason: (f.exit as Record<string, string>)[d.exited] ?? d.exited }));
    }
    if (typeof d.branch === "string") {
      const node = log.step_id ? byId.get(log.step_id) : null;
      parts.push(fill(f.tookBranch, { branch: handleLabel(t.automations, d.branch, node?.config ?? {}) }));
    }
    if (typeof d.reply === "string") parts.push(fill(f.replyWas, { text: d.reply }));
    if (typeof d.reason === "string") parts.push((f.reasons as Record<string, string>)[d.reason] ?? d.reason);
    if (typeof d.error === "string") parts.push(d.error);
    if (typeof d.title === "string" && log.status === "ok") parts.push(d.title);
    return parts.join(" · ");
  };

  const hasWaiting = runs.some((r) => r.status === "waiting" || r.status === "running");

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((s) => (
            <button
              key={s || "all"}
              type="button"
              aria-pressed={filter === s}
              onClick={() => {
                setFilter(s);
                load(s, null);
              }}
              className={`rounded-full border px-3 py-1 text-[12px] font-medium ${
                filter === s ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line bg-surface text-ink-700 hover:border-line-strong"
              }`}
            >
              {s ? (t.automations.runStatus as Record<string, string>)[s] : f.all}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {hasWaiting && (
          <Button variant="outline" size="sm" onClick={() => setConfirmAll(true)}>
            <OctagonX className="h-4 w-4" />
            {f.cancelAll}
          </Button>
        )}
      </div>

      {runs.length === 0 ? (
        <EmptyState icon={<History />} title={t.automations.noRuns} body={t.automations.noRunsBody} />
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
          <ul className="divide-y divide-line">
            {runs.map((r) => {
              const live = r.status === "waiting" || r.status === "running";
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(open === r.id ? null : r.id)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-sunken"
                  >
                    <Badge status={runBadge[r.status] ?? "neutral"}>
                      {(t.automations.runStatus as Record<string, string>)[r.status] ?? r.status}
                    </Badge>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {r.patient_name ?? f.noPatient}
                        {r.test && <span className="ms-2 rounded bg-sunken px-1.5 py-0.5 text-[11px] text-ink-500">{f.test}</span>}
                      </span>
                      {r.status === "waiting" && (
                        <span className="block truncate text-[12px] text-ink-500" suppressHydrationWarning>
                          {stepName(r.current_step_id, null)}
                          {r.wake_at ? ` · ${fill(f.nextStepAt, { when: fmtRelative(r.wake_at, locale) })}` : ""}
                        </span>
                      )}
                    </span>
                    <span className="hidden text-[12px] text-ink-400 sm:block" suppressHydrationWarning>
                      {fmtRelative(r.started_at, locale)}
                    </span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-ink-300 transition-transform ${open === r.id ? "rotate-180" : ""}`} />
                  </button>
                  {open === r.id && (
                    <div className="border-t border-line bg-subtle px-4 py-3">
                      {r.error && !["step_removed", "cancelled_by_staff", "automation_off", "module_off", "duplicate", "stalled"].includes(r.error) && (
                        <p className="mb-2 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">{r.error}</p>
                      )}
                      <ol className="grid gap-2">
                        {r.logs.map((l, i) => {
                          const text = describe(l);
                          return (
                            <li key={i} className="flex items-start gap-2.5 text-[13px]">
                              <Badge status={l.status === "ok" ? "confirmed" : l.status === "failed" ? "no_show" : l.status === "waiting" ? "pending" : "neutral"}>
                                {(t.automations.stepResult as Record<string, string>)[l.status] ?? l.status}
                              </Badge>
                              <span className="min-w-0 flex-1">
                                <span className="block font-medium">{l.step_id || l.step ? stepName(l.step_id, l.step) : "—"}</span>
                                {text && <span className="block break-words text-[12px] text-ink-500">{text}</span>}
                              </span>
                              <span className="shrink-0 text-[12px] text-ink-400" suppressHydrationWarning>
                                {fmtDateTime(l.at, tz, locale)}
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {r.patient_id && (
                          <Link href={`/c/${slug}/patients/${r.patient_id}`} className="text-[13px] font-medium text-brand-700 hover:underline">
                            {t.patients.notes.openPatientFile}
                          </Link>
                        )}
                        {live && (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() =>
                              start(async () => {
                                const res = await cancelRunAction(slug, r.id);
                                if (res.error) return toast(t.common.genericError, "error");
                                setRuns((cur) => cur.map((x) => (x.id === r.id ? { ...x, status: "cancelled" } : x)));
                                toast(fill(f.cancelledN, { n: res.cancelled ?? 0 }));
                              })
                            }
                            className="text-[13px] font-medium text-danger hover:underline"
                          >
                            {f.cancelRun}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {more && runs.length > 0 && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" loading={pending} onClick={() => load(filter, runs[runs.length - 1].started_at)}>
            {f.loadMore}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title={f.cancelAllTitle}
        body={f.cancelAllBody}
        confirmLabel={f.cancelAll}
        cancelLabel={t.common.cancel}
        loading={pending}
        onConfirm={() =>
          start(async () => {
            const res = await cancelWaitingRunsAction(slug, automationId);
            setConfirmAll(false);
            if (res.error) return toast(t.common.genericError, "error");
            setRuns((cur) => cur.map((x) => (x.status === "waiting" || x.status === "running" ? { ...x, status: "cancelled" } : x)));
            toast(fill(f.cancelledN, { n: res.cancelled ?? 0 }));
          })
        }
      />
    </div>
  );
}
