import { z } from "zod";
import { isUuid } from "../uuid";

/**
 * Everything an automation can be made of, in one place.
 *
 * The builder draws from this, the save action validates against it and the
 * worker runs by it. Before, each kept its own list: the builder offered seven
 * document triggers that the save action's enum had never heard of, so every
 * flow built on one failed to save with a generic error. One list cannot drift
 * from itself.
 *
 * Imports nothing that touches the database or React, because the worker image
 * carries src/lib and nothing else.
 */

/** What a run knows about, which decides what its steps can do. */
export type Ctx = "patient" | "appointment" | "invoice" | "document" | "conversation";

/** Modules a trigger or step belongs to, named as in lib/features. */
type Module = "calendar" | "conversations" | "invoices" | "documents" | "patients";

const uuid = z.string().refine(isUuid, "uuid");
const uuids = z.array(uuid).max(100).default([]);
const text = (max: number) => z.string().max(max).default("");
const unit = z.enum(["minutes", "hours", "days"]);

/* -------------------------------------------------------------------------
   Triggers
   ------------------------------------------------------------------------- */

export const TRIGGER_CATEGORIES = ["appointments", "patients", "messages", "billing", "documents"] as const;
export type TriggerCategory = (typeof TRIGGER_CATEGORIES)[number];

export const APPOINTMENT_SOURCES = ["staff", "booking_link", "ai_agent"] as const;
export const PATIENT_SOURCES = ["staff", "booking_link", "whatsapp", "ai_agent", "import"] as const;
export const PATIENT_STATUSES = ["lead", "active", "archived"] as const;
export const APPOINTMENT_STATUSES = [
  "pending_approval", "scheduled", "confirmed", "completed", "no_show", "cancelled",
] as const;

const apptFilters = { services: uuids, doctors: uuids };

const TRIGGER_SCHEMAS = {
  appointment_created: z.object({
    ...apptFilters,
    sources: z.array(z.enum(APPOINTMENT_SOURCES)).default([]),
    first_visit: z.boolean().default(false),
  }),
  appointment_rescheduled: z.object(apptFilters),
  appointment_status_changed: z.object({
    status: z.enum(["", "confirmed", "completed", "no_show", "cancelled"]).default(""),
    ...apptFilters,
  }),
  before_appointment: z.object({
    hours: z.number().min(0.25).max(720).default(24),
    ...apptFilters,
  }),
  patient_arrived: z.object(apptFilters),
  booking_submitted: z.object({ needs_approval: z.boolean().default(false) }),
  waitlist_booked: z.object({}),
  patient_created: z.object({ sources: z.array(z.enum(PATIENT_SOURCES)).default([]) }),
  tag_added: z.object({ tag: text(40) }),
  tag_removed: z.object({ tag: text(40) }),
  birthday: z.object({}),
  after_last_visit: z.object({ days: z.number().int().min(1).max(3650).default(180) }),
  inbound_message: z.object({
    mode: z.enum(["any", "keywords", "first_message"]).default("keywords"),
    keywords: z.array(z.string().min(1).max(60)).max(30).default([]),
  }),
  conversation_unanswered: z.object({ minutes: z.number().int().min(5).max(1440).default(15) }),
  invoice_sent: z.object({}),
  invoice_unpaid: z.object({ days: z.number().int().min(1).max(365).default(3) }),
  payment_received: z.object({ fully_paid_only: z.boolean().default(false) }),
  document_sent: z.object({}),
  document_viewed: z.object({}),
  document_signed: z.object({}),
  document_completed: z.object({}),
  document_declined: z.object({}),
  document_unsigned: z.object({ days: z.number().int().min(1).max(365).default(3) }),
  document_expired: z.object({}),
  prescription_sent: z.object({}),
} as const;

export type TriggerKey = keyof typeof TRIGGER_SCHEMAS;
export const TRIGGER_KEYS = Object.keys(TRIGGER_SCHEMAS) as TriggerKey[];

