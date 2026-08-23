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
import { EmptyState, Tabs } from "@/components/ui/misc";
import { SaveIndicator } from "@/components/ui/save-indicator";
import { useToast } from "@/components/ui/toast";
import { toggleAutomationAction } from "./actions";
import { SystemMessagesCard } from "./system-messages-card";
import { StaffAlertsCard } from "./staff-alerts-card";
import { SYSTEM_MESSAGES, type SystemMessageState } from "@/lib/system-messages";
import type { StaffAlert } from "@/lib/staff-alerts";
import type { Specialty } from "@/lib/specialties";
import { Workflow, Plus, ChevronRight, History, AlertTriangle, Clock, Stethoscope } from "lucide-react";

type Automation = {
  id: string;
  name: string;
  description: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  active: boolean;
  recipe_key: string | null;
  recipe_specialty: string;
  step_count: number;
  run_count: number;
  failed_count: number;
};

export function AutomationsClient({
  slug,
  isOwner,
  specialty,
  automations,
  messages,
  alerts,
  windowStart,
  windowEnd,
}: {
  slug: string;
  isOwner: boolean;
  specialty: Specialty;
  automations: Automation[];
  messages: Record<string, SystemMessageState>;
  alerts: StaffAlert[];
  windowStart: string;
  windowEnd: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [, start] = useTransition();
  const { patch, state } = useAutosave({ url: `/api/c/${slug}/clinic`, entityKey: `msgwindow:${slug}` });

  /*
    Three tabs rather than one long page. Everything that sends on its own now
    lives here — flows, the platform's own messages, the team's alerts — and
    stacked into one column that is a scroll long enough that the bottom third
    would never be found. The counts are on the tabs precisely so nobody has to
    open one to discover whether it holds anything.
  */
  const [tab, setTab] = useState<"flows" | "messages" | "alerts">("flows");

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
  // Split so a clinic can tell at a glance which flows were written for its own
  // field. Anything already switched on stays in the "on" list — where it is
  // running matters more than where it came from.
  const inactiveGeneral = inactive.filter((a) => (a.recipe_specialty ?? "general") === "general");
  const inactiveSpecialty = inactive.filter((a) => (a.recipe_specialty ?? "general") !== "general");

  const triggerLabel = (a: Automation) => {
    const base = (t.automations.triggers as Record<string, string>)[a.trigger_type] ?? a.trigger_type;
    const cfg = a.trigger_config ?? {};
    if (a.trigger_type === "before_appointment" && cfg.hours) return `${base} · ${cfg.hours}h`;
    if (a.trigger_type === "after_last_visit" && cfg.days) return `${base} · ${cfg.days}d`;
    if (a.trigger_type === "invoice_unpaid" && cfg.days) return `${base} · ${cfg.days}d`;
    if (a.trigger_type === "appointment_status_changed" && cfg.status) return `${base}: ${cfg.status}`;
    if (a.trigger_type === "inbound_message" && cfg.keyword) return `${base}: "${cfg.keyword}"`;
    if (a.trigger_type === "tag_added" && cfg.tag) return `${base}: "${cfg.tag}"`;
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
          {/*
            min-w-0 here as well as on the Link. A flex item's floor is its
            content width unless it is told otherwise, so without this the
            truncate below never truncates: the name simply pushes the row wider
            than the phone, and the whole page starts scrolling sideways.
          */}
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold">{a.name}</span>
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

      <div className="mb-4">
        <Tabs
          tabs={[
            { key: "flows", label: t.automations.tabFlows, count: active.length },
            { key: "messages", label: t.automations.tabMessages, count: SYSTEM_MESSAGES.length },
            { key: "alerts", label: t.automations.tabAlerts, count: alerts.length },
          ]}
          active={tab}
          onChange={(k) => setTab(k as typeof tab)}
        />
      </div>

      {tab === "flows" && (
        <>
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
            <div className="grid grid-cols-1 gap-4">
              {/*
                grid-cols-1, not a bare grid. A grid's implicit column is sized
                `auto`, whose floor is the min-content width of what it holds — and a
                row whose trigger line is `truncate` (so, nowrap) has a min-content
                of whatever that text measures. The card therefore refused to be
                narrower than its longest automation, pushed past the edge of the
                phone, and took the page's whole layout width with it. `grid-cols-1`
                is `minmax(0, 1fr)`: the floor becomes zero and the truncation that
                was asked for all along finally happens.
              */}
              {active.length > 0 && (
                <Card>
                  <CardHeader title={t.automations.enabled} />
                  <ul className="divide-y divide-line">{active.map(row)}</ul>
                </Card>
              )}
              {inactiveSpecialty.length > 0 && (
                <Card>
                  <CardHeader
                    title={
                      <span className="flex items-center gap-2">
                        <Stethoscope className="h-4 w-4 text-ink-400" />
                        {t.automations.specialtyPack.replace("{specialty}", t.specialties[specialty])}
                      </span>
                    }
                    sub={t.automations.specialtyPackSub}
                  />
                  <ul className="divide-y divide-line">{inactiveSpecialty.map(row)}</ul>
                </Card>
              )}
              {inactiveGeneral.length > 0 && (
                <Card>
                  <CardHeader title={t.automations.recipes} sub={t.automations.recipesSub} />
                  <ul className="divide-y divide-line">{inactiveGeneral.map(row)}</ul>
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
            {/* Two native time inputs are ~138px each whatever we ask for, which
                with the gaps and padding does not fit a 320px phone. Wrap rather
                than hold the card open. */}
            <div className="flex flex-wrap items-center gap-3 px-5 py-4">
              <Input
                type="time"
                defaultValue={windowStart}
                disabled={!isOwner}
                className="!w-auto min-w-0 max-w-full"
                onChange={(e) => patch({ message_window_start: e.target.value })}
              />
              <span className="text-ink-400">–</span>
              <Input
                type="time"
                defaultValue={windowEnd}
                disabled={!isOwner}
                className="!w-auto min-w-0 max-w-full"
                onChange={(e) => patch({ message_window_end: e.target.value })}
              />
            </div>
          </Card>
        </>
      )}

      {tab === "messages" && <SystemMessagesCard slug={slug} messages={messages} />}

      {tab === "alerts" && <StaffAlertsCard slug={slug} alerts={alerts} />}
    </>
  );
}
