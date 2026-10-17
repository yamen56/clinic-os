"use client";

import { Copy, RefreshCw, Trash2, Zap } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Field, Input, NumberInput, Select, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  APPOINTMENT_SOURCES,
  PATIENT_SOURCES,
  normalizeStepConfig,
  type Ctx,
  type Rule,
} from "@/lib/automation/catalog";
import type { FlowNode, Issue } from "@/lib/automation/graph";
import { STEP_ICONS, TRIGGER_ICONS, fill, toneOf, triggerSummary, type Lookups } from "../flow-meta";
import {
  AmountUnit,
  Check,
  Chips,
  ConditionEditor,
  KeywordInput,
  MemberSelect,
  MessageComposer,
  ReplyOptionsEditor,
  Section,
  Segmented,
  TagCombo,
  type Media,
  type ReplyOption,
} from "./inspector-fields";

function IssueList({ issues }: { issues: Issue[] }) {
  const { t } = useI18n();
  if (!issues.length) return null;
  return (
    <ul className="grid gap-1">
      {issues.map((i, n) => (
        <li
          key={n}
          className={`rounded-md px-2.5 py-1.5 text-[12px] ${
            i.severity === "error" ? "bg-danger-soft text-danger" : "bg-st-noshow-soft text-st-noshow"
          }`}
        >
          {fill((t.automations.flow.issue as Record<string, string>)[i.code] ?? i.code, { detail: i.detail ?? "" })}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------
   Trigger
   ------------------------------------------------------------------------- */

export function TriggerInspector({
  trigger,
  config,
  onChange,
  onChangeTrigger,
  lookups,
  issues,
}: {
  trigger: string;
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
  onChangeTrigger: () => void;
  lookups: Lookups;
  issues: Issue[];
}) {
  const { t, locale } = useI18n();
  const f = t.automations.flow;
  const Icon = TRIGGER_ICONS[trigger] ?? Zap;
  const sum = triggerSummary(t.automations, trigger, config, lookups, locale);
  const set = (patch: Record<string, unknown>) => onChange({ ...config, ...patch });
  const list = (k: string) => (Array.isArray(config[k]) ? (config[k] as string[]) : []);
  const svcName = (s: { name: string; name_ar: string | null }) => (locale === "ar" ? s.name_ar || s.name : s.name);
  const doctors = lookups.members.filter((m) => m.role === "doctor");
  const apptFilters = (
    <>
      {lookups.services.length > 0 && (
        <Section title={f.onlyServices} hint={list("services").length ? undefined : f.anyService}>
          <Chips
            options={lookups.services.map((s) => ({ value: s.id, label: svcName(s) }))}
            value={list("services")}
            onChange={(services) => set({ services })}
          />
        </Section>
      )}
      {doctors.length > 1 && (
        <Section title={f.onlyDoctors} hint={list("doctors").length ? undefined : f.anyDoctor}>
          <Chips options={doctors.map((m) => ({ value: m.id, label: m.name }))} value={list("doctors")} onChange={(d) => set({ doctors: d })} />
        </Section>
      )}
    </>
  );

  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-600 text-white">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="eyebrow">{f.when}</div>
          <div className="text-[15px] font-semibold">{sum.title}</div>
          <p className="mt-0.5 text-[12px] text-ink-500">{(f.triggerHints as Record<string, string>)[trigger]}</p>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onChangeTrigger}>
        <RefreshCw className="h-4 w-4" />
        {f.changeTrigger}
      </Button>
      <IssueList issues={issues} />

      {trigger === "appointment_status_changed" && (
        <Field label={t.automations.status}>
          <Select value={String(config.status ?? "")} onChange={(e) => set({ status: e.target.value })}>
            <option value="">{f.anyChange}</option>
            {["confirmed", "completed", "no_show", "cancelled"].map((s) => (
              <option key={s} value={s}>
                {(t.calendar.statuses as Record<string, string>)[s]}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {trigger === "before_appointment" && (
        <Field label={f.hoursBefore}>
          <NumberInput dir="ltr" min={0.25} max={720} step="any" value={Number(config.hours ?? 24)} fallback={24} onChange={(v) => set({ hours: v })} />
        </Field>
      )}
      {["appointment_created", "appointment_rescheduled", "appointment_status_changed", "before_appointment", "patient_arrived"].includes(trigger) &&
        apptFilters}
      {trigger === "appointment_created" && (
        <>
          <Section title={f.bookedBy} hint={list("sources").length ? undefined : f.anyone}>
            <Chips
              options={APPOINTMENT_SOURCES.map((s) => ({ value: s, label: (f.appointmentSources as Record<string, string>)[s] }))}
              value={list("sources")}
              onChange={(sources) => set({ sources })}
            />
          </Section>
          <Check checked={Boolean(config.first_visit)} onChange={(v) => set({ first_visit: v })} label={f.firstVisitOnly} />
        </>
      )}
      {trigger === "booking_submitted" && (
        <Check checked={Boolean(config.needs_approval)} onChange={(v) => set({ needs_approval: v })} label={f.needsApprovalOnly} />
      )}
      {trigger === "patient_created" && (
        <Section title={f.bookedBy} hint={list("sources").length ? undefined : f.anyone}>
          <Chips
            options={PATIENT_SOURCES.map((s) => ({ value: s, label: (f.patientSources as Record<string, string>)[s] }))}
            value={list("sources")}
            onChange={(sources) => set({ sources })}
          />
        </Section>
      )}
      {(trigger === "tag_added" || trigger === "tag_removed") && (
        <Section title={t.automations.tag} hint={f.tagAny}>
          <TagCombo value={String(config.tag ?? "")} onChange={(tag) => set({ tag })} tags={lookups.tags} />
        </Section>
      )}
      {trigger === "after_last_visit" && (
        <Field label={f.daysAfterVisit}>
          <NumberInput dir="ltr" min={1} max={3650} value={Number(config.days ?? 180)} fallback={180} onChange={(v) => set({ days: Math.round(v) })} />
        </Field>
      )}
      {trigger === "invoice_unpaid" && (
        <Field label={f.daysAfterSent}>
          <NumberInput dir="ltr" min={1} max={365} value={Number(config.days ?? 3)} fallback={3} onChange={(v) => set({ days: Math.round(v) })} />
        </Field>
      )}
      {trigger === "document_unsigned" && (
        <Field label={f.daysUnsigned}>
          <NumberInput dir="ltr" min={1} max={365} value={Number(config.days ?? 3)} fallback={3} onChange={(v) => set({ days: Math.round(v) })} />
        </Field>
      )}
      {trigger === "payment_received" && (
        <Check checked={Boolean(config.fully_paid_only)} onChange={(v) => set({ fully_paid_only: v })} label={f.fullyPaidOnly} />
      )}
      {trigger === "conversation_unanswered" && (
        <Field label={`${f.unansweredMinutes} (${f.minutesShort})`} hint={f.unansweredHint}>
          <NumberInput dir="ltr" min={5} max={1440} value={Number(config.minutes ?? 15)} fallback={15} onChange={(v) => set({ minutes: Math.round(v) })} />
        </Field>
      )}
      {trigger === "inbound_message" && (
        <>
          <Segmented
            value={(String(config.mode ?? "keywords") as "any" | "keywords" | "first_message")}
            onChange={(mode) => set({ mode })}
            options={(["keywords", "any", "first_message"] as const).map((m) => ({ value: m, label: f.inboundMode[m] }))}
          />
          {config.mode !== "any" && config.mode !== "first_message" && (
            <Section title={f.keywords} hint={f.keywordsHint}>
              <KeywordInput value={list("keywords")} onChange={(keywords) => set({ keywords })} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
   Steps
   ------------------------------------------------------------------------- */

export function StepInspector({
  slug,
  node,
  provides,
  hasReplyStep,
  lookups,
  issues,
  onConfig,
  onReplyOptions,
  onLabel,
  onDelete,
  onDuplicate,
}: {
  slug: string;
  node: FlowNode;
  provides: Ctx[];
  hasReplyStep: boolean;
  lookups: Lookups;
  issues: Issue[];
  onConfig: (config: Record<string, unknown>) => void;
  /** Answers change the step's outputs, so the edges have to move with them. */
  onReplyOptions: (options: ReplyOption[], removed: number | null) => void;
  onLabel: (label: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { t, locale } = useI18n();
  const f = t.automations.flow;
  const cfg = normalizeStepConfig(node.type, node.config);
  const set = (patch: Record<string, unknown>) => onConfig({ ...cfg, ...patch });
  const str = (k: string) => String(cfg[k] ?? "");
  const Icon = STEP_ICONS[node.type] ?? Zap;
  const tone = toneOf(node.type);
  const hasAppt = provides.includes("appointment");

  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${tone.chip}`}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">{(t.automations.steps as Record<string, string>)[node.type]}</div>
          <p className="mt-0.5 text-[12px] text-ink-500">{(f.stepHints as Record<string, string>)[node.type]}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button type="button" title={f.duplicate} aria-label={f.duplicate} onClick={onDuplicate} className="grid h-8 w-8 place-items-center rounded-md text-ink-500 hover:bg-sunken">
            <Copy className="h-4 w-4" />
          </button>
          <button type="button" title={f.delete} aria-label={f.delete} onClick={onDelete} className="grid h-8 w-8 place-items-center rounded-md text-ink-500 hover:bg-danger-soft hover:text-danger">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <IssueList issues={issues} />

      {node.type === "send_whatsapp" && (
        <MessageComposer
          slug={slug}
          value={str("message")}
          onChange={(message) => set({ message })}
          media={(cfg.media as Media) ?? null}
          onMedia={(media) => set({ media })}
          provides={provides}
          hasReplyStep={hasReplyStep}
        />
      )}

      {node.type === "send_document" && (
        <Field label={t.automations.documentTemplate}>
          <Select value={str("template_id")} onChange={(e) => set({ template_id: e.target.value })}>
            <option value="">{f.choose}</option>
            {lookups.docTemplates.map((d) => (
              <option key={d.id} value={d.id}>
                {locale === "ar" ? d.name_ar || d.name : d.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {node.type === "wait" && (
        <>
          <Segmented
            value={str("mode") as "duration" | "until_time" | "appointment"}
            onChange={(mode) => set({ mode, ...(mode === "until_time" ? { amount: 0, unit: "days" } : {}) })}
            options={(["duration", "until_time", "appointment"] as const)
              .filter((m) => m !== "appointment" || hasAppt)
              .map((m) => ({ value: m, label: f.waitMode[m] }))}
          />
          {cfg.mode === "duration" && (
            <Section title={f.amount}>
              <AmountUnit amount={Number(cfg.amount)} unit={str("unit")} onChange={(amount, unit) => set({ amount, unit })} />
            </Section>
          )}
          {cfg.mode === "until_time" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Field label={f.atTime}>
                  <Input type="time" dir="ltr" value={str("time")} onChange={(e) => set({ time: e.target.value || "09:00" })} />
                </Field>
                <Field label={f.daysFromNow}>
                  <Select
                    value={String(cfg.unit === "days" ? Number(cfg.amount) : 0)}
                    onChange={(e) => set({ amount: Number(e.target.value), unit: "days" })}
                  >
                    {[0, 1, 2, 3, 7, 14, 30].map((d) => (
                      <option key={d} value={d}>
                        {d === 0 ? f.today : fill(f.inDays, { n: d })}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Section title={f.onlyOn} hint={(cfg.weekdays as number[]).length ? undefined : f.anyDay}>
                <Chips
                  options={[6, 7, 1, 2, 3, 4, 5].map((d) => ({
                    value: String(d),
                    label: (t.automations.weekdays as Record<string, string>)[d],
                  }))}
                  value={(cfg.weekdays as number[]).map(String)}
                  onChange={(v) => set({ weekdays: v.map(Number) })}
                />
              </Section>
            </>
          )}
          {cfg.mode === "appointment" && (
            <>
              <AmountUnit amount={Number(cfg.amount)} unit={str("unit")} onChange={(amount, unit) => set({ amount, unit })} />
              <Segmented
                value={str("direction") as "before" | "after"}
                onChange={(direction) => set({ direction })}
                options={(["before", "after"] as const).map((d) => ({ value: d, label: f.direction[d] }))}
              />
            </>
          )}
        </>
      )}

      {node.type === "wait_for_reply" && (
        <>
          <Section title={f.replyTimeout}>
            <AmountUnit amount={Number(cfg.amount)} min={1} unit={str("unit")} onChange={(amount, unit) => set({ amount, unit })} />
          </Section>
          <Section title={f.answers} hint={f.answersHint}>
            <ReplyOptionsEditor options={(cfg.options as ReplyOption[]) ?? []} onChange={onReplyOptions} />
          </Section>
          <p className="rounded-md bg-sunken px-2.5 py-2 text-[12px] leading-snug text-ink-500">{f.replyTip}</p>
        </>
      )}

      {node.type === "condition" && (
        <ConditionEditor
          match={(cfg.match as "all" | "any") ?? "all"}
          rules={(cfg.rules as Rule[]) ?? []}
          onChange={(match, rules) => set({ match, rules })}
          provides={provides}
          lookups={lookups}
        />
      )}

      {node.type === "goto_automation" && (
        <Field label={f.target} hint={f.gotoHint}>
          <Select value={str("automation_id")} onChange={(e) => set({ automation_id: e.target.value })}>
            <option value="">{f.choose}</option>
            {lookups.automations.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {node.type === "stop" && <p className="text-[13px] text-ink-500">{f.stopHint}</p>}

      {(node.type === "add_tag" || node.type === "remove_tag") && (
        <Section title={t.automations.tag}>
          <TagCombo value={str("tag")} onChange={(tag) => set({ tag })} tags={lookups.tags} />
        </Section>
      )}

      {node.type === "update_patient" && (
        <>
          <Segmented
            value={str("field") as "status" | "custom"}
            onChange={(field) => set({ field })}
            options={(["status", "custom"] as const).map((v) => ({ value: v, label: f.updateField[v] }))}
          />
          {cfg.field === "status" ? (
            <Chips
              single
              options={(["lead", "active", "archived"] as const).map((s) => ({ value: s, label: f.patientStatuses[s] }))}
              value={[str("status")]}
              onChange={(v) => set({ status: v[0] ?? "active" })}
            />
          ) : lookups.customFields.length ? (
            <>
              <Field label={f.field}>
                <Select value={str("key")} onChange={(e) => set({ key: e.target.value })}>
                  <option value="">{f.choose}</option>
                  {lookups.customFields.map((cf) => (
                    <option key={cf.key} value={cf.key}>
                      {locale === "ar" ? cf.label_ar || cf.label : cf.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={f.newValue}>
                <Input value={str("value")} onChange={(e) => set({ value: e.target.value })} />
              </Field>
            </>
          ) : (
            <p className="text-[12px] text-ink-500">{f.noCustomFields}</p>
          )}
        </>
      )}

      {node.type === "add_note" && (
        <Section title={f.noteBody} hint={f.noteHint}>
          <MessageComposer
            slug={slug}
            value={str("body")}
            onChange={(body) => set({ body })}
            provides={provides}
            hasReplyStep={hasReplyStep}
            allowMedia={false}
            rows={4}
          />
        </Section>
      )}

      {node.type === "update_appointment" && (
        <>
          <Segmented
            value={str("status") as "confirmed" | "cancelled"}
            onChange={(status) => set({ status })}
            options={(["confirmed", "cancelled"] as const).map((s) => ({ value: s, label: f.apptAction[s] }))}
          />
          <p className="text-[12px] leading-snug text-ink-500">{f.apptActionHint}</p>
        </>
      )}

      {node.type === "assign_conversation" && (
        <>
          <Segmented
            value={str("target") as "member" | "appointment_doctor" | "nobody"}
            onChange={(target) => set({ target })}
            options={(["member", "appointment_doctor", "nobody"] as const)
              .filter((v) => v !== "appointment_doctor" || hasAppt)
              .map((v) => ({ value: v, label: f.assignTarget[v] }))}
          />
          {cfg.target === "member" && (
            <MemberSelect value={str("member_id")} onChange={(member_id) => set({ member_id })} members={lookups.members} />
          )}
        </>
      )}

      {node.type === "set_ai" && (
        <>
          <Segmented
            value={str("mode") as "pause" | "off" | "on"}
            onChange={(mode) => set({ mode })}
            options={(["pause", "off", "on"] as const).map((m) => ({ value: m, label: f.aiMode[m] }))}
          />
          {cfg.mode === "pause" && (
            <AmountUnit amount={Number(cfg.amount)} min={1} unit={str("unit")} onChange={(amount, unit) => set({ amount, unit })} />
          )}
        </>
      )}

      {node.type === "flag_conversation" && (
        <Field label={f.flagReason} hint={f.flagHint}>
          <Input value={str("reason")} maxLength={200} onChange={(e) => set({ reason: e.target.value })} />
        </Field>
      )}

      {node.type === "close_conversation" && <p className="text-[13px] text-ink-500">{f.closeHint}</p>}

      {node.type === "create_task" && (
        <>
          <Field label={f.title}>
            <Input value={str("title")} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label={f.notes}>
            <Textarea value={str("body")} onChange={(e) => set({ body: e.target.value })} />
          </Field>
          <Section title={f.dueIn}>
            <AmountUnit amount={Number(cfg.due_amount)} unit={str("due_unit")} onChange={(due_amount, due_unit) => set({ due_amount, due_unit })} />
          </Section>
          <Section title={t.automations.flow.member}>
            <Segmented
              value={str("assignee") as "nobody" | "member" | "appointment_doctor"}
              onChange={(assignee) => set({ assignee })}
              options={(["nobody", "member", "appointment_doctor"] as const)
                .filter((v) => v !== "appointment_doctor" || hasAppt)
                .map((v) => ({ value: v, label: f.assignee[v] }))}
            />
          </Section>
          {cfg.assignee === "member" && (
            <MemberSelect value={str("member_id")} onChange={(member_id) => set({ member_id })} members={lookups.members} />
          )}
        </>
      )}

      {node.type === "notify_staff" && (
        <>
          <Field label={f.title}>
            <Input value={str("title")} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label={f.notes}>
            <Textarea value={str("body")} onChange={(e) => set({ body: e.target.value })} />
          </Field>
          <Section title={f.recipients}>
            <Chips
              options={(["owner", "doctor", "receptionist"] as const).map((r) => ({ value: r, label: t.automations.alertRoles[r] }))}
              value={(cfg.roles as string[]) ?? []}
              onChange={(roles) => set({ roles })}
            />
          </Section>
          {hasAppt && (
            <Check checked={Boolean(cfg.appointment_doctor)} onChange={(v) => set({ appointment_doctor: v })} label={f.apptDoctor} />
          )}
          <Section title={f.people}>
            <Chips
              options={lookups.members.map((m) => ({ value: m.id, label: m.name }))}
              value={(cfg.member_ids as string[]) ?? []}
              onChange={(member_ids) => set({ member_ids })}
            />
          </Section>
        </>
      )}

      <Field label={f.stepLabel}>
        <Input value={node.label} maxLength={80} placeholder={f.stepLabelPlaceholder} onChange={(e) => onLabel(e.target.value)} />
      </Field>
    </div>
  );
}

