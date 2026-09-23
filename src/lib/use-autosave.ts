"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "saving" | "saved" | "offline" | "error" | "rejected";

/** Fields the server refused, by name, while it saved the rest of the patch. */
export type Rejected = Record<string, { error: string; [k: string]: unknown }>;

/**
 * Debounced autosave with an offline queue.
 *
 * The contract, which is what the indicator promises the person typing:
 *
 *  - **"Saved" means on the server.** The indicator turns to "Saving…" on the
 *    first keystroke and only says "Saved" once nothing is waiting or in
 *    flight. It used to keep showing the previous "Saved" through the 1.5s
 *    debounce, so somebody who read it and moved on left with the last edit
 *    still sitting in a timer.
 *  - **Leaving saves first.** Unmounting, hiding the tab and following a link
 *    all send what is pending now rather than after the debounce; the link is
 *    held until it lands (see `AutosaveGuard`). Otherwise the next page read the
 *    database before the save reached it, and coming back showed the old value.
 *  - **One record, one queue.** Saves for the same entity go out in order, so a
 *    slow older request can never land after a newer one and undo it.
 *  - **A refusal is not an outage.** A 4xx is the server's answer, and sending
 *    it again gets the same answer — while every edit queued behind it waited
 *    forever under an "Offline" badge. Routes that can refuse one field say so
 *    in `rejected` and save the rest.
 *  - **Never loses input.** Anything unconfirmed is kept in localStorage with
 *    the URL it belongs to, and retried on the next visit, on reconnect, or by
 *    the guard's sweep if the screen it came from is never opened again.
 */

type Saver = { key: string; flush: (o?: { keepalive?: boolean }) => Promise<void>; hasWork: () => boolean };

/** Every autosaver currently mounted, so leaving the page can flush them all. */
const savers = new Set<Saver>();
/** The save in flight for each entity. Each new one waits for the one before. */
const chains = new Map<string, Promise<void>>();
/**
 * Counts successful saves. The router's copies of pages are stale from the
 * first save until a refresh that started after the last one has finished.
 */
let saveSeq = 0;
let refreshedAtSeq = 0;
/** Told each time the last pending save finishes, so the guard can refresh behind it. */
const settledListeners = new Set<() => void>();

const LS_PREFIX = "autosave:";
const DEBOUNCE_MS = 1500;
// keepalive requests share a 64 KiB budget; a patch bigger than that goes normally.
const KEEPALIVE_LIMIT = 60_000;

/** True while anything typed has not been confirmed by the server. */
export function hasUnsavedWork(): boolean {
  if (chains.size) return true;
  for (const s of savers) if (s.hasWork()) return true;
  return false;
}

/** Send everything pending now and wait for all of it, including saves already in flight. */
export async function flushAllAutosaves(o?: { keepalive?: boolean }): Promise<void> {
  await Promise.all([...savers].map((s) => s.flush(o)));
  await Promise.all([...chains.values()]);
}

/** True when something was saved after the router last fetched its pages. */
export function routerIsStale(): boolean {
  return saveSeq !== refreshedAtSeq;
}

/**
 * Call before a refresh starts; call the returned function once it has
 * finished. A save that lands in between leaves the router marked stale.
 */
export function beginRouterRefresh(): () => void {
  const at = saveSeq;
  return () => {
    if (refreshedAtSeq < at) refreshedAtSeq = at;
  };
}

/** Subscribe to "every pending save has finished". Returns the unsubscribe. */
export function onAutosavesSettled(fn: () => void): () => void {
  settledListeners.add(fn);
  return () => settledListeners.delete(fn);
}

type Stored = { url: string; patch: Record<string, unknown> };

function readStored(lsKey: string): Stored | { url: null; patch: Record<string, unknown> } | null {
  try {
    const raw = localStorage.getItem(lsKey);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    // Older entries were the bare patch, with no URL beside it.
    if (typeof v.url === "string" && v.patch && typeof v.patch === "object") return v as Stored;
    return { url: null, patch: v as Record<string, unknown> };
  } catch {
    return null;
  }
}

type Outcome =
  | { kind: "saved"; rejected: Rejected }
  | { kind: "conflict"; data: unknown }
  | { kind: "refused" }
  | { kind: "failed" };

async function send(url: string, patch: Record<string, unknown>, keepalive: boolean): Promise<Outcome> {
  const body = JSON.stringify({ patch });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: keepalive && body.length < KEEPALIVE_LIMIT,
    });
    const data = (await res.json().catch(() => ({}))) as { rejected?: Rejected };
    if (res.ok) {
      saveSeq++;
      return { kind: "saved", rejected: data.rejected ?? {} };
    }
    if (res.status === 409) return { kind: "conflict", data };
    // 408 and 429 are "try again later"; every other 4xx is a considered no.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      return { kind: "refused" };
    }
    return { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

/** Queue a send behind whatever is already in flight for the same entity. */
function enqueue(key: string, job: () => Promise<void>): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(job, job);
  chains.set(key, run);
  void run.finally(() => {
    if (chains.get(key) === run) chains.delete(key);
    if (!hasUnsavedWork()) for (const fn of settledListeners) fn();
  });
  return run;
}

/**
 * Retry what a screen left behind and never came back for.
 *
 * A save that failed on a page the person then left sits in localStorage. The
 * screen's own hook retries it when it is opened again; this covers the case
 * where it is not — the entry carries its URL, so anybody can send it.
 */
