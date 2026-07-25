"use client";

import { useEffect, useRef } from "react";

/**
 * Subscribes to the clinic's SSE event stream. Reconnection is handled by
 * EventSource itself; after a dropped connection we fire onEvent(null) so the
 * caller can silently refetch anything missed.
 */
export function useRealtime(
  slug: string,
  tables: string[],
  onEvent: (e: { t: string; op: string; id?: string } | null) => void
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
      es = new EventSource(`/api/c/${slug}/events`);
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
