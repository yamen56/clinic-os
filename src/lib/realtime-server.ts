import { Client } from "pg";
import { EventEmitter } from "node:events";

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

type Hub = { emitter: EventEmitter; started: boolean };

declare global {
  // eslint-disable-next-line no-var
  var __cosRealtimeHub: Hub | undefined;
}

function getHub(): Hub {
  if (!globalThis.__cosRealtimeHub) {
    const hub: Hub = { emitter: new EventEmitter(), started: false };
    hub.emitter.setMaxListeners(500);
    globalThis.__cosRealtimeHub = hub;
  }
  return globalThis.__cosRealtimeHub;
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
          hub.emitter.emit("event", JSON.parse(msg.payload) as AppEvent);
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

export async function subscribeClinic(
  clinicId: string,
  onEvent: (e: AppEvent) => void
): Promise<() => void> {
  const hub = getHub();
  await startListener(hub);
  const handler = (e: AppEvent) => {
    if (e.clinic_id === clinicId) onEvent(e);
  };
  hub.emitter.on("event", handler);
  return () => hub.emitter.off("event", handler);
}

export async function subscribeUser(
  userId: string,
  onEvent: (e: AppEvent) => void
): Promise<() => void> {
  const hub = getHub();
  await startListener(hub);
  const handler = (e: AppEvent) => {
    if (e.user_id === userId) onEvent(e);
  };
  hub.emitter.on("event", handler);
  return () => hub.emitter.off("event", handler);
}
