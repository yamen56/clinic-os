/**
 * The number that predicts a ban, as far as one can be measured from in here.
 *
 * Volume is the obvious metric and it is the wrong one. WhatsApp bans a number
 * because **recipients report and block it**, not because it sent a lot — a
 * clinic answering two hundred inbound conversations a day is invisible, and
 * one sending fifty unsolicited messages to people who never contacted them is
 * building a case against itself.
 *
 * We cannot see reports or blocks. Baileys is not told about them, so the one
 * signal that actually matters is unavailable and no amount of care here
 * changes that. What *is* visible is the closest proxy: outbound messages sent
 * into conversations where the patient has never once written back. Someone who
 * receives and never replies is the population that reports.
 *
 * Measured across thirty days, per clinic, because it is a slow-moving trend
 * rather than an event — and because at low volume the ratio is noise: three of
 * four messages into silence is 75% and means nothing at all.
 */
import type { PoolClient } from "pg";

export type SilenceRow = {
  clinicId: string;
  name: string;
  slug: string;
  /** Outbound messages in the window. */
  out: number;
  /** How many of those went into a thread the patient never replied in. */
  cold: number;
  /** cold / out, 0..1. Zero when nothing was sent. */
  ratio: number;
};

/**
 * Below this many messages the ratio says nothing and must not be acted on.
 *
 * A clinic that sent four messages and got no reply to three of them is at 75%
 * and is not doing anything wrong. Alerting on that teaches the reader to
 * ignore the alert, which costs more than the metric is worth.
 */
export const SILENCE_MIN_VOLUME = Number(process.env.SILENCE_MIN_VOLUME || 100);

/**
 * The ratio worth saying something about.
 *
 * Measured on real traffic on 2026-09-05 the platform sat at 11%, made up
 * almost entirely of staff replying inside existing threads. Half of everything
 * going into silence is a different activity — an imported list being messaged,
 * or a campaign to people who never opted in — and that is the thing to catch
 * before the number is gone rather than after.
 */
export const SILENCE_ALERT_RATIO = Number(process.env.SILENCE_ALERT_RATIO || 0.5);

/**
 * Per clinic, over `days`. One query, one pass.
 *
 * Grouping to conversations first and only then to clinics is what makes this
 * a single statement: the inner aggregate decides whether each thread was ever
 * two-sided, the outer one counts the messages that went into the threads that
 * were not.
 */
export async function silenceByClinic(c: PoolClient, days = 30): Promise<SilenceRow[]> {
  const rows = (
    await c.query(
      `with convo as (
         select m.clinic_id,
                m.conversation_id,
                count(*) filter (where m.direction = 'in')::int  as inbound,
                count(*) filter (where m.direction = 'out')::int as outbound
           from messages m
          where m.created_at > now() - ($1 || ' days')::interval
          group by 1, 2
       )
       select cl.id, cl.name, cl.slug,
              coalesce(sum(convo.outbound), 0)::int as out,
              coalesce(sum(convo.outbound) filter (where convo.inbound = 0), 0)::int as cold
         from clinics cl
         left join convo on convo.clinic_id = cl.id
        where cl.deleted_at is null
        group by cl.id, cl.name, cl.slug
       having coalesce(sum(convo.outbound), 0) > 0
        order by cold desc`,
      [String(days)]
    )
  ).rows;

  return rows.map((r) => ({
    clinicId: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    out: Number(r.out),
    cold: Number(r.cold),
    ratio: Number(r.out) > 0 ? Number(r.cold) / Number(r.out) : 0,
  }));
}

/** Clinics whose ratio is both high enough and loud enough to mean something. */
export function concerning(rows: SilenceRow[]): SilenceRow[] {
  return rows.filter((r) => r.out >= SILENCE_MIN_VOLUME && r.ratio >= SILENCE_ALERT_RATIO);
}
