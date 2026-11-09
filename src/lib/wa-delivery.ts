/**
 * Why a WhatsApp message is where it is.
 *
 * Every outbound message ends in one of two places: on the patient's phone, or
 * somewhere a person can see why it is not. Before this, a message could sit at
 * one grey tick for ever — rejected by WhatsApp, sent to a number with no
 * account, cancelled because its appointment had passed — looking exactly like
 * one that was on its way. The reasons were either never recorded or recorded
 * and never shown.
 *
 * The worker writes a reason code into `messages.error`; the inbox, the
 * automation history and Settings → WhatsApp all read it back through
 * `deliveryNote`, so one message says the same thing wherever it is looked at.
 * Pure on purpose: the worker, the server and the browser all import it.
 */

/** What the worker writes into `messages.error`. */
export const WA_REASON = {
  /** WhatsApp says the number has no account. */
  noAccount: "no_whatsapp_account",
  /** WhatsApp's server refused the message; the code is its own. */
  rejected: (code: string) => `wa_rejected:${code}`,
  /** Cancelled: an automation reminder whose appointment began before it could go. */
  appointmentPassed: "appointment_passed",
  /** Cancelled: an automation message that waited more than three days. */
  expired: "expired",
  /** The attached file is gone from storage. */
  mediaMissing: "media_missing",
  /** The connection kept dropping mid-send, past every retry. */
  connectionLost: "connection_lost",
  /** Still queued, held back by a rail and due at `scheduled_at`. */
  heldDailyCap: "held:daily_cap",
  heldWarmupCap: "held:warmup_cap",
  heldBlastGuard: "held:blast_guard",
} as const;

/**
 * A sent message with no delivery receipt after this long is reported as not
 * delivered. WhatsApp acknowledges delivery within seconds when the phone is
 * online; six hours covers a phone left off overnight without crying wolf.
 */
export const UNDELIVERED_AFTER_HOURS = 6;

/** Errors from the socket rather than the message: the same message sends once it is back. */
const CONNECTION_ERROR =
  /connection (closed|lost|terminated|failure)|timed out|stream errored|not open|socket hang up|econnreset|epipe|precondition required|websocket/i;
export const isConnectionError = (msg: string) => CONNECTION_ERROR.test(msg);

export type FailReason =
  | "noAccount"
  | "restricted"
  | "staleAddress"
  | "rejected"
  | "mediaMissing"
  | "connectionLost"
  | "other";

export type WaitReason =
  | "disconnected"
  | "dailyCap"
  | "warmupCap"
  | "blastGuard"
  | "paused"
  | "scheduled"
  | "retrying";

export type DeliveryNote =
  | { kind: "failed"; reason: FailReason; code?: string; detail?: string }
  | { kind: "cancelled"; reason: "appointmentPassed" | "expired" | "other" }
  | { kind: "waiting"; reason: WaitReason; at?: string | null; detail?: string }
  | { kind: "undelivered" }
  | null;

/** A timestamp as it arrives: an ISO string from JSON, a Date straight from pg. */
type Stamp = string | Date;

export type DeliveryInput = {
  direction: string;
  status: string;
  error: string | null;
  created_at: Stamp;
  scheduled_at?: Stamp | null;
  sent_at?: Stamp | null;
  delivered_at?: Stamp | null;
};

export type SessionState = {
  /** The clinic's WhatsApp is linked and online right now. */
  connected: boolean;
  /** The sender paused itself (repeated failures, blast guard) until then. */
  pausedUntil?: Stamp | null;
};

const iso = (s: Stamp | null | undefined): string | null => (s ? new Date(s).toISOString() : null);

