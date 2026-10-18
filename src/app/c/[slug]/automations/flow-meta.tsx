import {
  ArrowRightLeft, BellRing, Bot, Cake, CalendarCheck, CalendarClock, CalendarPlus, CalendarX, CheckCheck,
  CircleStop, Clock, DoorOpen, Eye, FileCheck, FileClock, FilePen, FileSignature, FileX, Flag, GitBranch,
  History, ListTodo, MessageCircle, MessageSquareWarning, Pill, Receipt, Reply, Send,
  StickyNote, Tag, Tags, UserCheck, UserCog, UserPlus, UserX, Wallet, Globe, Hourglass,
} from "lucide-react";
import type { Dict } from "@/lib/i18n/en";
import { normalizeStepConfig, type Rule, type StepCategory, stepDef } from "@/lib/automation/catalog";

type Icon = React.ComponentType<{ className?: string }>;

export const STEP_ICONS: Record<string, Icon> = {
  send_whatsapp: Send,
  send_document: FileSignature,
  wait: Clock,
  wait_for_reply: Reply,
  condition: GitBranch,
  goto_automation: ArrowRightLeft,
  stop: CircleStop,
  add_tag: Tag,
  remove_tag: Tags,
  update_patient: UserCog,
  add_note: StickyNote,
  update_appointment: CalendarCheck,
  assign_conversation: UserCheck,
  set_ai: Bot,
  flag_conversation: Flag,
  close_conversation: CheckCheck,
  create_task: ListTodo,
  notify_staff: BellRing,
};

export const TRIGGER_ICONS: Record<string, Icon> = {
  appointment_created: CalendarPlus,
  before_appointment: CalendarClock,
  appointment_status_changed: CalendarCheck,
  appointment_rescheduled: History,
  patient_arrived: DoorOpen,
  booking_submitted: Globe,
  waitlist_booked: Hourglass,
  patient_created: UserPlus,
  tag_added: Tag,
  tag_removed: Tags,
  birthday: Cake,
  after_last_visit: History,
  prescription_sent: Pill,
  inbound_message: MessageCircle,
  conversation_unanswered: MessageSquareWarning,
  invoice_sent: Receipt,
  invoice_unpaid: FileClock,
  payment_received: Wallet,
  document_sent: FileSignature,
  document_viewed: Eye,
  document_signed: FilePen,
  document_completed: FileCheck,
  document_declined: FileX,
  document_unsigned: FileClock,
  document_expired: FileX,
};

export const PRESET_ICONS: Record<string, Icon> = {
  visit_completed: CheckCheck,
  appointment_confirmed: CalendarCheck,
  appointment_cancelled: CalendarX,
  appointment_no_show: UserX,
};

/** One tint per kind of step, so a flow can be read at a glance. */
export const CATEGORY_TONE: Record<StepCategory, { icon: string; chip: string; bar: string }> = {
  messages: { icon: "text-st-confirmed", chip: "bg-st-confirmed-soft text-st-confirmed", bar: "bg-st-confirmed" },
  timing: { icon: "text-st-waiting", chip: "bg-st-waiting-soft text-st-waiting", bar: "bg-st-waiting" },
  logic: { icon: "text-st-inroom", chip: "bg-st-inroom-soft text-st-inroom", bar: "bg-st-inroom" },
  patient: { icon: "text-chart", chip: "bg-chart-soft text-chart", bar: "bg-chart" },
  appointment: { icon: "text-st-noshow", chip: "bg-st-noshow-soft text-st-noshow", bar: "bg-st-noshow" },
  conversation: { icon: "text-cyan-ink", chip: "bg-sunken text-cyan-ink", bar: "bg-cyan-ink" },
  team: { icon: "text-st-late", chip: "bg-st-late-soft text-st-late", bar: "bg-st-late" },
};

export function toneOf(stepType: string) {
  return CATEGORY_TONE[stepDef(stepType)?.category ?? "logic"];
}

