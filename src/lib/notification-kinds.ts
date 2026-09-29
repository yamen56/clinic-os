import { DateTime } from "luxon";

/**
 * Every kind of notification, and how each one is delivered.
 *
 * Two questions used to be answered in three places. Which personal switch
 * silences a kind lived in the worker as a chain of ternaries that knew five of
 * the twenty-odd kinds — so muting "new bookings" silenced bookings from the
 * booking link but not the ones the AI receptionist made. Which kinds are urgent
 * was a separate set in the same file. And the preferences page kept its own
 * list of switches, one of which ("Cancellations") controlled a notification
 * nothing ever sent.
 *
 * Now there is this file. The page draws its rows from it, `notify` reads it to
 * drop what somebody switched off, and the worker reads it to decide whether a
 * row goes to the phone, when, and how hard it knocks.
 *
 * Imported by the worker, so it must stay inside `src/lib` and must not reach
 * anything outside it (see qa-worker-image).
 */

/** How somebody wants to hear about one kind of thing. */
export type NotificationLevel = "push" | "app" | "off";

/**
 * The personal switches, one per row on the preferences page.
 *
 * The first six keys are the ones already stored in people's preferences and
 * must keep their spelling: a renamed key would silently switch back on
 * everything anybody had muted.
 */
export const PREF_KEYS = [
  "doctor_reminder",
  "daily_summary",
  "new_booking",
  "cancellation",
  "unread_digest",
  "day_end",
  "tomorrow_schedule",
  "unconfirmed_tomorrow",
  "weekly_summary",
  "ai_escalation",
  "documents",
  "prescriptions",
  "billing",
  "whatsapp",
  "automation",
] as const;
export type PrefKey = (typeof PREF_KEYS)[number];

export type PrefGroup = "schedule" | "summaries" | "patients" | "clinic";

/** Who a switch is shown to — what they can actually be sent. */
export type Audience = {
  role: "doctor" | "receptionist" | "other";
  isOwner: boolean;
  caps: Record<string, boolean>;
  /** Scheduled/instant team-alert kinds the clinic currently sends to this person. */
  alertKinds: ReadonlySet<string>;
};

export type PrefDef = {
  key: PrefKey;
  group: PrefGroup;
  /**
   * May not be switched off entirely, only kept off the phone. For what a
   * clinic cannot afford for nobody to hear: the WhatsApp number going down,
   * the AI receptionist handing a patient back.
   */
  lockOff?: boolean;
  /** Whether this person could ever be sent it, which decides if the row is shown. */
  shownTo: (a: Audience) => boolean;
};

const frontDesk = (a: Audience) => a.isOwner || a.role === "receptionist";

export const PREF_DEFS: PrefDef[] = [
  // What is happening to the diary
  {
    key: "new_booking",
    group: "schedule",
    shownTo: (a) => frontDesk(a) || a.alertKinds.has("appointment_booked"),
  },
  {
    key: "cancellation",
    group: "schedule",
    shownTo: (a) =>
      a.alertKinds.has("appointment_cancelled") || a.alertKinds.has("appointment_rescheduled"),
  },
  { key: "doctor_reminder", group: "schedule", shownTo: (a) => a.alertKinds.has("appointment_reminder") },

  // Summaries at a fixed hour
  { key: "daily_summary", group: "summaries", shownTo: (a) => a.alertKinds.has("day_schedule") },
  { key: "tomorrow_schedule", group: "summaries", shownTo: (a) => a.alertKinds.has("tomorrow_schedule") },
  {
    key: "unconfirmed_tomorrow",
    group: "summaries",
    shownTo: (a) => a.alertKinds.has("unconfirmed_tomorrow"),
  },
  { key: "day_end", group: "summaries", shownTo: (a) => a.alertKinds.has("day_end") },
  { key: "weekly_summary", group: "summaries", shownTo: (a) => a.alertKinds.has("weekly_summary") },
  { key: "unread_digest", group: "summaries", shownTo: (a) => a.alertKinds.has("unread_digest") },

  // Patients reaching the clinic
  { key: "ai_escalation", group: "patients", lockOff: true, shownTo: frontDesk },
  { key: "documents", group: "patients", shownTo: (a) => a.caps.documents === true },
  {
    key: "prescriptions",
    group: "patients",
    shownTo: (a) => a.role === "doctor",
  },

  // The clinic itself
  { key: "billing", group: "clinic", shownTo: (a) => frontDesk(a) && a.caps.invoices === true },
  { key: "whatsapp", group: "clinic", lockOff: true, shownTo: (a) => a.isOwner },
  { key: "automation", group: "clinic", shownTo: () => true },
];

const PREF_BY_KEY = new Map(PREF_DEFS.map((d) => [d.key, d]));

/**
 * Which switch silences a notification kind. `null` means none does: a test
 * the person asked for, or an integrity failure on a signed document, which is
 * never somebody's preference to miss.
 */