/** Why a failed message failed, read from the stored code (or a legacy raw error). */
export function failureReason(error: string | null): { reason: FailReason; code?: string; detail?: string } {
  if (!error) return { reason: "other" };
  if (error === WA_REASON.noAccount) return { reason: "noAccount" };
  if (error.startsWith("wa_rejected:")) {
    const code = error.slice("wa_rejected:".length);
    // 463: no privacy token — WhatsApp is not letting this number start new chats.
    if (code === "463") return { reason: "restricted", code };
    // 479: the stanza named devices the patient no longer has.
    if (code === "479") return { reason: "staleAddress", code };
    return { reason: "rejected", code };
  }
  if (error === WA_REASON.mediaMissing || /media file missing/i.test(error)) return { reason: "mediaMissing" };
  if (error === WA_REASON.connectionLost || isConnectionError(error)) return { reason: "connectionLost" };
  return { reason: "other", detail: error };
}

export function deliveryNote(m: DeliveryInput, session: SessionState, now = Date.now()): DeliveryNote {
  if (m.direction !== "out") return null;

  if (m.status === "failed") return { kind: "failed", ...failureReason(m.error) };

  if (m.status === "cancelled") {
    return {
      kind: "cancelled",
      reason: m.error === WA_REASON.appointmentPassed ? "appointmentPassed" : m.error === WA_REASON.expired ? "expired" : "other",
    };
  }

  if (m.status === "queued" || m.status === "sending") {
    const at = iso(m.scheduled_at);
    const later = at ? new Date(at).getTime() > now + 60_000 : false;
    // Nothing else matters while there is no connection to send on.
    if (!session.connected) return { kind: "waiting", reason: "disconnected" };
    if (m.error === WA_REASON.heldDailyCap) return { kind: "waiting", reason: "dailyCap", at };
    if (m.error === WA_REASON.heldWarmupCap) return { kind: "waiting", reason: "warmupCap", at };
    if (m.error === WA_REASON.heldBlastGuard) return { kind: "waiting", reason: "blastGuard", at };
    if (session.pausedUntil && new Date(session.pausedUntil).getTime() > now) {
      return { kind: "waiting", reason: "paused", at: iso(session.pausedUntil) };
    }
    // An error on a queued message is the last attempt's: it is being tried again.
    if (m.error) return { kind: "waiting", reason: "retrying", at, detail: m.error };
    if (later) return { kind: "waiting", reason: "scheduled", at };
    return null;
  }

  if (m.status === "sent" && !m.delivered_at) {
    const since = new Date(m.sent_at ?? m.created_at).getTime();
    if (now - since > UNDELIVERED_AFTER_HOURS * 3600_000) return { kind: "undelivered" };
  }
  return null;
}

/**
 * Staff may send a message again when it never reached the phone — except a
 * reminder cancelled because its appointment had already begun. "See you at
 * ten" sent at eleven is the thing that cancellation exists to prevent, and
 * offering a button for it invites exactly that.
 */
export function canResend(note: DeliveryNote): boolean {
  if (!note) return false;
  if (note.kind === "cancelled") return note.reason !== "appointmentPassed";
  return note.kind === "failed" || note.kind === "undelivered";
}

/** The dictionary block `deliveryText` reads from (t.delivery). */
export type DeliveryWords = {
  failed: Record<FailReason, string>;
  cancelled: Record<"appointmentPassed" | "expired" | "other", string>;
  waiting: Record<WaitReason, string>;
  undelivered: string;
};

/**
 * The sentence for a note, with {code}, {detail} and {at} filled in. `fmtAt`
 * formats a timestamp in the clinic's zone; it is passed in so this file stays
 * free of date libraries.
 */
export function deliveryText(note: DeliveryNote, words: DeliveryWords, fmtAt: (iso: string) => string): string {
  if (!note) return "";
  const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
  if (note.kind === "failed") {
    return fill(words.failed[note.reason], { code: note.code ?? "", detail: (note.detail ?? "").slice(0, 120) });
  }
  if (note.kind === "cancelled") return words.cancelled[note.reason];
  if (note.kind === "undelivered") return words.undelivered;
  return fill(words.waiting[note.reason], { at: note.at ? fmtAt(note.at) : "" });
}
