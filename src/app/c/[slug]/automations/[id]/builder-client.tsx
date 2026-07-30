"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateTime, fmtRelative } from "@/lib/dates";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, Toggle } from "@/components/ui/input";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { EmptyState, Tabs, Avatar } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  saveAutomationAction,
  deleteAutomationAction,
  testRunAction,
  type StepInput,
} from "../actions";
import {
  Zap, Clock, GitBranch, Tag, TagsIcon, ListTodo, BellRing, ArrowRightLeft, Square,
  Plus, Trash2, ChevronDown, ChevronUp, Play, History, FileSignature,
} from "lucide-react";

const STEP_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  send_whatsapp: Zap,
  wait: Clock,
  condition: GitBranch,
  add_tag: Tag,
  remove_tag: TagsIcon,
  create_task: ListTodo,
  notify_staff: BellRing,
  goto_automation: ArrowRightLeft,
  send_document: FileSignature,
  stop: Square,
};

const TRIGGERS = [
  "appointment_created", "appointment_status_changed", "before_appointment", "after_last_visit",
  "patient_created", "tag_added", "tag_removed", "birthday", "invoice_sent", "invoice_unpaid",
  "inbound_message", "booking_submitted",
  "document_sent", "document_viewed", "document_signed", "document_completed",
  "document_declined", "document_unsigned", "document_expired",
] as const;

const STEP_TYPES = [
  "send_whatsapp", "wait", "condition", "add_tag", "remove_tag",
  "create_task", "notify_staff", "goto_automation", "send_document", "stop",
] as const;

type Automation = {
  id: string;
  name: string;
  description: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  active: boolean;
};

type Run = {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  patient_name: string | null;
  logs: { status: string; detail: Record<string, unknown>; at: string; step: string | null }[] | null;
};

const runBadge: Record<string, StatusKey> = {
  running: "scheduled",
  waiting: "pending",
  completed: "confirmed",
  failed: "no_show",
  cancelled: "cancelled",
};

