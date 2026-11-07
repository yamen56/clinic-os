"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { prefKeyFor } from "@/lib/notification-kinds";
import { teamView } from "@/lib/team-view";
import { shortName } from "@/lib/team-chat-shared";
import { Avatar } from "@/components/ui/misc";
import {
  BellRing,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  ChartColumn,
  DoorOpen,
  FileSignature,
  MessageCircle,
  Pill,
  Receipt,
  Sparkles,
  TriangleAlert,
  Workflow,
  X,
  Package,
  MessagesSquare,
  Send,
  Check,
} from "lucide-react";

export type LiveNotif = {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  created_at: string;
  /** created_at at the database's precision; what `since` is set from. */
  cursor: string;
  /** A colleague it is from, for their face on the pop-up. */
  actor?: { userId: string; name: string; memberId: string | null; hasPhoto: boolean; color: string | null; slug: string | null } | null;
};

const isTeam = (kind: string) => kind === "team_message" || kind === "team_reaction";
/** The team thread a notification is about, from its link. */
const threadOf = (n: LiveNotif) => (n.url && isTeam(n.kind) ? new URL(n.url, "https://x").searchParams.get("t") : null);

export type InAppPrefs = { popups: boolean; sound: boolean };

/** Raised by the preferences page so the header follows a change without a reload. */
export const IN_APP_PREFS_EVENT = "clinicti:in-app-prefs";

/** How long a pop-up stays before it tidies itself away. */
const POPUP_MS = 8000;
/** More than this at once is a flood, not news; the rest wait in the list. */
const MAX_POPUPS = 3;

/**
 * A short two-note chime, made rather than downloaded.
 *
 * Browsers only allow sound after the person has touched the page, so the
 * first notification of a session that nobody has clicked into arrives silent.
 * That is the browser's rule, and trying to work around it is how a site gets
 * its sound blocked for good.
 */
let audio: AudioContext | null = null;
/**
 * A colleague's message has its own sound, softer and rounder than the chime:
 * the desk learns to tell "a colleague" from "a booking" without looking.
 */
function chime(kind?: string) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === "suspended") void audio.resume();
    const now = audio.currentTime;
    if (kind && isTeam(kind)) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(980, now + 0.09);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
      osc.connect(gain).connect(audio.destination);
      osc.start(now);
      osc.stop(now + 0.25);
      return;
    }
    for (const [i, freq] of [880, 1318.5].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    }
  } catch {}
}

function setAppBadge(n: number) {
  try {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (n > 0) void nav.setAppBadge?.(n).catch(() => {});
    else void nav.clearAppBadge?.().catch(() => {});
  } catch {}
}

/**
 * The header's live view of this person's notifications.
 *
 * A notification used to reach somebody in the app only if they happened to be
 * on the notifications page: the bell carried no count, and nothing on any
 * other screen changed when one arrived. Reception booked into by the AI
 * receptionist found out when they next wandered to that page.
 *
 * Now the count is live on the bell, and a new one appears on whatever screen
 * is open — at the moment it is written, through the same realtime stream the
 * screens already use. On the notifications page itself no pop-up is shown,
 * because the list there is already updating in place.
 *
 * `since` starts at the server's clock rather than the browser's. A laptop
 * whose clock runs a minute fast would otherwise ask for "everything after a
 * minute from now" and never see a pop-up at all.
 */
