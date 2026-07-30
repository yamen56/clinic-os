"use client";

import { useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { useAutosave } from "@/lib/use-autosave";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Toggle, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { SaveIndicator } from "@/components/ui/save-indicator";
import { useToast } from "@/components/ui/toast";
import { toggleAutomationAction } from "./actions";
import { Workflow, Plus, ChevronRight, History, AlertTriangle, Clock } from "lucide-react";

type Automation = {
  id: string;
  name: string;
  description: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  active: boolean;
  recipe_key: string | null;
  step_count: number;
  run_count: number;
  failed_count: number;
};

export function AutomationsClient({
  slug,
  isOwner,
  automations,
  windowStart,
  windowEnd,
}: {
  slug: string;
  isOwner: boolean;
  automations: Automation[];
  windowStart: string;
  windowEnd: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [, start] = useTransition();
  const { patch, state } = useAutosave({ url: `/api/c/${slug}/clinic`, entityKey: `msgwindow:${slug}` });

  /*
    Enabling an automation moves its row between the two sections, so the knob
    alone moving instantly is not enough — the row has to travel with it.
    React drops the optimistic value once the transition ends, at which point
    the refreshed server data is already in place, and a failed write simply
    leaves the row where it was.
  */
  const [shown, setShown] = useOptimistic(
    automations,
    (rows: Automation[], change: { id: string; active: boolean }) =>
      rows.map((a) => (a.id === change.id ? { ...a, active: change.active } : a))
  );

  const active = shown.filter((a) => a.active);
  const inactive = shown.filter((a) => !a.active);

  const triggerLabel = (a: Automation) => {
    const base = (t.automations.triggers as Record<string, string>)[a.trigger_type] ?? a.trigger_type;
    const cfg = a.trigger_config ?? {};
    if (a.trigger_type === "before_appointment" && cfg.hours) return `${base} · ${cfg.hours}h`;
    if (a.trigger_type === "after_last_visit" && cfg.days) return `${base} · ${cfg.days}d`;
    if (a.trigger_type === "invoice_unpaid" && cfg.days) return `${base} · ${cfg.days}d`;
    if (a.trigger_type === "appointment_status_changed" && cfg.status) return `${base}: ${cfg.status}`;
    if (a.trigger_type === "inbound_message" && cfg.keyword) return `${base}: "${cfg.keyword}"`;
    return base;
  };

  const row = (a: Automation) => (
    <li key={a.id} className={`transition-opacity duration-140 ${a.active ? "" : "opacity-70"}`}>
      <div className="flex items-center gap-3 px-5 py-3.5">
        <Toggle
          checked={a.active}
          label={t.automations.enable}
          onChange={(v) =>
            start(async () => {
              setShown({ id: a.id, active: v });
              await toggleAutomationAction(slug, a.id, v);
              toast(v ? t.automations.enabled : t.automations.disabled);
              router.refresh();
            })
          }
        />
        <Link href={`/c/${slug}/automations/${a.id}`} className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{a.name}</span>
            {a.failed_count > 0 && (
              <Badge status="danger">
                <AlertTriangle className="h-3 w-3" />
                {a.failed_count}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate text-[13px] text-ink-500">
            {triggerLabel(a)} · {a.step_count} {t.automations.thenDo.toLowerCase()}
            {a.run_count > 0 ? ` · ${a.run_count} ${t.automations.runs}` : ""}
          </div>
        </Link>
        <Link
          href={`/c/${slug}/automations/${a.id}?tab=history`}
          className="hidden items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] text-ink-500 hover:bg-ink-900/5 sm:flex"
        >
          <History className="h-3.5 w-3.5" />
          {t.automations.history}
        </Link>
        <Link href={`/c/${slug}/automations/${a.id}`} className="text-ink-300 hover:text-ink-700">
          <ChevronRight className="h-4.5 w-4.5 rtl:rotate-180" />
        </Link>
      </div>
    </li>
  );

  return (
    <>
      <PageHeader
        title={t.automations.title}
        sub={t.automations.sub}
        action={
          <Link href={`/c/${slug}/automations/new`}>
            <Button>
              <Plus className="h-4 w-4" />
              {t.automations.newAutomation}
            </Button>
          </Link>
        }
      />

      {automations.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title={t.automations.empty}
          body={t.automations.emptyBody}
          action={
            <Link href={`/c/${slug}/automations/new`}>
              <Button>{t.automations.newAutomation}</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4">
          {active.length > 0 && (
            <Card>
              <CardHeader title={t.automations.enabled} />
              <ul className="divide-y divide-line">{active.map(row)}</ul>
            </Card>
          )}
          {inactive.length > 0 && (
            <Card>
              <CardHeader title={t.automations.recipes} sub={t.automations.recipesSub} />
              <ul className="divide-y divide-line">{inactive.map(row)}</ul>
            </Card>
          )}
        </div>
      )}

      <Card className="mt-4">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-ink-400" />
              {t.automations.sendingWindow}
            </span>
          }
          sub={t.automations.sendingWindowSub}
          action={<SaveIndicator state={state} />}
        />
        <div className="flex items-center gap-3 px-5 py-4">
          <Input
            type="time"
            defaultValue={windowStart}
            disabled={!isOwner}
            className="!w-auto"
            onChange={(e) => patch({ message_window_start: e.target.value })}
          />
          <span className="text-ink-400">–</span>
          <Input
            type="time"
            defaultValue={windowEnd}
            disabled={!isOwner}
            className="!w-auto"
            onChange={(e) => patch({ message_window_end: e.target.value })}
          />
        </div>
      </Card>
    </>
  );
}
