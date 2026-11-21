"use client";

import { useEffect, useState } from "react";

/*
  The clinic's clock and the shape of its day, for the welcome banner
  (Yamen, 2026-11-21: "I am thinking to add the time").

  Always the clinic's own time zone, not the device's: a doctor on holiday
  abroad still sees what time it is in the waiting room. Ticks on the minute,
  not every second — a clock that counts seconds pulls the eye all day.
*/

/** Hour, minute and the morning/evening mark, as the locale writes them. */
export function clockParts(intl: string, tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat(intl, { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { time: `${get("hour")}:${get("minute")}`, period: get("dayPeriod") };
}

/** Minutes since midnight in the clinic's zone. */
export function minuteOfDay(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return n("hour") * 60 + n("minute");
}

/**
 * Now, re-read at each minute boundary and whenever the tab comes back into
 * view (a laptop opened in the morning must not show last night's time).
 * Starts from the server's moment, so the first paint matches the HTML.
 */
function useNow(serverNow: number): Date {
  const [now, setNow] = useState(() => new Date(serverNow));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    tick();
    const onShow = () => document.visibilityState === "visible" && setNow(new Date());
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, []);
  return now;
}

export function LiveClock({
  intl,
  tz,
  serverNow,
  compact = false,
}: {
  intl: string;
  tz: string;
  serverNow: number;
  /** One line of small text, for the phone's slim welcome. */
  compact?: boolean;
}) {
  const now = useNow(serverNow);
  const { time, period } = clockParts(intl, tz, now);
  if (compact) {
    return (
      <time dateTime={now.toISOString()} className="tnum" data-clock suppressHydrationWarning>
        {time} {period}
      </time>
    );
  }
  return (
    <time dateTime={now.toISOString()} className="flex items-baseline gap-1.5 leading-none" data-clock suppressHydrationWarning>
      <span className="font-display text-[2.5rem] font-semibold tracking-tight tnum md:text-[3rem]" suppressHydrationWarning>
        {time}
      </span>
      <span className="text-sm font-medium text-white/60" suppressHydrationWarning>
        {period}
      </span>
    </time>
  );
}

export type DayDot = { id: string; min: number; kind: "done" | "here" | "next"; label: string };

/**
 * The day as one line: the opening hours lit, each booking a dot where it
 * falls (dim once finished, amber while the patient is in the building, an
 * open ring still to come), and a bright point at now with the elapsed part
 * of the day trailing behind it. Runs with the reading direction — in Arabic
 * the morning is on the right. The list below it is the accessible version,
 * so this is hidden from screen readers.
 */
export function DayStrip({
  tz,
  intl,
  serverNow,
  from,
  to,
  open,
  dots,
}: {
  tz: string;
  intl: string;
  serverNow: number;
  /** The span drawn, in minutes since midnight; whole hours. */
  from: number;
  to: number;
  /** The clinic's opening ranges today, in minutes since midnight. */
  open: [number, number][];
  dots: DayDot[];
}) {
  const now = useNow(serverNow);
  const span = Math.max(60, to - from);
  const pct = (m: number) => Math.min(100, Math.max(0, ((m - from) / span) * 100));
  const nowPct = pct(minuteOfDay(tz, now));

  const hours = span / 60;
  const step = hours <= 6 ? 60 : hours <= 12 ? 120 : 180;
  const ticks: number[] = [];
  for (let m = Math.ceil(from / step) * step; m <= to; m += step) ticks.push(m);
  const hourLabel = (m: number) => {
    const d = new Date(Date.UTC(2000, 0, 1, Math.floor(m / 60) % 24, 0));
    return new Intl.DateTimeFormat(intl, { timeZone: "UTC", hour: "numeric", hour12: true }).format(d);
  };

  return (
    <div className="relative h-9 min-w-0" aria-hidden data-day-strip>
      <div className="absolute inset-x-0 top-[7px] h-1 rounded-full bg-white/10">
        {open.map(([o, c]) => (
          <div
            key={`${o}-${c}`}
            className="absolute inset-y-0 rounded-full bg-white/20"
            style={{ insetInlineStart: `${pct(o)}%`, width: `${pct(c) - pct(o)}%` }}
          />
        ))}
        <div
          className="absolute inset-y-0 start-0 rounded-full bg-gradient-to-r from-white/0 to-white/55 rtl:bg-gradient-to-l"
          style={{ width: `${nowPct}%` }}
          suppressHydrationWarning
        />
      </div>
      {dots.map((d) => (
        <span
          key={d.id}
          title={d.label}
          data-day-dot={d.kind}
          className={`absolute top-[4.5px] h-[9px] w-[9px] -translate-x-1/2 rounded-full rtl:translate-x-1/2 ${
            d.kind === "done"
              ? "bg-white/45"
              : d.kind === "here"
                ? "bg-amber-400 shadow-[0_0_0_2px_rgb(0_0_0/0.6)]"
                : "bg-black ring-[1.5px] ring-white/85"
          }`}
          style={{ insetInlineStart: `${pct(d.min)}%` }}
        />
      ))}
      <span
        className="absolute top-[3px] h-3 w-3 -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_3px_rgb(255_255_255/0.18),0_0_14px_rgb(255_255_255/0.7)] rtl:translate-x-1/2"
        style={{ insetInlineStart: `${nowPct}%` }}
        data-day-now
        suppressHydrationWarning
      />
      {ticks.map((m) => {
        const p = pct(m);
        const edge = p <= 0.5 ? "" : p >= 99.5 ? "-translate-x-full rtl:translate-x-full" : "-translate-x-1/2 rtl:translate-x-1/2";
        return (
          <span
            key={m}
            className={`absolute top-5 whitespace-nowrap text-[length:max(10px,0.6875rem)] text-white/45 tnum ${edge}`}
            style={{ insetInlineStart: `${p}%` }}
          >
            {hourLabel(m)}
          </span>
        );
      })}
    </div>
  );
}