export function useLiveNotifications(
  slug: string,
  initial: { unread: number; serverNow: string; prefs: InAppPrefs }
) {
  const pathname = usePathname();
  const [unread, setUnread] = useState(initial.unread);
  const [popups, setPopups] = useState<LiveNotif[]>([]);
  const [prefs, setPrefs] = useState(initial.prefs);
  const since = useRef(initial.serverNow);
  // Belt and braces with the cursor: whatever has popped up once never pops up again.
  const shown = useRef(new Set<string>());
  const onList = pathname === `/c/${slug}/notifications`;
  // The team chat shows its own messages as they arrive; a pop-up on top would say it twice.
  const onTeam = pathname === `/c/${slug}/conversations/team`;

  const live = useRef({ prefs, onList, onTeam });
  live.current = { prefs, onList, onTeam };

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/me/notifications?since=${encodeURIComponent(since.current)}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = (await res.json()) as { notifications: LiveNotif[]; unread: number };
    setUnread(data.unread);
    if (!data.notifications.length) return;
    since.current = data.notifications[0].cursor;
    const all = data.notifications.filter((n) => !shown.current.has(n.id));
    for (const n of all) shown.current.add(n.id);
    // Not about the team thread already open in front of you: that thread says it itself.
    const fresh = all.filter((n) => !(live.current.onTeam && threadOf(n) && threadOf(n) === teamView.openThreadId));
    if (!fresh.length) return;
    const { prefs: p, onList: here } = live.current;
    if (!p.popups || here || document.visibilityState !== "visible") return;
    // A thread's newer line replaces its older pop-up rather than stacking under it.
    const threads = new Set(fresh.map(threadOf).filter(Boolean));
    setPopups((cur) =>
      [...fresh.slice().reverse(), ...cur.filter((x) => !fresh.some((f) => f.id === x.id) && !(threadOf(x) && threads.has(threadOf(x))))].slice(-MAX_POPUPS)
    );
    if (p.sound) chime(fresh[0].kind);
  }, []);

  // Re-read once the connection is live, for anything written between the
  // page being rendered and the stream opening.
  useRealtimeRefresh(slug, ["notifications"], refresh, undefined, { syncOnOpen: true });

  useEffect(() => setAppBadge(unread), [unread]);

  useEffect(() => {
    const onPrefs = (e: Event) => setPrefs((cur) => ({ ...cur, ...(e as CustomEvent<Partial<InAppPrefs>>).detail }));
    window.addEventListener(IN_APP_PREFS_EVENT, onPrefs);
    return () => window.removeEventListener(IN_APP_PREFS_EVENT, onPrefs);
  }, []);

  // Arriving on the list is seeing them; the pop-ups have done their job.
  useEffect(() => {
    if (onList) setPopups([]);
  }, [onList]);

  const dismiss = useCallback((id: string) => setPopups((xs) => xs.filter((x) => x.id !== id)), []);

  /*
    A pop-up raised on this screen rather than read from the notifications
    table — a doctor's patient arriving (components/appointments/arrival-alerts).
    Same preferences, same chime, same corner; its id starts `local:` so opening
    it does not try to mark a stored notification read. It sounds even when the
    tab is in the background: that is the point of a chime for somebody whose
    patient is waiting.
  */
  const push = useCallback((n: LiveNotif) => {
    if (shown.current.has(n.id)) return;
    shown.current.add(n.id);
    const { prefs: p } = live.current;
    if (n.kind === "team_message" && live.current.onTeam) return;
    if (p.sound) chime(n.kind);
    if (!p.popups) return;
    setPopups((cur) => [...cur.filter((x) => x.id !== n.id), n].slice(-MAX_POPUPS));
  }, []);

  return { unread, popups, dismiss, push };
}

function iconFor(kind: string) {
  if (kind === "patient_arrived") return DoorOpen;
  if (kind === "appointment_cancelled") return CalendarX;
  if (kind === "appointment_rescheduled" || kind === "doctor_reminder" || kind === "doctor_hours") return CalendarClock;
  const pref = prefKeyFor(kind);
  switch (pref) {
    case "new_booking":
      return CalendarPlus;
    case "ai_escalation":
      return Sparkles;
    case "documents":
      return FileSignature;
    case "unread_digest":
      return MessageCircle;
    case "prescriptions":
      return Pill;
    case "billing":
      return Receipt;
    case "whatsapp":
      return TriangleAlert;
    case "automation":
      return Workflow;
    case "stock":
      return Package;
    case "team":
      return MessagesSquare;
    case "daily_summary":
    case "tomorrow_schedule":
    case "unconfirmed_tomorrow":
    case "day_end":
    case "weekly_summary":
      return ChartColumn;
  }
  return BellRing;
}

const urgentLook = (kind: string) => kind.startsWith("whatsapp_") || kind === "ai_escalation" || kind === "document_integrity";

/**
 * The pop-ups themselves. Top corner on a desk, top of the screen on a phone —
 * away from the toasts, which rise from the bottom and answer the person's own
 * clicks; these announce somebody else's.
 */
export function NotificationPopups({
  items,
  onDismiss,
}: {
  items: LiveNotif[];
  onDismiss: (id: string) => void;
}) {
  const { t } = useI18n();
  const router = useRouter();

  const open = (n: LiveNotif) => {
    onDismiss(n.id);
    // A local pop-up has no stored row to mark read.
    if (!n.id.startsWith("local:")) {
      void fetch("/api/me/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: n.id }),
      }).catch(() => {});
    }
    if (n.url) router.push(n.url);
  };

  return (
    <div
      role="region"
      aria-live="polite"
      aria-label={t.nav.notifications}
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[70] flex flex-col items-center gap-2 px-4 md:inset-x-auto md:end-5 md:top-5 md:w-[22rem] md:items-stretch md:px-0"
    >
      {items.map((n) =>
        isTeam(n.kind) && n.actor ? (
          <TeamPopup key={n.id} n={n} onOpen={() => open(n)} onClose={() => onDismiss(n.id)} />
        ) : (
          <Popup key={n.id} n={n} onOpen={() => open(n)} onClose={() => onDismiss(n.id)} closeLabel={t.common.close} />
        )
      )}
    </div>
  );
}