export type TriggerDef = {
  key: TriggerKey;
  category: TriggerCategory;
  provides: Ctx[];
  module: Module;
  /** Fired by the scheduler on a clock, rather than by something happening. */
  timed?: boolean;
};

const appt: Ctx[] = ["patient", "appointment"];

export const TRIGGERS: TriggerDef[] = [
  { key: "appointment_created", category: "appointments", provides: appt, module: "calendar" },
  { key: "before_appointment", category: "appointments", provides: appt, module: "calendar", timed: true },
  { key: "appointment_status_changed", category: "appointments", provides: appt, module: "calendar" },
  { key: "appointment_rescheduled", category: "appointments", provides: appt, module: "calendar" },
  { key: "patient_arrived", category: "appointments", provides: appt, module: "calendar" },
  { key: "booking_submitted", category: "appointments", provides: appt, module: "calendar" },
  { key: "waitlist_booked", category: "appointments", provides: appt, module: "calendar" },
  { key: "patient_created", category: "patients", provides: ["patient"], module: "patients" },
  { key: "tag_added", category: "patients", provides: ["patient"], module: "patients" },
  { key: "tag_removed", category: "patients", provides: ["patient"], module: "patients" },
  { key: "birthday", category: "patients", provides: ["patient"], module: "patients", timed: true },
  { key: "after_last_visit", category: "patients", provides: ["patient"], module: "patients", timed: true },
  { key: "prescription_sent", category: "patients", provides: ["patient"], module: "patients" },
  { key: "inbound_message", category: "messages", provides: ["patient", "conversation"], module: "conversations" },
  {
    key: "conversation_unanswered", category: "messages", provides: ["patient", "conversation"],
    module: "conversations", timed: true,
  },
  { key: "invoice_sent", category: "billing", provides: ["patient", "invoice"], module: "invoices" },
  { key: "invoice_unpaid", category: "billing", provides: ["patient", "invoice"], module: "invoices", timed: true },
  { key: "payment_received", category: "billing", provides: ["patient", "invoice"], module: "invoices" },
  { key: "document_sent", category: "documents", provides: ["patient", "document"], module: "documents" },
  { key: "document_viewed", category: "documents", provides: ["patient", "document"], module: "documents" },
  { key: "document_signed", category: "documents", provides: ["patient", "document"], module: "documents" },
  { key: "document_completed", category: "documents", provides: ["patient", "document"], module: "documents" },
  { key: "document_declined", category: "documents", provides: ["patient", "document"], module: "documents" },
  {
    key: "document_unsigned", category: "documents", provides: ["patient", "document"],
    module: "documents", timed: true,
  },
  { key: "document_expired", category: "documents", provides: ["patient", "document"], module: "documents" },
];

export function triggerDef(key: string): TriggerDef | undefined {
  return TRIGGERS.find((t) => t.key === key);
}

export function isTriggerKey(key: string): key is TriggerKey {
  return key in TRIGGER_SCHEMAS;
}

/**
 * The shortcuts the trigger picker offers on top of the raw list. A clinic
 * thinks "when a visit is finished", not "when an appointment's status changes
 * to completed" — the second is what runs, the first is what it is called.
 */
export const TRIGGER_PRESETS: { id: string; trigger: TriggerKey; config: Record<string, unknown> }[] = [
  { id: "visit_completed", trigger: "appointment_status_changed", config: { status: "completed" } },
  { id: "appointment_confirmed", trigger: "appointment_status_changed", config: { status: "confirmed" } },
  { id: "appointment_cancelled", trigger: "appointment_status_changed", config: { status: "cancelled" } },
  { id: "appointment_no_show", trigger: "appointment_status_changed", config: { status: "no_show" } },
];

/**
 * A trigger's config as the rest of the system expects it, from whatever is
 * stored. Older flows wrote `{keyword: "price"}` for the inbound trigger; that
 * is read as a one-word keyword list, and an empty keyword as "any message",
 * which is what it always meant.
 */
