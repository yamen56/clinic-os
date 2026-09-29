"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { prefKeyFor } from "@/lib/notification-kinds";
import {
  BellRing,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  ChartColumn,
  FileSignature,
  MessageCircle,
  Pill,
  Receipt,
  Sparkles,
  TriangleAlert,
  Workflow,
  X,
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
};

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
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === "suspended") void audio.resume();
    const now = audio.currentTime;
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

  const live = useRef({ prefs, onList });
  live.current = { prefs, onList };

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/me/notifications?since=${encodeURIComponent(since.current)}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = (await res.json()) as { notifications: LiveNotif[]; unread: number };
    setUnread(data.unread);
    if (!data.notifications.length) return;
    since.current = data.notifications[0].cursor;
    const fresh = data.notifications.filter((n) => !shown.current.has(n.id));
    for (const n of fresh) shown.current.add(n.id);
    if (!fresh.length) return;
    const { prefs: p, onList: here } = live.current;
    if (!p.popups || here || document.visibilityState !== "visible") return;
    setPopups((cur) => [...fresh.slice().reverse(), ...cur.filter((x) => !fresh.some((f) => f.id === x.id))].slice(-MAX_POPUPS));
    if (p.sound) chime();
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

  return { unread, popups, dismiss };
}

function iconFor(kind: string) {
  if (kind === "appointment_cancelled") return CalendarX;
  if (kind === "appointment_rescheduled" || kind === "doctor_reminder") return CalendarClock;
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
    void fetch("/api/me/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: n.id }),
    }).catch(() => {});
    if (n.url) router.push(n.url);
  };

  return (
    <div
      role="region"
      aria-live="polite"
      aria-label={t.nav.notifications}
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[70] flex flex-col items-center gap-2 px-4 md:inset-x-auto md:end-5 md:top-5 md:w-[22rem] md:items-stretch md:px-0"
    >
      {items.map((n) => (
        <Popup key={n.id} n={n} onOpen={() => open(n)} onClose={() => onDismiss(n.id)} closeLabel={t.common.close} />
      ))}
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