function Popup({
  n,
  onOpen,
  onClose,
  closeLabel,
}: {
  n: LiveNotif;
  onOpen: () => void;
  onClose: () => void;
  closeLabel: string;
}) {
  const [hover, setHover] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;

  // Paused while the pointer rests on it: nobody should lose a notification
  // they are in the middle of reading.
  useEffect(() => {
    if (hover) return;
    const timer = setTimeout(() => close.current(), POPUP_MS);
    return () => clearTimeout(timer);
  }, [hover]);

  const Icon = iconFor(n.kind);
  const urgent = urgentLook(n.kind);

  return (
    <div
      data-notification-popup={n.kind}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card border border-line bg-surface p-3 shadow-pop animate-fade-up md:max-w-none"
    >
      <span
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          urgent ? "bg-st-pending-soft text-st-pending" : "bg-brand-100 text-brand-700"
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-start">
        <span className="block text-sm font-semibold leading-snug text-ink-900">{n.title}</span>
        {n.body && (
          <span className="mt-0.5 line-clamp-2 block whitespace-pre-line text-[13px] leading-snug text-ink-500">
            {n.body}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="-me-1 -mt-1 shrink-0 rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-sunken hover:text-ink-700"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * A colleague's message, as a chat app announces one: their face, their name and
 * where they wrote, what they said, and a box to answer without leaving the page
 * (Yamen, 2026-11-07: "notify the one who got the message in a premium way").
 * It stays while somebody types in it, and Mark as read clears the thread without
 * opening it.
 */
function TeamPopup({ n, onOpen, onClose }: { n: LiveNotif; onOpen: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const T = t.team;
  const [hover, setHover] = useState(false);
  const [reply, setReply] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const close = useRef(onClose);
  close.current = onClose;
  const a = n.actor!;
  const threadId = threadOf(n);
  const canReply = n.kind === "team_message" && !!threadId && !!a.slug;
  const busy = hover || reply.length > 0 || state === "sending";

  useEffect(() => {
    if (busy) return;
    const timer = setTimeout(() => close.current(), state === "sent" ? 1400 : POPUP_MS + 4000);
    return () => clearTimeout(timer);
  }, [busy, state]);

  const markRead = () => {
    if (threadId && a.slug) {
      void fetch(`/api/c/${a.slug}/team/${threadId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "read" }) }).catch(() => {});
    }
    void fetch("/api/me/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) }).catch(() => {});
    onClose();
  };

  const send = async () => {
    const body = reply.trim();
    if (!body || !threadId || !a.slug) return;
    setState("sending");
    const r = await fetch(`/api/c/${a.slug}/team/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), body }),
    }).catch(() => null);
    if (!r?.ok) {
      setState("idle");
      return;
    }
    setReply("");
    setState("sent");
    void fetch("/api/me/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) }).catch(() => {});
  };

  return (
    <div
      data-notification-popup={n.kind}
      data-team-popup
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-card border border-line bg-surface shadow-pop animate-fade-up md:max-w-none"
    >
      <div className="flex items-start gap-3 p-3">
        <button type="button" onClick={onOpen} className="relative shrink-0" tabIndex={-1} aria-hidden>
          <Avatar name={a.name} size={42} src={a.hasPhoto && a.memberId && a.slug ? `/api/c/${a.slug}/staff/${a.memberId}/photo` : null} color={a.color ?? undefined} />
          <span className="absolute -bottom-0.5 -end-0.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-brand-600 text-on-brand ring-2 ring-surface">
            <MessagesSquare className="h-2.5 w-2.5" strokeWidth={2.5} />
          </span>
        </button>
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-start" data-team-popup-open>
          <span className="block truncate text-[14px] font-semibold leading-snug text-ink-900" dir="auto">
            {n.title}
          </span>
          {n.body && (
            <span className="mt-0.5 line-clamp-3 block whitespace-pre-line text-[13.5px] leading-snug text-ink-700" dir="auto">
              {n.body}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.common.close}
          className="-me-1 -mt-1 shrink-0 rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-sunken hover:text-ink-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {canReply && (
        <div className="flex items-center gap-1.5 border-t border-line bg-sunken/60 px-2.5 py-2">
          {state === "sent" ? (
            <span className="flex h-9 flex-1 items-center gap-1.5 px-1 text-[13px] font-semibold text-st-confirmed" data-team-popup-sent>
              <Check className="h-4 w-4" />
              {T.sent}
            </span>
          ) : (
            <>
              <input
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={T.replyTo.replace("{name}", shortName(a.name))}
                maxLength={4000}
                dir="auto"
                className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-3 text-[16px] outline-none focus:border-brand-400 md:text-[13.5px]"
                data-team-popup-input
              />
              {reply.trim() ? (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={state === "sending"}
                  aria-label={T.send}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-600 text-on-brand disabled:opacity-60"
                  data-team-popup-send
                >
                  <Send className="h-4 w-4 rtl:rotate-180" />
                </button>
              ) : (
                <button type="button" onClick={markRead} className="h-9 shrink-0 rounded-full px-3 text-[12.5px] font-semibold text-brand-700 hover:bg-surface" data-team-popup-read>
                  {T.markRead}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