export function BuilderClient({
  slug,
  tz,
  automation,
  initialSteps,
  runs,
  services,
  otherAutomations,
  docTemplates,
  initialTab,
}: {
  slug: string;
  tz: string;
  automation: Automation | null;
  initialSteps: StepInput[];
  runs: Run[];
  services: { id: string; name: string; name_ar: string | null }[];
  otherAutomations: { id: string; name: string }[];
  docTemplates: { id: string; name: string; name_ar: string | null }[];
  initialTab: "flow" | "history";
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [tab, setTab] = useState(initialTab);
  const [name, setName] = useState(automation?.name ?? "");
  const [triggerType, setTriggerType] = useState(automation?.trigger_type ?? "appointment_created");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>(
    automation?.trigger_config ?? {}
  );
  const [steps, setSteps] = useState<StepInput[]>(initialSteps);
  const [active, setActive] = useState(automation?.active ?? false);
  const [pending, start] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);

  const save = () =>
    start(async () => {
      const r = await saveAutomationAction(slug, {
        id: automation?.id,
        name: name.trim() || t.automations.newAutomation,
        description: "",
        triggerType,
        triggerConfig,
        steps,
        active,
      });
      if (r.error || !r.id) {
        toast(t.common.genericError, "error");
        return;
      }
      toast(t.automations.saved);
      if (!automation) router.replace(`/c/${slug}/automations/${r.id}`);
      else router.refresh();
    });

  return (
    <>
      <PageHeader
        title={
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.automations.newAutomation}
            className="min-w-56 rounded-md border border-transparent bg-transparent text-xl font-semibold tracking-tight outline-none hover:border-line focus:border-brand-500 focus:bg-surface"
          />
        }
        action={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 pe-1">
              <Toggle checked={active} onChange={setActive} label={t.automations.enable} />
              <span className="text-[13px] font-medium">
                {active ? t.automations.enabled : t.automations.disabled}
              </span>
            </label>
            {automation && (
              <>
                <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
                  <Play className="h-4 w-4" />
                  {t.automations.testRun}
                </Button>
                <Button variant="ghost" size="sm" className="!text-danger" onClick={() => setDeleteOpen(true)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
            <Button onClick={save} loading={pending}>
              {t.common.save}
            </Button>
          </div>
        }
      />

      {automation && (
        <div className="mb-5">
          <Tabs
            tabs={[
              { key: "flow", label: t.automations.editFlow },
              { key: "history", label: t.automations.history, count: runs.length },
            ]}
            active={tab}
            onChange={(k) => setTab(k as "flow" | "history")}
          />
        </div>
      )}

      {tab === "flow" ? (
        <div className="mx-auto max-w-2xl">
          {/* Trigger */}
          <Card className="p-5">
            <div className="eyebrow mb-3">
              {t.automations.trigger}
            </div>
            <Select value={triggerType} onChange={(e) => { setTriggerType(e.target.value); setTriggerConfig({}); }}>
              {TRIGGERS.map((tr) => (
                <option key={tr} value={tr}>
                  {(t.automations.triggers as Record<string, string>)[tr]}
                </option>
              ))}
            </Select>
            <TriggerConfig
              type={triggerType}
              config={triggerConfig}
              onChange={setTriggerConfig}
            />
          </Card>

          <Connector />

          <StepList
            steps={steps}
            onChange={setSteps}
            services={services}
            otherAutomations={otherAutomations}
            docTemplates={docTemplates}
            depth={0}
          />
        </div>
      ) : (
        <RunHistory runs={runs} tz={tz} locale={locale} />
      )}

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t.automations.deleteAutomation}
        body={t.common.confirmDeleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={async () => {
          if (automation) {
            await deleteAutomationAction(slug, automation.id);
            router.push(`/c/${slug}/automations`);
          }
        }}
      />

      {automation && (
        <TestRunModal
          open={testOpen}
          onClose={() => setTestOpen(false)}
          slug={slug}
          automationId={automation.id}
        />
      )}
    </>
  );
}

function Connector() {
  return <div className="mx-auto h-6 w-px bg-line-strong" />;
}

function TriggerConfig({
  type,
  config,
  onChange,
}: {
  type: string;
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  if (type === "before_appointment") {
    return (
      <div className="mt-3">
        <Field label={t.automations.hours}>
          <Input type="number" dir="ltr" min={1} max={720}
            value={String(config.hours ?? 24)}
            onChange={(e) => onChange({ ...config, hours: Number(e.target.value) || 24 })} />
        </Field>
      </div>
    );
  }
  if (type === "after_last_visit" || type === "invoice_unpaid" || type === "document_unsigned") {
    const fallback = type === "after_last_visit" ? 180 : 3;
    return (
      <div className="mt-3">
        <Field label={t.automations.days}>
          <Input type="number" dir="ltr" min={1} max={3650}
            value={String(config.days ?? fallback)}
            onChange={(e) => onChange({ ...config, days: Number(e.target.value) || 1 })} />
        </Field>
      </div>
    );
  }
  if (type === "appointment_status_changed") {
    return (
      <div className="mt-3">
        <Field label={t.automations.status}>
          <Select value={String(config.status ?? "")} onChange={(e) => onChange({ ...config, status: e.target.value })}>
            <option value="">{t.common.all}</option>
            {["confirmed", "completed", "no_show", "cancelled"].map((s) => (
              <option key={s} value={s}>
                {(t.calendar.statuses as Record<string, string>)[s]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    );
  }
  if (type === "tag_added" || type === "tag_removed") {
    return (
      <div className="mt-3">
        <Field label={t.automations.tag}>
          <Input value={String(config.tag ?? "")} onChange={(e) => onChange({ ...config, tag: e.target.value })} />
        </Field>
      </div>
    );
  }
  if (type === "inbound_message") {
    return (
      <div className="mt-3">
        <Field label={t.automations.keyword}>
          <Input value={String(config.keyword ?? "")} onChange={(e) => onChange({ ...config, keyword: e.target.value })} />
        </Field>
      </div>
    );
  }
  return null;
}

function StepList({
  steps,
  onChange,
  services,
  otherAutomations,
  docTemplates,
  depth,
}: {
  steps: StepInput[];
  onChange: (s: StepInput[]) => void;
  services: { id: string; name: string; name_ar: string | null }[];
  otherAutomations: { id: string; name: string }[];
  docTemplates: { id: string; name: string; name_ar: string | null }[];
  depth: number;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);

  const addStep = (type: string) => {
    const base: StepInput = {
      step_type: type,
      config: type === "wait" ? { minutes: 60 } : {},
      ...(type === "condition" ? { children: { yes: [], no: [] } } : {}),
    };
    onChange([...steps, base]);
    setAdding(false);
  };

  return (
    <div>
      {steps.map((s, i) => (
        <div key={i}>
          {i > 0 && <Connector />}
          <StepCard
            step={s}
            services={services}
            otherAutomations={otherAutomations}
            docTemplates={docTemplates}
            depth={depth}
            onChange={(next) => onChange(steps.map((x, j) => (j === i ? next : x)))}
            onDelete={() => onChange(steps.filter((_, j) => j !== i))}
            onMoveUp={i > 0 ? () => {
              const next = [...steps];
              [next[i - 1], next[i]] = [next[i], next[i - 1]];
              onChange(next);
            } : undefined}
            onMoveDown={i < steps.length - 1 ? () => {
              const next = [...steps];
              [next[i], next[i + 1]] = [next[i + 1], next[i]];
              onChange(next);
            } : undefined}
          />
        </div>
      ))}
      {steps.length > 0 && <Connector />}
      {adding ? (
        <Card className="grid gap-1 p-2">
          {STEP_TYPES.map((type) => {
            const Icon = STEP_ICONS[type];
            return (
              <button
                key={type}
                onClick={() => addStep(type)}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm hover:bg-sunken"
              >
                <Icon className="h-4 w-4 text-ink-400" />
                {(t.automations.steps as Record<string, string>)[type]}
              </button>
            );
          })}
          <button onClick={() => setAdding(false)} className="px-3 py-1.5 text-start text-[13px] text-ink-500">
            {t.common.cancel}
          </button>
        </Card>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-line-strong bg-surface/50 py-3 text-sm font-medium text-ink-500 transition-colors hover:border-brand-400 hover:text-brand-700"
        >
          <Plus className="h-4 w-4" />
          {t.automations.addStep}
        </button>
      )}
    </div>
  );
}

function StepCard({
  step,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  services,
  otherAutomations,
  docTemplates,
  depth,
}: {
  step: StepInput;
  onChange: (s: StepInput) => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  services: { id: string; name: string; name_ar: string | null }[];
  otherAutomations: { id: string; name: string }[];
  docTemplates: { id: string; name: string; name_ar: string | null }[];
  depth: number;
}) {
  const { t, locale } = useI18n();
  const Icon = STEP_ICONS[step.step_type] ?? Zap;
  const cfg = step.config ?? {};
  const setCfg = (patch: Record<string, unknown>) => onChange({ ...step, config: { ...cfg, ...patch } });

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5">
        <Icon className="h-4 w-4 text-brand-600" />
        <span className="flex-1 text-[13px] font-semibold">
          {(t.automations.steps as Record<string, string>)[step.step_type]}
        </span>
        {onMoveUp && (
          <button onClick={onMoveUp} aria-label="up" className="text-ink-300 hover:text-ink-700">
            <ChevronUp className="h-4 w-4" />
          </button>
        )}
        {onMoveDown && (
          <button onClick={onMoveDown} aria-label="down" className="text-ink-300 hover:text-ink-700">
            <ChevronDown className="h-4 w-4" />
          </button>
        )}
        <button onClick={onDelete} aria-label={t.common.delete} className="text-ink-300 hover:text-danger">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="grid gap-3 p-4">
        {step.step_type === "send_whatsapp" && (
          <Field label={t.automations.message} hint={t.automations.messageHint}>
            <Textarea
              value={String(cfg.message ?? "")}
              onChange={(e) => setCfg({ message: e.target.value })}
              className="min-h-24"
            />
          </Field>
        )}
        {step.step_type === "wait" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.automations.waitMinutes}>
              <Input type="number" dir="ltr" min={0}
                value={String(cfg.minutes ?? 60)}
                onChange={(e) => setCfg({ minutes: Number(e.target.value) || 0 })} />
            </Field>
            <Field label={t.automations.untilTime} hint={t.common.optional}>
              <Input type="time" value={String(cfg.until_time ?? "")}
                onChange={(e) => setCfg({ until_time: e.target.value })} />
            </Field>
          </div>
        )}
        {(step.step_type === "add_tag" || step.step_type === "remove_tag") && (
          <Field label={t.automations.tag}>
            <Input value={String(cfg.tag ?? "")} onChange={(e) => setCfg({ tag: e.target.value })} />
          </Field>
        )}
        {step.step_type === "create_task" && (
          <>
            <Field label={t.automations.taskTitle}>
              <Input value={String(cfg.title ?? "")} onChange={(e) => setCfg({ title: e.target.value })} />
            </Field>
            <Field label={t.common.notes}>
              <Textarea value={String(cfg.body ?? "")} onChange={(e) => setCfg({ body: e.target.value })} />
            </Field>
          </>
        )}
        {step.step_type === "notify_staff" && (
          <>
            <Field label={t.automations.notifyTitle}>
              <Input value={String(cfg.title ?? "")} onChange={(e) => setCfg({ title: e.target.value })} />
            </Field>
            <Field label={t.common.notes}>
              <Input value={String(cfg.body ?? "")} onChange={(e) => setCfg({ body: e.target.value })} />
            </Field>
          </>
        )}
        {step.step_type === "send_document" && (
          <Field label={t.automations.documentTemplate}>
            <Select
              value={String(cfg.template_id ?? "")}
              onChange={(e) => setCfg({ template_id: e.target.value })}
            >
              <option value="">—</option>
              {docTemplates.map((d) => (
                <option key={d.id} value={d.id}>
                  {locale === "ar" ? d.name_ar || d.name : d.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {step.step_type === "goto_automation" && (
          <Field label={t.automations.steps.goto_automation}>
            <Select value={String(cfg.automation_id ?? "")} onChange={(e) => setCfg({ automation_id: e.target.value })}>
              <option value="">—</option>
              {otherAutomations.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          </Field>
        )}
        {step.step_type === "condition" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t.automations.steps.condition}>
                <Select value={String(cfg.kind ?? "has_tag")} onChange={(e) => setCfg({ kind: e.target.value })}>
                  {Object.entries(t.automations.conditions).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              {cfg.kind === "appointment_status" ? (
                <Field label={t.automations.status}>
                  <Select value={String(cfg.status ?? "confirmed")} onChange={(e) => setCfg({ status: e.target.value })}>
                    {["confirmed", "completed", "no_show", "cancelled"].map((s) => (
                      <option key={s} value={s}>{(t.calendar.statuses as Record<string, string>)[s]}</option>
                    ))}
                  </Select>
                </Field>
              ) : (cfg.kind ?? "has_tag") === "has_tag" ? (
                <Field label={t.automations.tag}>
                  <Input value={String(cfg.tag ?? "")} onChange={(e) => setCfg({ tag: e.target.value })} />
                </Field>
              ) : null}
            </div>
            {depth < 2 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {(["yes", "no"] as const).map((branch) => (
                  <div key={branch} className="rounded-xl border border-line bg-subtle p-3">
                    <div className={`mb-2 text-[12px] font-semibold ${branch === "yes" ? "text-brand-700" : "text-ink-500"}`}>
                      {branch === "yes" ? t.automations.yes : t.automations.no}
                    </div>
                    <StepList
                      steps={step.children?.[branch] ?? []}
                      onChange={(next) =>
                        onChange({
                          ...step,
                          children: {
                            yes: branch === "yes" ? next : (step.children?.yes ?? []),
                            no: branch === "no" ? next : (step.children?.no ?? []),
                          },
                        })
                      }
                      services={services}
                      otherAutomations={otherAutomations}
                      docTemplates={docTemplates}
                      depth={depth + 1}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function RunHistory({ runs, tz, locale }: { runs: Run[]; tz: string; locale: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);

  if (runs.length === 0) {
    return <EmptyState icon={<History />} title={t.automations.noRuns} body={t.automations.noRunsBody} />;
  }

  return (
    <Card>
      <ul className="divide-y divide-line">
        {runs.map((r) => (
          <li key={r.id}>
            <button
              onClick={() => setOpen(open === r.id ? null : r.id)}
              className="flex w-full items-center gap-3 px-5 py-3 text-start hover:bg-sunken"
            >
              <Badge status={runBadge[r.status] ?? "neutral"}>
                {(t.automations.runStatus as Record<string, string>)[r.status] ?? r.status}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-sm">{r.patient_name ?? "—"}</span>
              <span className="text-[12px] text-ink-400" suppressHydrationWarning>
                {fmtRelative(r.started_at, locale)}
              </span>
              <ChevronDown className={`h-4 w-4 text-ink-300 transition-transform ${open === r.id ? "rotate-180" : ""}`} />
            </button>
            {open === r.id && (
              <div className="border-t border-line bg-subtle px-5 py-3">
                {r.error && (
                  <p className="mb-2 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">{r.error}</p>
                )}
                <ol className="grid gap-1.5">
                  {(r.logs ?? []).map((l, i) => (
                    <li key={i} className="flex items-center gap-2.5 text-[13px]">
                      <Badge
                        status={l.status === "ok" ? "confirmed" : l.status === "failed" ? "no_show" : "neutral"}
                      >
                        {(t.automations.stepResult as Record<string, string>)[l.status] ?? l.status}
                      </Badge>
                      <span className="flex-1">
                        {l.step ? (t.automations.steps as Record<string, string>)[l.step] ?? l.step : "—"}
                      </span>
                      <span className="text-ink-400" suppressHydrationWarning>
                        {fmtDateTime(l.at, tz, locale)}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
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

  return (
    <Modal open={open} onClose={onClose} title={t.automations.testRun}>
      <p className="mb-3 text-[13px] text-ink-500">{t.automations.testRunHint}</p>
      <Input
        value={q}
        placeholder={t.patients.searchPlaceholder}
        onChange={async (e) => {
          const val = e.target.value;
          setQ(val);
          if (val.trim().length < 2) return setResults([]);
          const res = await fetch(`/api/c/${slug}/patients/search?q=${encodeURIComponent(val)}`);
          if (res.ok) setResults((await res.json()).results ?? []);
        }}
      />
      <div className="mt-2 grid gap-1">
        {results.map((r) => (
          <button
            key={r.id}
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
