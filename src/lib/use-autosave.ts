"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "saving" | "saved" | "offline" | "error";

/**
 * Debounced autosave with an offline queue.
 * - patch() merges fields; a flush happens 1.5s after typing stops.
 * - Failed flushes persist to localStorage and retry on reconnect/interval.
 * - Never loses input: pending patches survive reloads.
 */
export function useAutosave(opts: {
  url: string;
  entityKey: string;
  onConflict?: (data: unknown) => void;
}) {
  const { url, entityKey, onConflict } = opts;
  const [state, setState] = useState<SaveState>("idle");
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const lsKey = `autosave:${entityKey}`;

  const flush = useCallback(async () => {
    if (inflight.current) return;
    const patch = pending.current;
    if (Object.keys(patch).length === 0) return;
    pending.current = {};
    inflight.current = true;
    setState("saving");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && onConflict) {
          onConflict(data);
          localStorage.removeItem(lsKey);
          setState("idle");
        } else {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
      } else {
        localStorage.removeItem(lsKey);
        setState("saved");
      }
    } catch {
      // Requeue on top of anything typed meanwhile; persist for reloads
      pending.current = { ...patch, ...pending.current };
      try {
        localStorage.setItem(lsKey, JSON.stringify(pending.current));
      } catch {}
      setState(navigator.onLine ? "error" : "offline");
    } finally {
      inflight.current = false;
      if (Object.keys(pending.current).length > 0) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, navigator.onLine ? 1500 : 5000);
      }
    }
  }, [url, lsKey, onConflict]);

  const patch = useCallback(
    (fields: Record<string, unknown>) => {
      pending.current = { ...pending.current, ...fields };
      try {
        localStorage.setItem(lsKey, JSON.stringify(pending.current));
      } catch {}
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 1500);
    },
    [flush, lsKey]
  );

  // Recover anything left over from a previous session, and retry when back online
  useEffect(() => {
    try {
      const saved = localStorage.getItem(lsKey);
      if (saved) {
        pending.current = { ...JSON.parse(saved), ...pending.current };
        void flush();
      }
    } catch {}
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    const iv = setInterval(() => {
      if (Object.keys(pending.current).length > 0) void flush();
    }, 15000);
    return () => {
      window.removeEventListener("online", onOnline);
      clearInterval(iv);
    };
  }, [flush, lsKey]);

  // Flush on tab close (best effort with keepalive)
  useEffect(() => {
    const onHide = () => {
      const patchNow = pending.current;
      if (Object.keys(patchNow).length === 0) return;
      try {
        navigator.sendBeacon?.(
          url,
          new Blob([JSON.stringify({ patch: patchNow })], { type: "application/json" })
        );
      } catch {}
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [url]);

  return { patch, flush, state };
}