export function prefKeyFor(kind: string): PrefKey | null {
  switch (kind) {
    case "booking":
    case "ai_booking":
    case "waitlist_booked":
    case "appointment_booked":
      return "new_booking";
    case "appointment_cancelled":
    case "appointment_rescheduled":
      return "cancellation";
    case "doctor_reminder":
      return "doctor_reminder";
    case "daily_summary":
      return "daily_summary";
    case "tomorrow_schedule":
    case "unconfirmed_tomorrow":
    case "day_end":
    case "weekly_summary":
    case "unread_digest":
    case "ai_escalation":
    case "automation":
      return kind;
    case "prescription_in_your_name":
      return "prescriptions";
    case "einvoice_failed":
      return "billing";
    case "document_integrity":
    case "test":
      return null;
  }
  if (kind.startsWith("document_")) return "documents";
  if (kind.startsWith("whatsapp_")) return "whatsapp";
  return null;
}

/**
 * What somebody chose for one switch.
 *
 * Preferences written before levels existed are booleans, and `false` meant
 * "not on my phone" — the row still landed in the app. It keeps meaning exactly
 * that, so nobody's muted digest starts buzzing again or vanishes from the list.
 */
export function levelOf(prefs: Record<string, unknown> | null | undefined, key: PrefKey | null): NotificationLevel {
  if (!key) return "push";
  const v = prefs?.[key];
  if (v === false || v === "app") return "app";
  if (v === "off") return PREF_BY_KEY.get(key)?.lockOff ? "app" : "off";
  return "push";
}

export function parseLevel(v: unknown): NotificationLevel | null {
  return v === "push" || v === "app" || v === "off" ? v : null;
}

/**
 * How a kind behaves on its way to the phone.
 *
 *   urgent         may break through quiet hours if the person allows it, and
 *                  falls back to their own WhatsApp when they have no device;
 *   prompt         asks the push service for high urgency, which is what gets
 *                  it through a phone's battery saving now rather than later;
 *   dropWhenQuiet  worthless late, so not held through quiet hours — it is in
 *                  the app, and the phone is simply not told;
 *   ttl            how long a push service keeps trying while the phone is off.
 */
export type KindDelivery = { urgent: boolean; prompt: boolean; dropWhenQuiet: boolean; ttl: number };

const URGENT = new Set([
  "whatsapp_disconnected",
  "whatsapp_errors",
  "whatsapp_undelivered",
  "whatsapp_blast_guard",
  "ai_escalation",
  "document_integrity",
]);
/** The subset that also reaches a staff member's own WhatsApp when push cannot. */
export const WHATSAPP_FALLBACK = new Set(["whatsapp_disconnected", "whatsapp_errors", "ai_escalation"]);

export function deliveryFor(kind: string): KindDelivery {
  if (URGENT.has(kind)) return { urgent: true, prompt: true, dropWhenQuiet: false, ttl: 6 * 3600 };
  // "Your patient is in ten minutes" at seven the next morning is noise.
  if (kind === "doctor_reminder") return { urgent: false, prompt: true, dropWhenQuiet: true, ttl: 30 * 60 };
  if (
    kind === "booking" ||
    kind === "ai_booking" ||
    kind === "waitlist_booked" ||
    kind.startsWith("appointment_") ||
    kind === "test"
  ) {
    return { urgent: false, prompt: true, dropWhenQuiet: false, ttl: 3 * 3600 };
  }
  return { urgent: false, prompt: false, dropWhenQuiet: false, ttl: 3 * 3600 };
}

/**
 * Whether a switch can silence a kind before it is even written. Not for the
 * ones that must reach somebody — for those "off" is stored as "app" by the
 * preferences page, and this keeps a hand-edited "off" from winning either.
 */
export function mutableKey(key: PrefKey | null): PrefKey | null {
  return key && !PREF_BY_KEY.get(key)?.lockOff ? key : null;
}

/** Quiet hours as stored: local clock times in the clinic's own timezone. */
export type QuietHours = { on: boolean; from: string; to: string; urgent: boolean };

export const DEFAULT_QUIET: QuietHours = { on: false, from: "22:00", to: "07:00", urgent: true };

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseQuiet(raw: unknown): QuietHours {
  const q = (raw ?? {}) as Partial<QuietHours>;
  return {
    on: q.on === true,
    from: typeof q.from === "string" && HM.test(q.from) ? q.from : DEFAULT_QUIET.from,
    to: typeof q.to === "string" && HM.test(q.to) ? q.to : DEFAULT_QUIET.to,
    urgent: q.urgent !== false,
  };
}

const minutesOf = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};

/**
 * When the quiet period `now` falls inside ends, or null if it does not.
 *
 * Handles the ordinary overnight case (22:00 → 07:00) as well as a window
 * inside one day (13:00 → 15:00). Equal ends mean no window at all rather than
 * a whole day of silence, which is never what somebody typing it meant.
 */
export function quietUntil(q: QuietHours, now: DateTime): DateTime | null {
  if (!q.on) return null;
  const from = minutesOf(q.from);
  const to = minutesOf(q.to);
  if (from === to) return null;
  const cur = now.hour * 60 + now.minute;
  const inside = from < to ? cur >= from && cur < to : cur >= from || cur < to;
  if (!inside) return null;
  const end = now.startOf("day").plus({ minutes: to });
  return end > now ? end : end.plus({ days: 1 });
}
