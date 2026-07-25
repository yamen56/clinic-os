"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, EmptyState } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { WeeklyHoursEditor } from "@/components/weekly-hours-editor";
import {
  saveAiSettingsAction,
  saveKnowledgeItemAction,
  deleteKnowledgeItemAction,
} from "./actions";
import {
  Sparkles, ShieldCheck, Plus, Pencil, Trash2, BookOpen, AlertTriangle, MessageCircle,
} from "lucide-react";

type Agent = {
  enabled: boolean;
  agent_name: string;
  instructions: string;
  language_mode: "match" | "ar" | "en";
  hours_mode: "always" | "after_hours" | "custom";
  custom_hours: Record<string, [string, string][]>;
  escalation_notes: string;
  max_daily_messages: number;
  model: string;
};

type KnowledgeItem = {
  id: string;
  category: string;
  title: string;
  content: string;
  active: boolean;
};

type UsageRow = {
  day: string;
  messages_out: number;
  bookings: number;
  escalations: number;
  input_tokens: string;
  output_tokens: string;
};

export function AiClient({
  slug,
  hasApiKey,
  waConnected,
  initialTab,
  agent: initialAgent,
  knowledge,
  usage,
}: {
  slug: string;
  hasApiKey: boolean;
  waConnected: boolean;
  initialTab: "setup" | "knowledge" | "usage";
  agent: Agent;
  knowledge: KnowledgeItem[];
  usage: UsageRow[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [tab, setTab] = useState(initialTab);
  const [a, setA] = useState(initialAgent);
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<Partial<KnowledgeItem> | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const save = (patch?: Partial<Agent>) =>
    start(async () => {
      const next = { ...a, ...patch };
      setA(next);
      const r = await saveAiSettingsAction(slug, {
        enabled: next.enabled,
        agentName: next.agent_name,
        instructions: next.instructions,
        languageMode: next.language_mode,
        hoursMode: next.hours_mode,
        customHours: next.custom_hours ?? {},
        escalationNotes: next.escalation_notes,
        maxDailyMessages: next.max_daily_messages,
        model: next.model,
      });
      if (r.error) {
        toast(t.common.genericError, "error");
        return;
      }
      toast(t.common.saved);
      router.refresh();
    });

  const filled = knowledge.filter((k) => k.content.trim()).length;
  const totals = usage.reduce(
    (acc, u) => ({
      messages: acc.messages + u.messages_out,
      bookings: acc.bookings + u.bookings,
      escalations: acc.escalations + u.escalations,
      tokens: acc.tokens + Number(u.input_tokens) + Number(u.output_tokens),
    }),
    { messages: 0, bookings: 0, escalations: 0, tokens: 0 }
  );

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Sparkles className="h-5 w-5 text-brand-600" />
            {t.ai.title}
          </span>
        }
        sub={t.ai.sub}
        action={
          <label className="flex items-center gap-2.5">
            <Toggle
              checked={a.enabled}
              disabled={!hasApiKey}
              onChange={(v) => save({ enabled: v })}
              label={t.ai.enable}
            />
            <Badge status={a.enabled ? "confirmed" : "neutral"} dot>
              {a.enabled ? t.ai.enabledOn : t.ai.enabledOff}
            </Badge>
          </label>
        }
      />

      {!hasApiKey && (
        <div className="mb-4 flex items-center gap-2.5 rounded-card border border-st-pending/30 bg-st-pending-soft px-4 py-3 text-[13px] text-st-pending">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t.ai.noKey}
        </div>
      )}
      {hasApiKey && a.enabled && !waConnected && (
        <div className="mb-4 flex items-center gap-2.5 rounded-card border border-st-pending/30 bg-st-pending-soft px-4 py-3 text-[13px] text-st-pending">
          <MessageCircle className="h-4 w-4 shrink-0" />
          {t.wa.disconnected} — {t.invoices.waDisconnected}
        </div>
      )}

      <Tabs
        tabs={[
          { key: "setup", label: t.ai.tabs.setup },
          { key: "knowledge", label: t.ai.tabs.knowledge, count: filled },
          { key: "usage", label: t.ai.tabs.usage },
        ]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
      />

      <div className="mt-5 grid gap-4">
        {tab === "setup" && (
          <>
            <Card className="p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t.ai.agentName} hint={t.ai.agentNameHint}>
                  <Input
                    value={a.agent_name}
                    onChange={(e) => setA({ ...a, agent_name: e.target.value })}
                    onBlur={() => save()}
                    placeholder="سارة"
                  />
                </Field>
                <Field label={t.ai.language}>
                  <Select
                    value={a.language_mode}
                    onChange={(e) => save({ language_mode: e.target.value as Agent["language_mode"] })}
                  >
                    {Object.entries(t.ai.languages).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="mt-4">
                <Field label={t.ai.instructions} hint={t.ai.instructionsHint}>
                  <Textarea
                    value={a.instructions}
                    onChange={(e) => setA({ ...a, instructions: e.target.value })}
                    onBlur={() => save()}
                    className="min-h-24"
                  />
                </Field>
              </div>
            </Card>

            <Card className="p-5">
              <Field label={t.ai.hours} hint={t.ai.hoursHint}>
                <Select
                  value={a.hours_mode}
                  onChange={(e) => save({ hours_mode: e.target.value as Agent["hours_mode"] })}
                >
                  {Object.entries(t.ai.hoursModes).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              {a.hours_mode === "custom" && (
                <div className="mt-4">
                  <WeeklyHoursEditor
                    value={
                      a.custom_hours && Object.keys(a.custom_hours).length
                        ? a.custom_hours
                        : { sun: [["17:00", "23:00"]], mon: [["17:00", "23:00"]], tue: [["17:00", "23:00"]], wed: [["17:00", "23:00"]], thu: [["17:00", "23:00"]], fri: [["09:00", "23:00"]], sat: [["09:00", "23:00"]] }
                    }
                    onChange={(v) => setA({ ...a, custom_hours: v })}
                  />
                  <div className="mt-3 flex justify-end">
                    <Button size="sm" onClick={() => save()} loading={pending}>
                      {t.common.save}
                    </Button>
                  </div>
                </div>
              )}
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label={t.ai.dailyCap}>
                  <Input
                    type="number" dir="ltr" min={1} max={5000}
                    value={a.max_daily_messages}
                    onChange={(e) => setA({ ...a, max_daily_messages: Number(e.target.value) || 200 })}
                    onBlur={() => save()}
                  />
                </Field>
                <Field label={t.ai.model}>
                  <Select value={a.model} onChange={(e) => save({ model: e.target.value })}>
                    <option value="claude-opus-5">Claude Opus 5</option>
                    <option value="claude-sonnet-5">Claude Sonnet 5</option>
                    <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
                  </Select>
                </Field>
              </div>
              <div className="mt-4">
                <Field label={t.ai.escalation} hint={t.ai.escalationHint}>
                  <Textarea
                    value={a.escalation_notes}
                    onChange={(e) => setA({ ...a, escalation_notes: e.target.value })}
                    onBlur={() => save()}
                    className="min-h-20"
                  />
                </Field>
              </div>
            </Card>

            <Card className="spine p-5" spine="var(--color-brand-500)">
              <h3 className="mb-1.5 flex items-center gap-2 text-[15px] font-semibold">
                <ShieldCheck className="h-4.5 w-4.5 text-brand-600" />
                {t.ai.guardrails}
              </h3>
              <p className="text-[13px] leading-6 text-ink-600 text-ink-700">{t.ai.guardrailsBody}</p>
            </Card>
          </>
        )}

        {tab === "knowledge" && (
          <Card>
            <CardHeader
              title={t.ai.knowledgeTitle}
              sub={t.ai.knowledgeSub}
              action={
                <Button size="sm" onClick={() => setEditing({ category: "faq", title: "", content: "" })}>
                  <Plus className="h-4 w-4" />
                  {t.ai.addItem}
                </Button>
              }
            />
            {knowledge.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  icon={<BookOpen />}
                  title={t.ai.emptyKnowledge}
                  body={t.ai.emptyKnowledgeBody}
                  action={
                    <Button onClick={() => setEditing({ category: "faq", title: "", content: "" })}>
                      {t.ai.addItem}
                    </Button>
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {knowledge.map((k) => {
                  const empty = !k.content.trim();
                  return (
                    <li key={k.id} className="flex items-start gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{k.title}</span>
                          <Badge status={empty ? "pending" : "brand"}>
                            {(t.ai.categories as Record<string, string>)[k.category] ?? k.category}
                          </Badge>
                          {empty && <Badge status="pending">{t.ai.itemEmpty}</Badge>}
                        </div>
                        {k.content && (
                          <p className="mt-1 line-clamp-2 text-[13px] text-ink-500">{k.content}</p>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" aria-label={t.common.edit} onClick={() => setEditing(k)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label={t.common.delete} onClick={() => setDeleteId(k.id)}>
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}

        {tab === "usage" && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                [t.ai.messagesOut, totals.messages],
                [t.ai.bookings, totals.bookings],
                [t.ai.escalations, totals.escalations],
                [t.ai.tokens, totals.tokens],
              ].map(([label, val], i) => (
                <Card key={i} className="p-4">
                  <div className="text-[13px] text-ink-500">{String(label)}</div>
                  <div className="mt-1 text-2xl font-semibold tnum">
                    {Number(val).toLocaleString("en-GB")}
                  </div>
                </Card>
              ))}
            </div>
            <Card>
              <CardHeader title={t.ai.usageTitle} sub={t.ai.last30} />
              {usage.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-ink-400">{t.ai.noUsage}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {usage.map((u) => (
                    <li key={u.day} className="flex items-center gap-4 px-5 py-2.5 text-sm">
                      <span className="w-28 tnum text-ink-500">{String(u.day).slice(0, 10)}</span>
                      <span className="flex-1 tnum">{u.messages_out} {t.ai.messagesOut}</span>
                      {u.bookings > 0 && <Badge status="confirmed">{u.bookings} {t.ai.bookings}</Badge>}
                      {u.escalations > 0 && <Badge status="pending">{u.escalations} {t.ai.escalations}</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? t.common.edit : t.ai.addItem}
      >
        {editing && (
          <div className="grid gap-4">
            <Field label={t.ai.category}>
              <Select
                value={editing.category ?? "faq"}
                onChange={(e) => setEditing({ ...editing, category: e.target.value })}
              >
                {Object.entries(t.ai.categories).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label={t.ai.itemTitle} required>
              <Input
                value={editing.title ?? ""}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              />
            </Field>
            <Field label={t.ai.itemContent}>
              <Textarea
                value={editing.content ?? ""}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                className="min-h-32"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
              <Button
                loading={pending}
                disabled={!editing.title?.trim()}
                onClick={() =>
                  start(async () => {
                    const r = await saveKnowledgeItemAction(slug, {
                      id: editing.id,
                      category: editing.category ?? "faq",
                      title: editing.title ?? "",
                      content: editing.content ?? "",
                    });
                    if (r.error) {
                      toast(t.common.genericError, "error");
                      return;
                    }
                    toast(t.common.saved);
                    setEditing(null);
                    router.refresh();
                  })
                }
              >
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title={t.common.confirmDeleteTitle}
        body={t.common.confirmDeleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={async () => {
          if (deleteId) {
            await deleteKnowledgeItemAction(slug, deleteId);
            setDeleteId(null);
            router.refresh();
          }
        }}
      />
    </>
  );
}
