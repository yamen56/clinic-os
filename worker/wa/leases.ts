import os from "node:os";
import { withSystem } from "../db";

/**
 * Which worker owns which clinic's WhatsApp socket.
 *
 * See migration 0054 for why this exists at all. The short version: one
 * Baileys socket per clinic in one process is the platform's first hard
 * ceiling, and the only thing that stopped a second worker from sharing the
 * load was that both would connect every clinic and knock each other off.
 *
 * A lease is a row this process renews. Holding one means "I own this clinic's
 * socket"; letting it go stale means "whoever notices first may take it". No
 * coordination service and no leader election — the same `skip locked`-shaped
 * reasoning the jobs table already runs on.
 */

/**
 * Who this process is.
 *
 * Railway gives each replica a stable id; outside Railway the host and pid are
 * enough, since the only requirement is that two live processes never pick the
 * same string. A restart deliberately produces a new id rather than reclaiming
 * the old one's leases directly: the container that just died may still be
 * finishing a send, and the stale-lease path has to work anyway.
 */
export const WORKER_ID =
  process.env.RAILWAY_REPLICA_ID?.slice(0, 36) ?? `${os.hostname()}:${process.pid}`;

/**
 * How long a lease outlives its last heartbeat.
 *
 * This is the window in which a dead worker's clinics stay dark, so shorter is
 * kinder to the clinic — but it is also the margin before a *live* worker is
 * declared dead and has its sockets taken from underneath it, which costs a
 * `connectionReplaced` and a reconnect. Forty-five seconds against a
 * three-second reconcile means fifteen consecutive missed beats: comfortably
 * past a slow query, a GC pause or a pooler blip, and still under a minute of
 * downtime after a real crash.
 */
const LEASE_TTL_SECONDS = Number(process.env.WA_LEASE_TTL_SECONDS || 45);

/**
 * Renew a lease only once it is this old.
 *
 * The reconcile loop runs every few seconds and could write on every tick, but
 * a lease renewed two seconds ago does not need renewing again. This keeps the
 * steady state at one small write per lease per ten seconds instead of one per
 * tick, which matters when the whole point of the change is to raise the
 * clinic count.
 */
const RENEW_AFTER_SECONDS = Number(process.env.WA_LEASE_RENEW_SECONDS || 10);

/**
 * How many clinics this worker will carry. Zero means no limit.
 *
 * Unlimited is the default deliberately, because it is what the single worker
 * already does — deploying this change must not strand a clinic that was
 * connected five minutes ago. Set it once a second worker exists and the two
 * divide the clinics between them; leave it alone while there is one.
 */
const MAX_SESSIONS = Math.max(0, Number(process.env.WA_MAX_SESSIONS_PER_WORKER || 0));

/** Room left for more clinics on this process, given what it already holds. */
export function sessionBudget(held: number): number {
  return MAX_SESSIONS === 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, MAX_SESSIONS - held);
}

export type DesiredRow = {
  clinicId: string;
  /** False once the clinic asked to be disconnected, or the clinic was deleted. */
  wanted: boolean;
  /** Bumped by `POST /sessions/:id/connect`; a change means "restart me". */
  restartSeq: string;
  /** Set when a disconnect landed on a worker that did not own the socket. */
  logoutRequested: boolean;
  /** Null when nobody currently holds it. */
  ownerId: string | null;
};

/** One clinic this process is running, and whether its socket is actually up. */
export type LocalSession = { clinicId: string; connected: boolean };

/**
 * Renew what this worker holds and read back the whole picture, in one round
 * trip.
 *
 * One statement rather than two because this runs every few seconds in every
 * worker forever, and because the read has to reflect the renewal — a separate
 * `update` then `select` can interleave with another worker's claim and
 * produce a view in which this process owns nothing.
 *
 * The CTE's update and the outer select both run against the statement's
 * snapshot, so the heartbeats read here are the pre-renewal ones. That is why
 * ownership is decided by `owner_id` and never by freshness: a row owned by
 * this process was just renewed by the line above, whatever its timestamp
 * says.
 *
 * `local` carries the sessions this process currently has open, so a clinic
 * that stopped being desired — or whose clinic row was deleted — still comes
 * back and can be shut down, instead of quietly staying connected because it
 * no longer matches the query that would have found it.
 */