export function normalizeTriggerConfig(key: string, raw: unknown): Record<string, unknown> {
  const cfg = { ...((raw as Record<string, unknown>) ?? {}) };
  if (key === "inbound_message" && !("mode" in cfg)) {
    const kw = typeof cfg.keyword === "string" ? cfg.keyword.trim() : "";
    delete cfg.keyword;
    cfg.mode = kw ? "keywords" : "any";
    cfg.keywords = kw ? [kw] : [];
  }
  if (!isTriggerKey(key)) return cfg;
  const parsed = TRIGGER_SCHEMAS[key].safeParse(cfg);
  return parsed.success ? (parsed.data as Record<string, unknown>) : cfg;
}

export function parseTriggerConfig(key: string, raw: unknown) {
  if (!isTriggerKey(key)) return { success: false as const };
  return TRIGGER_SCHEMAS[key].safeParse(raw ?? {});
}

/* -------------------------------------------------------------------------
   Condition rules
   ------------------------------------------------------------------------- */

export const RULE_KINDS = [
  "has_tag", "gender", "age_between", "patient_source", "patient_status", "custom_field",
  "has_upcoming_appointment", "visits_at_least", "first_visit",
  "appointment_status", "appointment_service", "appointment_doctor",
  "replied", "reply_contains",
  "invoice_paid", "invoice_balance_above",
  "document_status",
  "weekday", "time_between",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** What each rule reads, so a rule about an appointment is refused on a birthday flow. */
export const RULE_NEEDS: Partial<Record<RuleKind, Ctx>> = {
  has_tag: "patient",
  gender: "patient",
  age_between: "patient",
  patient_source: "patient",
  patient_status: "patient",
  custom_field: "patient",
  has_upcoming_appointment: "patient",
  visits_at_least: "patient",
  first_visit: "patient",
  appointment_status: "appointment",
  appointment_service: "appointment",
  appointment_doctor: "appointment",
  invoice_paid: "invoice",
  invoice_balance_above: "invoice",
  document_status: "document",
};

export const RULE_GROUPS: { group: string; kinds: RuleKind[] }[] = [
  { group: "patient", kinds: ["has_tag", "gender", "age_between", "patient_status", "patient_source", "custom_field"] },
  { group: "visits", kinds: ["has_upcoming_appointment", "visits_at_least", "first_visit"] },
  { group: "appointment", kinds: ["appointment_status", "appointment_service", "appointment_doctor"] },
  { group: "messages", kinds: ["replied", "reply_contains"] },
  { group: "billing", kinds: ["invoice_paid", "invoice_balance_above"] },
  { group: "documents", kinds: ["document_status"] },
  { group: "time", kinds: ["weekday", "time_between"] },
];

export const DOCUMENT_STATUSES = ["sent", "viewed", "partially_signed", "completed", "declined", "expired"] as const;

const ruleSchema = z.object({
  kind: z.enum(RULE_KINDS),
  negate: z.boolean().default(false),
  value: text(200),
  value2: text(200),
  values: z.array(z.string().max(100)).max(50).default([]),
  number: z.number().nullable().default(null),
  number2: z.number().nullable().default(null),
  /** custom_field: which field. */
  key: text(80),
  /** custom_field: how to compare. */
  op: z.enum(["equals", "contains", "empty", "not_empty"]).default("equals"),
});
export type Rule = z.infer<typeof ruleSchema>;

export function newRule(kind: RuleKind): Rule {
  return ruleSchema.parse({ kind });
}

/** Whether a rule has what it needs to be evaluated. */
export function ruleComplete(r: Rule): boolean {
  switch (r.kind) {
    case "has_tag":
    case "gender":
      return Boolean(r.value.trim());
    case "custom_field":
      return Boolean(r.key) && (r.op === "empty" || r.op === "not_empty" || Boolean(r.value.trim()));
    case "age_between":
      return r.number !== null || r.number2 !== null;
    case "visits_at_least":
    case "invoice_balance_above":
      return r.number !== null;
    case "patient_source":
    case "patient_status":
    case "appointment_status":
    case "appointment_service":
    case "appointment_doctor":
    case "reply_contains":
    case "document_status":
    case "weekday":
      return r.values.length > 0;
    case "time_between":
      return /^\d{2}:\d{2}$/.test(r.value) && /^\d{2}:\d{2}$/.test(r.value2);
    default:
      return true;
  }
}

/* -------------------------------------------------------------------------
   Steps
   ------------------------------------------------------------------------- */

export const STEP_CATEGORIES = ["messages", "timing", "logic", "patient", "appointment", "conversation", "team"] as const;
export type StepCategory = (typeof STEP_CATEGORIES)[number];

const media = z
  .object({
    path: z.string().min(1).max(400),
    kind: z.enum(["image", "document"]),
    name: z.string().max(200).default(""),
    mime: z.string().max(100).default(""),
  })
  .nullable()
  .default(null);

const replyOption = z.object({
  label: z.string().max(40).default(""),
  keywords: z.array(z.string().min(1).max(60)).max(20).default([]),
});

const STEP_SCHEMAS = {
  send_whatsapp: z.object({ message: text(4000), media }),
  send_document: z.object({ template_id: z.string().default("") }),
  wait: z.object({
    mode: z.enum(["duration", "until_time", "appointment"]).default("duration"),
    amount: z.number().min(0).max(525600).default(1),
    unit: unit.default("hours"),
    time: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    direction: z.enum(["before", "after"]).default("before"),
  }),
  wait_for_reply: z.object({
    amount: z.number().min(1).max(525600).default(24),
    unit: unit.default("hours"),
    options: z.array(replyOption).max(6).default([]),
  }),
  condition: z.object({
    match: z.enum(["all", "any"]).default("all"),
    rules: z.array(ruleSchema).max(10).default([]),
  }),
  goto_automation: z.object({ automation_id: z.string().default("") }),
  stop: z.object({}),
  add_tag: z.object({ tag: text(40) }),
  remove_tag: z.object({ tag: text(40) }),
  update_patient: z.object({
    field: z.enum(["status", "custom"]).default("status"),
    status: z.enum(PATIENT_STATUSES).default("active"),
    key: text(80),
    value: text(500),
  }),
  add_note: z.object({ body: text(4000) }),
  update_appointment: z.object({ status: z.enum(["confirmed", "cancelled"]).default("confirmed") }),
  assign_conversation: z.object({
    target: z.enum(["member", "appointment_doctor", "nobody"]).default("member"),
    member_id: z.string().default(""),
  }),
  set_ai: z.object({
    mode: z.enum(["pause", "off", "on"]).default("pause"),
    amount: z.number().min(1).max(10080).default(24),
    unit: unit.default("hours"),
  }),
  flag_conversation: z.object({ reason: text(200) }),
  close_conversation: z.object({}),
  create_task: z.object({
    title: text(200),
    body: text(2000),
    due_amount: z.number().min(0).max(525600).default(1),
    due_unit: unit.default("days"),
    assignee: z.enum(["nobody", "member", "appointment_doctor"]).default("nobody"),
    member_id: z.string().default(""),
  }),
  notify_staff: z.object({
    title: text(200),
    body: text(1000),
    roles: z.array(z.enum(["owner", "doctor", "receptionist"])).max(3).default([]),
    member_ids: z.array(z.string()).max(50).default([]),
    appointment_doctor: z.boolean().default(false),
  }),
} as const;

export type StepKey = keyof typeof STEP_SCHEMAS;
export const STEP_KEYS = Object.keys(STEP_SCHEMAS) as StepKey[];
export type StepConfig<K extends StepKey> = z.infer<(typeof STEP_SCHEMAS)[K]>;

export type StepDef = {
  key: StepKey;
  category: StepCategory;
  /** What the trigger must provide for this step to do anything. */
  needs: Ctx[];
  module?: Module;
};

export const STEPS: StepDef[] = [
  { key: "send_whatsapp", category: "messages", needs: [], module: "conversations" },
  { key: "send_document", category: "messages", needs: ["patient"], module: "documents" },
  { key: "wait", category: "timing", needs: [] },
  { key: "wait_for_reply", category: "timing", needs: [], module: "conversations" },
  { key: "condition", category: "logic", needs: [] },
  { key: "goto_automation", category: "logic", needs: [] },
  { key: "stop", category: "logic", needs: [] },
  { key: "add_tag", category: "patient", needs: ["patient"] },
  { key: "remove_tag", category: "patient", needs: ["patient"] },
  { key: "update_patient", category: "patient", needs: ["patient"] },
  { key: "add_note", category: "patient", needs: ["patient"] },
  { key: "update_appointment", category: "appointment", needs: ["appointment"], module: "calendar" },
  { key: "assign_conversation", category: "conversation", needs: [], module: "conversations" },
  { key: "set_ai", category: "conversation", needs: [], module: "conversations" },
  { key: "flag_conversation", category: "conversation", needs: [], module: "conversations" },
  { key: "close_conversation", category: "conversation", needs: [], module: "conversations" },
  { key: "create_task", category: "team", needs: [] },
  { key: "notify_staff", category: "team", needs: [] },
];

export function stepDef(key: string): StepDef | undefined {
  return STEPS.find((s) => s.key === key);
}

export function isStepKey(key: string): key is StepKey {
  return key in STEP_SCHEMAS;
}

/**
 * The ways out of a step, each an edge on the canvas.
 *
 * Waiting for a reply with answers to listen for has one way out per answer,
 * then "anything else" and "no reply"; without any, simply "replied" and "no
 * reply". A stop has none at all.
 */
export function stepOutputs(key: string, config: Record<string, unknown> = {}): string[] {
  if (key === "stop") return [];
  if (key === "condition") return ["yes", "no"];
  if (key === "wait_for_reply") {
    const options = Array.isArray(config.options) ? config.options : [];
    return options.length ? [...options.map((_, i) => `opt:${i}`), "other", "timeout"] : ["replied", "timeout"];
  }
  return ["next"];
}

function minutesToAmount(minutes: number): { amount: number; unit: "minutes" | "hours" | "days" } {
  if (minutes > 0 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: "days" };
  if (minutes > 0 && minutes % 60 === 0) return { amount: minutes / 60, unit: "hours" };
  return { amount: minutes, unit: "minutes" };
}

/**
 * A step's config in today's shape, from whatever is stored.
 *
 * Flows saved by the old builder keep running unchanged: a wait of `{minutes,
 * until_time}`, an if/else of `{kind, tag}`, a task's `due_in_minutes`. The
 * worker reads through this, and so does the builder, so the first save of an
 * old flow quietly writes it back in the new shape.
 */
export function normalizeStepConfig(key: string, raw: unknown): Record<string, unknown> {
  const cfg: Record<string, unknown> = { ...((raw as Record<string, unknown>) ?? {}) };

  if (key === "wait" && !("mode" in cfg)) {
    // The old engine read a missing `minutes` as no delay at all.
    const m = minutesToAmount(Math.max(0, Number(cfg.minutes ?? 0) || 0));
    const until = typeof cfg.until_time === "string" && /^\d{2}:\d{2}$/.test(cfg.until_time) ? cfg.until_time : "";
    delete cfg.minutes;
    delete cfg.until_time;
    Object.assign(cfg, until ? { mode: "until_time", time: until, ...m } : { mode: "duration", ...m });
  }

  if (key === "condition" && !Array.isArray(cfg.rules)) {
    const kind = String(cfg.kind ?? "has_tag");
    const rule: Record<string, unknown> = { kind };
    if (kind === "has_tag") rule.value = String(cfg.tag ?? "");
    if (kind === "appointment_status") rule.values = [String(cfg.status ?? "confirmed")];
    cfg.match = "all";
    cfg.rules = (RULE_KINDS as readonly string[]).includes(kind) ? [rule] : [];
    delete cfg.kind;
    delete cfg.tag;
    delete cfg.status;
  }

  if (key === "create_task" && "due_in_minutes" in cfg && !("due_amount" in cfg)) {
    const m = minutesToAmount(Math.max(0, Number(cfg.due_in_minutes) || 0));
    cfg.due_amount = m.amount;
    cfg.due_unit = m.unit;
    delete cfg.due_in_minutes;
  }

  if (key === "notify_staff" && !("member_ids" in cfg) && !Array.isArray(cfg.roles)) {
    // The old step defaulted an empty audience to the owner and reception.
    cfg.roles = ["owner", "receptionist"];
  }

  if (!isStepKey(key)) return cfg;
  const parsed = STEP_SCHEMAS[key].safeParse(cfg);
  return parsed.success ? (parsed.data as Record<string, unknown>) : cfg;
}

export function parseStepConfig(key: string, raw: unknown) {
  if (!isStepKey(key)) return { success: false as const };
  return STEP_SCHEMAS[key].safeParse(raw ?? {});
}

export function defaultStepConfig(key: StepKey): Record<string, unknown> {
  const base = STEP_SCHEMAS[key].parse({}) as Record<string, unknown>;
  if (key === "notify_staff") base.roles = ["owner", "receptionist"];
  if (key === "wait") Object.assign(base, { amount: 1, unit: "hours" });
  return base;
}

export function defaultTriggerConfig(key: TriggerKey): Record<string, unknown> {
  return TRIGGER_SCHEMAS[key].parse({}) as Record<string, unknown>;
}

export function toMinutes(amount: number, u: string): number {
  return u === "days" ? amount * 1440 : u === "hours" ? amount * 60 : amount;
}

/* -------------------------------------------------------------------------
   Flow settings
   ------------------------------------------------------------------------- */

export const EXIT_EVENTS = ["appointment_cancelled", "appointment_booked", "invoice_paid", "document_signed", "patient_replied"] as const;
export type ExitEvent = (typeof EXIT_EVENTS)[number];

/** What each early exit has to be able to look at. */
export const EXIT_NEEDS: Record<ExitEvent, Ctx> = {
  appointment_cancelled: "appointment",
  appointment_booked: "patient",
  invoice_paid: "invoice",
  document_signed: "document",
  patient_replied: "patient",
};

export const settingsSchema = z.object({
  /** How often one patient may go through: every time, once ever, or once per N days. */
  reentry: z.enum(["always", "once", "cooldown"]).default("always"),
  cooldown_days: z.number().int().min(1).max(3650).default(30),
  /** Stop a waiting run early when one of these has happened. */
  exit_on: z.array(z.enum(EXIT_EVENTS)).max(EXIT_EVENTS.length).default([]),
});
export type FlowSettings = z.infer<typeof settingsSchema>;

export function normalizeSettings(raw: unknown): FlowSettings {
  const parsed = settingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

/**
 * Sensible settings for a new flow on this trigger.
 *
 * A reminder that is still waiting when its appointment is cancelled should not
 * go out; a chase for an invoice should stop once it is paid; a reply flow
 * should not fire on every message somebody sends in one conversation. Existing
 * flows keep `{}`, which is exactly how they behaved before.
 */
export function defaultSettingsFor(trigger: string): FlowSettings {
  const s = settingsSchema.parse({});
  const def = triggerDef(trigger);
  if (!def) return s;
  if (def.provides.includes("appointment") && trigger !== "appointment_status_changed") {
    s.exit_on = ["appointment_cancelled"];
  }
  if (trigger === "invoice_sent" || trigger === "invoice_unpaid") s.exit_on = ["invoice_paid"];
  if (trigger === "document_sent" || trigger === "document_unsigned" || trigger === "document_viewed") {
    s.exit_on = ["document_signed"];
  }
  if (trigger === "inbound_message" || trigger === "conversation_unanswered") {
    s.reentry = "cooldown";
    s.cooldown_days = 1;
  }
  if (trigger === "patient_created" || trigger === "birthday") s.reentry = "always";
  return s;
}