export async function retryOrphanedAutosaves(): Promise<void> {
  let keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LS_PREFIX)) keys.push(k);
    }
  } catch {
    return;
  }
  const owned = new Set([...savers].map((s) => s.key));
  keys = keys.filter((k) => !owned.has(k) && !chains.has(k));
  await Promise.all(
    keys.map((k) =>
      enqueue(k, async () => {
        const stored = readStored(k);
        if (!stored?.url || !Object.keys(stored.patch).length) return;
        const out = await send(stored.url, stored.patch, false);
        // Something else may have written this key while we were sending.
        if (out.kind !== "failed" && JSON.stringify(readStored(k)?.patch) === JSON.stringify(stored.patch)) {
          try {
            localStorage.removeItem(k);
          } catch {}
        }
      })
    )
  );
}

export function useAutosave(opts: {
  url: string;
  entityKey: string;
  /** A route that refuses the whole patch with 409 (legacy form of `onRejected`). */
  onConflict?: (data: unknown) => void;
  /** Fields the server refused while saving the others. */
  onRejected?: (rejected: Rejected) => void;
  /**
   * Keys whose value is a partial object the server merges into what it has
   * (a patient's `custom_fields`). Two edits to one inside the debounce are
   * combined rather than the second replacing the first.
   */
  mergeKeys?: string[];
}) {
  const lsKey = `${LS_PREFIX}${opts.entityKey}`;
  const [state, setState] = useState<SaveState>("idle");
  const pending = useRef<Record<string, unknown>>({});
  // Sent but not yet confirmed; persisted alongside `pending` so a tab that
  // dies mid-request still has it.
  const inflight = useRef<Record<string, unknown>>({});
  const inflightCount = useRef(0);
  const rejectedKeys = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const cfg = useRef(opts);
  cfg.current = opts;

  const show = useCallback((s: SaveState) => {
    if (alive.current) setState(s);
  }, []);

  const combine = useCallback(
    (a: Record<string, unknown>, b: Record<string, unknown>) => {
      const out = { ...a };
      const deep = cfg.current.mergeKeys ?? [];
      for (const [k, v] of Object.entries(b)) {
        const prev = out[k];
        out[k] =
          deep.includes(k) &&
          prev && typeof prev === "object" && !Array.isArray(prev) &&
          v && typeof v === "object" && !Array.isArray(v)
            ? { ...(prev as object), ...(v as object) }
            : v;
      }
      return out;
    },
    []
  );

  const persist = useCallback(() => {
    const all = combine(inflight.current, pending.current);
    try {
      if (Object.keys(all).length) {
        localStorage.setItem(lsKey, JSON.stringify({ url: cfg.current.url, patch: all }));
      } else {
        localStorage.removeItem(lsKey);
      }
    } catch {}
  }, [combine, lsKey]);

  const flush = useCallback(
    (o?: { keepalive?: boolean }): Promise<void> => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const patch = pending.current;
      if (!Object.keys(patch).length) return chains.get(lsKey) ?? Promise.resolve();
      pending.current = {};
      inflight.current = combine(inflight.current, patch);
      inflightCount.current++;
      show("saving");

      return enqueue(lsKey, async () => {
        const out = await send(cfg.current.url, patch, !!o?.keepalive);

        if (out.kind === "failed") {
          // Back underneath anything typed since, so the newer value still wins.
          pending.current = combine(patch, pending.current);
        } else {
          const refused: string[] =
            out.kind === "saved" ? Object.keys(out.rejected) : Object.keys(patch);
          for (const k of Object.keys(patch)) {
            if (refused.includes(k)) rejectedKeys.current.add(k);
            else rejectedKeys.current.delete(k);
          }
          if (out.kind === "saved" && refused.length) cfg.current.onRejected?.(out.rejected);
          if (out.kind === "conflict") cfg.current.onConflict?.(out.data);
        }

        inflightCount.current--;
        if (!inflightCount.current) inflight.current = {};
        persist();

        if (out.kind === "failed") {
          show(navigator.onLine ? "error" : "offline");
          if (alive.current && !timer.current) {
            timer.current = setTimeout(() => {
              timer.current = null;
              void flush();
            }, navigator.onLine ? DEBOUNCE_MS : 5000);
          }
        } else if (Object.keys(pending.current).length || timer.current || inflightCount.current) {
          show("saving");
        } else {
          show(rejectedKeys.current.size ? "rejected" : "saved");
        }
      });
    },
    [combine, lsKey, persist, show]
  );

  const patch = useCallback(
    (fields: Record<string, unknown>) => {
      pending.current = combine(pending.current, fields);
      persist();
      setState("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush();
      }, DEBOUNCE_MS);
    },
    [combine, flush, persist]
  );

  useEffect(() => {
    alive.current = true;
    const saver: Saver = {
      key: lsKey,
      flush: (o) => flush(o),
      hasWork: () => Object.keys(pending.current).length > 0 || inflightCount.current > 0,
    };
    savers.add(saver);

    // Anything a previous visit left unconfirmed goes first.
    const stored = readStored(lsKey);
    if (stored && Object.keys(stored.patch).length) {
      pending.current = combine(stored.patch, pending.current);
      void flush();
    }

    const onOnline = () => void flush();
    // Hiding the tab is often the last thing that happens before it is closed.
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush({ keepalive: true });
    };
    const onPageHide = () => void flush({ keepalive: true });
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    const iv = setInterval(() => {
      if (Object.keys(pending.current).length && !timer.current) void flush();
    }, 15000);

    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      clearInterval(iv);
      savers.delete(saver);
      alive.current = false;
      // Leaving the screen is not a reason to wait out the debounce.
      if (Object.keys(pending.current).length) void flush({ keepalive: true });
      else if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [combine, flush, lsKey]);

  return { patch, flush, state };
}