export function fill(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export type Lookups = {
  services: { id: string; name: string; name_ar: string | null }[];
  members: { id: string; name: string; role: string; is_owner: boolean }[];
  automations: { id: string; name: string }[];
  docTemplates: { id: string; name: string; name_ar: string | null }[];
  customFields: { key: string; label: string; label_ar: string | null }[];
  tags: string[];
};

type T = Dict["automations"];

function unitLabel(t: T, unit: unknown, amount: number): string {
  return `${amount} ${(t.flow.units as Record<string, string>)[String(unit)] ?? ""}`.trim();
}

function snippet(s: string, n = 70): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Output name as drawn on an edge. */
export function handleLabel(t: T, handle: string, config: Record<string, unknown>): string {
  if (handle.startsWith("opt:")) {
    const i = Number(handle.slice(4));
    const options = (config.options as { label?: string; keywords?: string[] }[]) ?? [];
    const o = options[i];
    return o?.label?.trim() || o?.keywords?.[0] || fill(t.flow.answerN, { n: i + 1 });
  }
  return (t.flow.handles as Record<string, string>)[handle] ?? handle;
}

/** The one line under a step's name on the canvas. */
export function stepSummary(dict: Dict, type: string, raw: Record<string, unknown>, look: Lookups, locale: string): string {
  const t = dict.automations;
  const cfg = normalizeStepConfig(type, raw);
  const str = (k: string) => String(cfg[k] ?? "").trim();
  const name = (row: { name: string; name_ar: string | null } | undefined) =>
    row ? (locale === "ar" ? row.name_ar || row.name : row.name) : "";
  switch (type) {
    case "send_whatsapp":
      return str("message") ? snippet(str("message")) : cfg.media ? t.flow.attachment : "";
    case "send_document":
      return name(look.docTemplates.find((d) => d.id === str("template_id")));
    case "wait": {
      const amount = Number(cfg.amount) || 0;
      if (cfg.mode === "until_time") {
        const days = cfg.unit === "days" ? amount : 0;
        return `${t.flow.atTime} ${str("time")}${days ? ` · ${fill(t.flow.inDays, { n: days })}` : ""}`;
      }
      if (cfg.mode === "appointment") {
        return `${unitLabel(t, cfg.unit, amount)} ${(t.flow.direction as Record<string, string>)[String(cfg.direction)]}`;
      }
      return unitLabel(t, cfg.unit, amount);
    }
    case "wait_for_reply": {
      const options = (cfg.options as unknown[]) ?? [];
      return `${t.flow.replyTimeout} ${unitLabel(t, cfg.unit, Number(cfg.amount) || 0)}${
        options.length ? ` · ${options.length} ${t.flow.answers.toLowerCase()}` : ""
      }`;
    }
    case "condition": {
      const rules = (cfg.rules as Rule[]) ?? [];
      if (rules.length === 1) {
        const r = rules[0];
        const base = (t.flow.rules as Record<string, string>)[r.kind] ?? r.kind;
        let detail = "";
        if (r.kind === "has_tag" || r.kind === "gender") detail = r.value ? `: ${r.kind === "gender" ? (t.flow.genders as Record<string, string>)[r.value] ?? r.value : r.value}` : "";
        else if (r.kind === "reply_contains") detail = r.values.length ? `: ${r.values.join(locale === "ar" ? "، " : ", ")}` : "";
        else if (r.kind === "age_between") detail = ` ${r.number ?? "…"}–${r.number2 ?? "…"}`;
        else if (r.kind === "visits_at_least" || r.kind === "invoice_balance_above") detail = r.number != null ? ` ${r.number}` : "";
        else if (r.kind === "time_between") detail = r.value && r.value2 ? ` ${r.value}–${r.value2}` : "";
        else if (r.values.length) {
          const label = (v: string): string => {
            switch (r.kind) {
              case "appointment_status": return (dict.calendar.statuses as Record<string, string>)[v] ?? v;
              case "patient_status": return (t.flow.patientStatuses as Record<string, string>)[v] ?? v;
              case "patient_source": return (t.flow.patientSources as Record<string, string>)[v] ?? v;
              case "document_status": return (t.flow.documentStatuses as Record<string, string>)[v] ?? v;
              case "weekday": return (t.weekdays as Record<string, string>)[v] ?? v;
              case "appointment_service": return name(look.services.find((x) => x.id === v)) || "…";
              case "appointment_doctor": return look.members.find((m) => m.id === v)?.name ?? "…";
              default: return v;
            }
          };
          const names = r.values.map(label);
          detail = `: ${names.slice(0, 2).join(locale === "ar" ? "، " : ", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}`;
        }
        return `${r.negate ? `${t.flow.isNot} · ` : ""}${base}${detail}`;
      }
      return rules.length
        ? fill(t.flow.ruleSummary, { n: rules.length, match: (t.flow.matchShort as Record<string, string>)[String(cfg.match)] })
        : "";
    }
    case "goto_automation":
      return look.automations.find((a) => a.id === str("automation_id"))?.name ?? "";
    case "stop":
      return "";
    case "add_tag":
    case "remove_tag":
      return str("tag");
    case "update_patient":
      if (cfg.field === "custom") {
        const f = look.customFields.find((x) => x.key === str("key"));
        return f ? `${locale === "ar" ? f.label_ar || f.label : f.label} = ${str("value")}` : "";
      }
      return `${t.flow.updateField.status}: ${(t.flow.patientStatuses as Record<string, string>)[str("status")] ?? ""}`;
    case "add_note":
      return snippet(str("body"));
    case "update_appointment":
      return (t.flow.apptAction as Record<string, string>)[str("status")] ?? "";
    case "assign_conversation":
      if (cfg.target === "member") return look.members.find((m) => m.id === str("member_id"))?.name ?? "";
      return (t.flow.assignTarget as Record<string, string>)[str("target")] ?? "";
    case "set_ai":
      return cfg.mode === "pause"
        ? `${t.flow.aiMode.pause} ${unitLabel(t, cfg.unit, Number(cfg.amount) || 0)}`
        : (t.flow.aiMode as Record<string, string>)[str("mode")];
    case "flag_conversation":
      return snippet(str("reason"));
    case "close_conversation":
      return "";
    case "create_task":
      return snippet(str("title"));
    case "notify_staff":
      return snippet(str("title"));
  }
  return "";
}

/** The trigger in a sentence, as the list and the canvas show it. */
export function triggerSummary(
  t: T,
  type: string,
  cfg: Record<string, unknown>,
  look: Pick<Lookups, "services" | "members">,
  locale: string
): { title: string; detail: string } {
  const triggers = t.triggers as Record<string, string>;
  let title = triggers[type] ?? type;
  const bits: string[] = [];
  const list = (k: string) => (Array.isArray(cfg[k]) ? (cfg[k] as string[]) : []);

  if (type === "appointment_status_changed" && cfg.status) {
    const preset = { completed: "visit_completed", confirmed: "appointment_confirmed", cancelled: "appointment_cancelled", no_show: "appointment_no_show" }[
      String(cfg.status)
    ];
    if (preset) title = (t.flow.presets as Record<string, string>)[preset];
  }
  if (type === "before_appointment") bits.push(`${cfg.hours ?? 24} ${t.flow.units.hours}`);
  if (type === "after_last_visit" || type === "invoice_unpaid" || type === "document_unsigned") {
    bits.push(`${cfg.days ?? ""} ${t.flow.units.days}`);
  }
  if (type === "conversation_unanswered") bits.push(`${cfg.minutes ?? 15} ${t.flow.minutesShort}`);
  if ((type === "tag_added" || type === "tag_removed") && cfg.tag) bits.push(`“${cfg.tag}”`);
  if (type === "inbound_message") {
    if (cfg.mode === "keywords" && list("keywords").length) bits.push(list("keywords").map((k) => `“${k}”`).join(", "));
    else bits.push((t.flow.inboundMode as Record<string, string>)[String(cfg.mode ?? "any")] ?? "");
  }
  const services = list("services");
  if (services.length) {
    const names = services
      .map((id) => look.services.find((s) => s.id === id))
      .filter(Boolean)
      .map((s) => (locale === "ar" ? s!.name_ar || s!.name : s!.name));
    bits.push(names.length > 2 ? `${names.slice(0, 2).join("، ")} +${names.length - 2}` : names.join(locale === "ar" ? "، " : ", "));
  }
  const doctors = list("doctors");
  if (doctors.length) {
    const names = doctors.map((id) => look.members.find((m) => m.id === id)?.name).filter(Boolean) as string[];
    bits.push(names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", "));
  }
  if (type === "appointment_created" && cfg.first_visit) bits.push(t.flow.firstVisitOnly);
  if (type === "payment_received" && cfg.fully_paid_only) bits.push(t.flow.fullyPaidOnly);
  return { title, detail: bits.filter(Boolean).join(" · ") };
}
