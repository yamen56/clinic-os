"use client";

import { useEffect, useRef } from "react";

export type RealtimeEvent = { t: string; op: string; id?: string };

/**
 * Subscribes to the clinic's SSE event stream. Reconnection is handled by
 * EventSource itself; after a dropped connection we fire onEvent(null) so the
 * caller can silently refetch anything missed.
 *
 * The tables go to the server as well as being checked here, so a tab watching
 * the calendar is not sent every message a campaign delivers only to throw it
 * away. The check here stays: it is what keeps a caller correct against a
 * server that has not been deployed with the filter yet.
 */
export function useRealtime(
  slug: string,
  tables: string[],
  onEvent: (e: RealtimeEvent | null) => void
) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const tablesKey = tables.join(",");

  useEffect(() => {
    const wanted = new Set(tablesKey.split(",").filter(Boolean));
    let es: EventSource | null = null;
    let wasDown = false;
    let closed = false;

    const open = () => {
      if (closed) return;
      const qs = wanted.size ? `?t=${encodeURIComponent(tablesKey)}` : "";
      es = new EventSource(`/api/c/${slug}/events${qs}`);
      es.onopen = () => {
        if (wasDown) {
          wasDown = false;
          cb.current(null); // resync after silent reconnect
        }
      };
      es.onerror = () => {
        wasDown = true; // EventSource auto-retries per `retry:` hint
      };
      es.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data);
          if (wanted.size === 0 || wanted.has(e.t)) cb.current(e);
        } catch {}
      };
    };
    open();
    return () => {
      closed = true;
      es?.close();
    };
  }, [slug, tablesKey]);
}

/** How long the first event of a burst waits for the rest of it. */
const GATHER_MS = 250;
/** The closest two re-reads may follow each other while events keep coming. */
const MIN_GAP_MS = 1000;

/**
 * Re-reads what a screen shows when its tables change — once per burst, not
 * once per row.
 *
 * The triggers emit an event for every row written. Starting a campaign
 * inserts a recipient row per patient; one sent message moves queued → sent →
 * delivered → read. Handing each event straight to a refresh queued a full
 * round trip apiece, and Next runs `router.refresh()` calls one after the
 * other rather than folding them, so an open inbox during a 500-patient
 * campaign fetched its list and thread thousands of times to show a handful of
 * changes.
 *
 * Here the first event waits a moment for the rest of its burst, a refresh
 * never overlaps the previous one, and whatever arrives meanwhile is folded
 * into a single follow-up — so the last change is always read, and a steady
 * stream costs at most one re-read a second.
 *
 * `refresh` may return a promise; the next one waits for it to settle.
 * `match`, when given, drops events the screen does not care about before they
 * count.
 */
export function useRealtimeRefresh(
  slug: string,
  tables: string[],
  refresh: () => unknown,
  match?: (e: RealtimeEvent) => boolean
) {
  const run = useRef(refresh);
  run.current = refresh;
  const accept = useRef(match);
  accept.current = match;
  const s = useRef({
    timer: null as ReturnType<typeof setTimeout> | null,
    busy: false,
    again: false,
    last: 0,
    live: false,
  });

  useEffect(() => {
    const st = s.current;
    st.live = true;
    return () => {
      st.live = false;
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      st.again = false;
    };
  }, []);

  const schedule = () => {
    const st = s.current;
    if (!st.live || st.timer) return;
    if (st.busy) {
      st.again = true;
      return;
    }
    const wait = Math.max(GATHER_MS, st.last + MIN_GAP_MS - Date.now());
    st.timer = setTimeout(async () => {
      st.timer = null;
      st.busy = true;
      st.last = Date.now();
      try {
        await run.current();
      } catch {
        // A failed re-read is retried by the next event, not here.
      } finally {
        st.busy = false;
        if (st.again) {
          st.again = false;
          schedule();
        }
      }
    }, wait);
  };

  useRealtime(slug, tables, (e) => {
    if (e && accept.current && !accept.current(e)) return;
    schedule();
  });
}
