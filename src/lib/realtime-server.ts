import { Client } from "pg";

/**
 * Single LISTEN connection fanning out Postgres `app_events` notifications
 * to all SSE subscribers. Survives dev HMR via globalThis; reconnects on error.
 */

export type AppEvent = {
  t: string;
  op: string;
  id?: string;
  clinic_id?: string;
  user_id?: string;
};

type Listener = (e: AppEvent) => void;

/**
 * Subscribers indexed by what they are waiting for, rather than one list that
 * every event walks.
 *
 * This was an `EventEmitter` with every open tab registered on the same
 * `event` name, each handler discarding what was not its clinic's. Correct,
 * and quadratic in the wrong direction: a notification for one clinic woke
 * every tab in the country, so the cost of a busy inbox grew with the number
 * of clinics signed up rather than with the clinic's own traffic. At a few
 * hundred tabs a single message meant a few hundred comparisons, all but one
 * of them discarded.
 *
 * It also carried `setMaxListeners(500)`, which reads like a ceiling and is
 * not one — Node's limit is a warning threshold, so tab 501 worked fine and
 * merely printed a line about a possible memory leak. Nothing enforced
 * anything; what there was, was a scaling problem nobody could see.
 *
 * A map from clinic to its own subscribers turns delivery into one lookup.
 * The practical ceiling becomes memory and open sockets — thousands per
 * replica — instead of the per-event fan-out.
 */
type Hub = {
  byClinic: Map<string, Set<Listener>>;
  byUser: Map<string, Set<Listener>>;
  started: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __cosRealtimeHub: Hub | undefined;
}

function getHub(): Hub {
  if (!globalThis.__cosRealtimeHub) {
    globalThis.__cosRealtimeHub = { byClinic: new Map(), byUser: new Map(), started: false };
  }
  return globalThis.__cosRealtimeHub;
}

/** Deliver to the subscribers of one key, and to nobody else. */
function fanOut(index: Map<string, Set<Listener>>, key: string | undefined, e: AppEvent) {
  if (!key) return;
  const set = index.get(key);
  if (!set) return;
  /*
    Copied before iterating. A subscriber that throws — or one that unsubscribes
    from inside its own handler, which the SSE route does when the browser goes
    away mid-delivery — must not change the set being walked and silently skip
    the tab that happens to sit next to it.
  */
  for (const fn of [...set]) {
    try {
      fn(e);
    } catch {}
  }
}

async function startListener(hub: Hub) {
  if (hub.started) return;
  hub.started = true;
  const connect = async () => {
    const client = new Client({
      connectionString:
        process.env.DATABASE_URL ||
        "postgres://clinicos_app:clinicos_app@127.0.0.1:5544/clinicos",
    });
    try {
      await client.connect();
      await client.query("listen app_events");
      client.on("notification", (msg) => {
        if (!msg.payload) return;
        try {
          const e = JSON.parse(msg.payload) as AppEvent;
          // Both, because a row can be a clinic's change and a person's at the
          // same time — a notification has an owner as well as a tenant.
          fanOut(hub.byClinic, e.clinic_id, e);
          fanOut(hub.byUser, e.user_id, e);
        } catch {}
      });
      client.on("error", () => {
        client.end().catch(() => {});
        setTimeout(connect, 2000);
      });
      client.on("end", () => {
        setTimeout(connect, 2000);
      });
    } catch {
      setTimeout(connect, 2000);
    }
  };
  await connect();
}

/**
 * Register one listener and hand back the exact removal for it.
 *
 * The empty set is deleted on the way out rather than left behind: with one
 * entry per clinic, a map that only ever grows is a slow leak in a process
 * that is meant to stay up for weeks.
 */
function subscribe(
  index: Map<string, Set<Listener>>,
  key: string,
  onEvent: Listener
): () => void {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(onEvent);
  return () => {
    const current = index.get(key);
    if (!current) return;
    current.delete(onEvent);
    if (current.size === 0) index.delete(key);
  };
}

export async function subscribeClinic(
  clinicId: string,
  onEvent: (e: AppEvent) => void
): Promise<() => void> {
  const hub = getHub();
  await startListener(hub);
  return subscribe(hub.byClinic, clinicId, onEvent);
}

export async function subscribeUser(
  userId: string,
  onEvent: (e: AppEvent) => void
): Promise<() => void> {
  const hub = getHub();
  await startListener(hub);
  return subscribe(hub.byUser, userId, onEvent);
}
