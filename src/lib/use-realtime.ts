"use client";

import { useEffect, useRef } from "react";

export type RealtimeEvent = { t: string; op: string; id?: string };

type Sub = {
  tables: Set<string>;
  cb: { current: (e: RealtimeEvent | null) => void };
  /** Wants one resync once the connection carrying its tables is live. */
  syncOnOpen: boolean;
  synced: boolean;
};

type Stream = {
  slug: string;
  subs: Set<Sub>;
  es: EventSource | null;
  /** The table filter the open connection carries; "" is everything, null is closed. */
  key: string | null;
  wasDown: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * One connection per tab, shared by everything on the screen that listens.
 *
 * Each hook used to open its own EventSource. That was one per tab while only
 * the screen listened, and it became two when the header started listening for
 * notifications too — and a browser on HTTP/1.1 allows six connections to a
 * site across all of its tabs. At three tabs every request after that queues
 * behind the streams, and the app looks frozen with nothing in the console.
 *
 * So the subscriptions are pooled per clinic. The connection carries the union
 * of what its subscribers want, and is reopened only when that union changes —
 * which is on navigation, when the old screen's hook and the new one's swap in
 * the same moment. The new connection is opened before the old is closed, so no
 * event falls into the gap; the overlap can deliver one twice, which every
 * subscriber already tolerates, since all they do with an event is re-read.
 */
const streams = new Map<string, Stream>();

function unionKey(s: Stream): string | null {
  if (!s.subs.size) return null;
  const all = new Set<string>();
  for (const sub of s.subs) {
    if (!sub.tables.size) return "";
    for (const t of sub.tables) all.add(t);
  }
  return [...all].sort().join(",");
}

function dispatch(s: Stream, e: RealtimeEvent | null) {
  for (const sub of [...s.subs]) {
    if (e && sub.tables.size && !sub.tables.has(e.t)) continue;
    try {
      sub.cb.current(e);
    } catch {}
  }
}

/**
 * The first-open resync, for the subscribers that asked for one.
 *
 * What a screen shows was read when the page was rendered, and the connection
 * opens some moments later. Anything written in between arrives on no stream at
 * all, and the next event may be a long time coming. Most screens can live with
 * that gap; the unread badge cannot — it is the thing that says "something
 * happened" — so it asks to re-read once the connection is actually live.
 */
function syncNewcomers(s: Stream) {
  for (const sub of [...s.subs]) {
    if (!sub.syncOnOpen || sub.synced) continue;
    sub.synced = true;
    try {
      sub.cb.current(null);
    } catch {}
  }
}

function openStream(s: Stream, key: string) {
  const prev = s.es;
  const es = new EventSource(`/api/c/${s.slug}/events${key ? `?t=${encodeURIComponent(key)}` : ""}`);
  s.es = es;
  s.key = key;
  let handedOver = !prev;
  const handOver = () => {
    if (handedOver) return;
    handedOver = true;
    prev?.close();
  };
  es.onopen = () => {
    handOver();
    if (s.wasDown) {
      s.wasDown = false;
      dispatch(s, null); // resync after silent reconnect
    }
    syncNewcomers(s);
  };
  es.onerror = () => {
    if (s.es !== es) return;
    // A replacement that cannot connect must not keep the old one open forever.
    handOver();
    s.wasDown = true; // EventSource auto-retries per `retry:` hint
  };
  es.onmessage = (ev) => {
    try {
      dispatch(s, JSON.parse(ev.data));
    } catch {}
  };
}

/**
 * Settles the connection to what its subscribers now want, a moment later.
 *
 * The delay folds a navigation's unsubscribe-then-subscribe (and React's
 * development double mount) into one decision instead of a close and a reopen.
 */
function settle(s: Stream) {
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    const key = unionKey(s);
    if (key === s.key) {
      // Already carrying what a newcomer wants, and already live.
      if (s.es?.readyState === 1) syncNewcomers(s);
      return;
    }
    if (key === null) {
      s.es?.close();
      s.es = null;
      s.key = null;
      if (streams.get(s.slug) === s) streams.delete(s.slug);
      return;
    }
    openStream(s, key);
  }, 50);
}

/**
 * Subscribes to the clinic's SSE event stream. Reconnection is handled by
 * EventSource itself; after a dropped connection we fire onEvent(null) so the
 * caller can silently refetch anything missed.
 *
 * The tables go to the server as well as being checked here, so a tab watching
 * the calendar is not sent every message a campaign delivers only to throw it
 * away. The check here stays: it is what keeps a caller correct against a
 * server that has not been deployed with the filter yet, and what keeps each
 * subscriber to its own tables on the shared connection.
 */
export function useRealtime(
  slug: string,
  tables: string[],
  onEvent: (e: RealtimeEvent | null) => void,
  opts: { syncOnOpen?: boolean } = {}
) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const tablesKey = tables.join(",");
  const syncOnOpen = opts.syncOnOpen === true;

  useEffect(() => {
    let s = streams.get(slug);
    if (!s) {
      s = { slug, subs: new Set(), es: null, key: null, wasDown: false, timer: null };
      streams.set(slug, s);
    }
    const stream = s;
    const sub: Sub = {
      tables: new Set(tablesKey.split(",").filter(Boolean)),
      cb,
      syncOnOpen: !!syncOnOpen,
      synced: false,
    };
    stream.subs.add(sub);
    settle(stream);
    return () => {
      stream.subs.delete(sub);
      settle(stream);
    };
  }, [slug, tablesKey, syncOnOpen]);
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
  match?: (e: RealtimeEvent) => boolean,
  opts: { syncOnOpen?: boolean } = {}
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

  useRealtime(
    slug,
    tables,
    (e) => {
      if (e && accept.current && !accept.current(e)) return;
      schedule();
    },
    opts
  );
}
