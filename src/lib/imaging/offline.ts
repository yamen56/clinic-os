/**
 * A Bridge reports every half minute; ten minutes of silence means the
 * imaging computer is off, asleep or offline — worth saying before somebody
 * takes an x-ray that will not arrive. Only Bridges: other software calls
 * only when it has something to send.
 */
export const OFFLINE_AFTER_MS = 10 * 60_000;
export function bridgeOffline(d: { method: string; paired_at: string | null; revoked_at: string | null; last_seen_at: string | null }, now: number | null): boolean {
  return !!now && d.method === "bridge" && !!d.paired_at && !d.revoked_at && !!d.last_seen_at && now - Date.parse(d.last_seen_at) > OFFLINE_AFTER_MS;
}
