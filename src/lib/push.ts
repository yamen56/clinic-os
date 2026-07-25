import webpush from "web-push";
import type { PoolClient } from "pg";

let configured = false;

/** Returns true when VAPID keys are present and push can actually be sent. */
export function pushConfigured(): boolean {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@clinicos.local", pub, priv);
  configured = true;
  return true;
}

export type PushPayload = {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  lang?: string;
};

/**
 * Sends a web push to every device a user registered.
 * Subscriptions that the browser has revoked (404/410) are pruned.
 */
export async function pushToUser(
  c: PoolClient,
  userId: string,
  payload: PushPayload
): Promise<number> {
  if (!pushConfigured()) return 0;
  const subs = await c.query(
    `select id, endpoint, keys from push_subscriptions where user_id = $1`,
    [userId]
  );
  let sent = 0;
  for (const s of subs.rows) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: s.keys as { p256dh: string; auth: string } },
        JSON.stringify(payload),
        { TTL: 3600 }
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await c.query(`delete from push_subscriptions where id = $1`, [s.id]);
      } else {
        console.error("[push]", (e as Error).message);
      }
    }
  }
  return sent;
}