export async function renewAndRead(local: LocalSession[]): Promise<DesiredRow[]> {
  const ids = local.map((s) => s.clinicId);
  const live = local.map((s) => s.connected);
  const rows = await withSystem(async (c) => {
    const r = await c.query(
      `with mine as (
         select * from unnest($4::uuid[], $5::boolean[]) as t(clinic_id, connected)
       ),
       renewed as (
         update wa_session_leases l
            set heartbeat_at = now(), connected = m.connected
           from mine m
          where l.clinic_id = m.clinic_id and l.owner_id = $1
            and (l.heartbeat_at < now() - make_interval(secs => $2::float8)
                 or l.connected is distinct from m.connected)
          returning l.clinic_id
       )
       select ws.clinic_id,
              (ws.desired and cl.id is not null and cl.deleted_at is null) as wanted,
              ws.restart_seq,
              ws.logout_requested,
              case when l.owner_id = $1
                     or l.heartbeat_at > now() - make_interval(secs => $3::float8)
                   then l.owner_id end as owner_id
         from whatsapp_sessions ws
         left join clinics cl on cl.id = ws.clinic_id
         left join wa_session_leases l on l.clinic_id = ws.clinic_id
        where ws.desired or ws.clinic_id = any($4::uuid[])`,
      [WORKER_ID, RENEW_AFTER_SECONDS, LEASE_TTL_SECONDS, ids, live]
    );
    return r.rows as {
      clinic_id: string;
      wanted: boolean;
      restart_seq: string;
      logout_requested: boolean;
      owner_id: string | null;
    }[];
  });
  return rows.map((r) => ({
    clinicId: r.clinic_id,
    wanted: r.wanted,
    restartSeq: String(r.restart_seq),
    logoutRequested: r.logout_requested,
    ownerId: r.owner_id,
  }));
}

/**
 * Mark a logout as carried out, so the next reconcile does not try again.
 */
export async function clearLogoutRequest(clinicId: string): Promise<void> {
  await withSystem((c) =>
    c.query(
      `update whatsapp_sessions set logout_requested = false
        where clinic_id = $1 and logout_requested`,
      [clinicId]
    )
  );
}

/**
 * Every clinic the platform is meant to be running, and whether any worker
 * currently holds a live socket for it.
 *
 * Answers for all of them rather than for the process that happens to receive
 * the request, which is what `/health` needs once there is more than one
 * worker.
 */
export async function liveSessions(): Promise<
  { clinicId: string; connected: boolean; ownerId: string | null }[]
> {
  const rows = await withSystem(async (c) => {
    const r = await c.query(
      `select ws.clinic_id,
              coalesce(l.connected and l.heartbeat_at > now() - make_interval(secs => $1::float8), false) as connected,
              case when l.heartbeat_at > now() - make_interval(secs => $1::float8)
                   then l.owner_id end as owner_id
         from whatsapp_sessions ws
         join clinics cl on cl.id = ws.clinic_id and cl.deleted_at is null
         left join wa_session_leases l on l.clinic_id = ws.clinic_id
        where ws.desired`,
      [LEASE_TTL_SECONDS]
    );
    return r.rows as { clinic_id: string; connected: boolean; owner_id: string | null }[];
  });
  return rows.map((r) => ({
    clinicId: r.clinic_id,
    connected: r.connected,
    ownerId: r.owner_id,
  }));
}

/**
 * Take ownership of up to `limit` clinics that nobody is running.
 *
 * The race is settled by Postgres rather than by asking first. Two workers
 * scanning at the same moment build the same candidate list; both insert, and
 * the loser's `on conflict` re-evaluates its `where` against the winner's
 * freshly committed row, finds a heartbeat from a moment ago, updates nothing
 * and is handed nothing back. Only rows this call actually took are returned,
 * so "did I get it" needs no second question.
 *
 * Oldest heartbeat first, which puts a crashed worker's genuinely abandoned
 * clinics ahead of ones that are merely unstarted.
 */
export async function claimSessions(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await withSystem(async (c) => {
    const r = await c.query(
      `insert into wa_session_leases (clinic_id, owner_id, heartbeat_at)
       select ws.clinic_id, $1, now()
         from whatsapp_sessions ws
         join clinics cl on cl.id = ws.clinic_id and cl.deleted_at is null
         left join wa_session_leases l on l.clinic_id = ws.clinic_id
        where ws.desired
          and (l.clinic_id is null
               or l.heartbeat_at < now() - make_interval(secs => $2::float8))
        order by coalesce(l.heartbeat_at, to_timestamp(0))
        limit $3
       on conflict (clinic_id) do update
          set owner_id = excluded.owner_id, heartbeat_at = now()
        where wa_session_leases.heartbeat_at < now() - make_interval(secs => $2::float8)
       returning clinic_id`,
      [WORKER_ID, LEASE_TTL_SECONDS, Math.min(limit, 1000)]
    );
    return r.rows as { clinic_id: string }[];
  });
  return rows.map((r) => r.clinic_id);
}

/**
 * Hand one clinic back, so another worker picks it up now instead of waiting
 * out the lease.
 *
 * Scoped to this owner: releasing a lease that somebody else has already taken
 * would hand their live socket to a third worker.
 */
export async function releaseLease(clinicId: string): Promise<void> {
  await withSystem((c) =>
    c.query(`delete from wa_session_leases where clinic_id = $1 and owner_id = $2`, [
      clinicId,
      WORKER_ID,
    ])
  );
}

/**
 * Hand everything back on the way out.
 *
 * A deploy would otherwise leave every clinic unclaimable for the whole lease
 * window, which is the one moment the replacement container is right there
 * ready to take them. Best effort by design: if it fails, the stale-lease path
 * still recovers, only slower.
 */
export async function releaseAllLeases(): Promise<void> {
  await withSystem((c) =>
    c.query(`delete from wa_session_leases where owner_id = $1`, [WORKER_ID])
  );
}
