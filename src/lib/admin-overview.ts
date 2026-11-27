import type { PoolClient } from "pg";
import { asPlan, PLANS, type Plan } from "./plans";

/**
 * The agency's front page (Admin → Overview, 2026-11-27): what needs somebody
 * today, and the handful of numbers that say how the business is.
 *
 * "Needs you" is a list of things a person can act on, each pointing at the
 * page that fixes it — never a feed. A WhatsApp that dropped and came back is
 * not on it; one logged out for an hour is.
 */

export type NeedKind =
  | "alert"
  | "whatsapp"
  | "past_due"
  | "paid_lapsed"
  | "trial_ending"
  | "trial_over"
  | "invite_pending"
  | "over_limit"
  | "notice";

export type Need = {
  kind: NeedKind;
  /** The clinic it is about, when it is about one. */
  clinic?: { name: string; slug: string };
  /** What the item says beyond its kind: a count, a date, the alert's own title. */
  title?: string;
  at?: string | null;
  n?: number;
  limit?: number;
  href: string;
};

export type Overview = {
  needs: Need[];
  figures: {
    live: number;
    paying: number;
    onTrial: number;
    /** Sum of the active clinics' agreed monthly price, per currency. */
    monthly: { currency: string; amount: number }[];
    byPlan: Record<Plan, number>;
  };
};

/** Everything on the Overview, in one connection, one query after another. */
export async function loadOverview(
  c: PoolClient,
  opts: { userId: string; seeAlerts: boolean }
): Promise<Overview> {
  const needs: Need[] = [];
  const live = `cl.deleted_at is null`;
  const name = `coalesce(nullif(cl.name_ar, ''), cl.name)`;

  if (opts.seeAlerts) {
    const alerts = (
      await c.query(`select key, title, opened_at from ops_alerts where severity = 'urgent' order by opened_at`)
    ).rows;
    for (const a of alerts) needs.push({ kind: "alert", title: a.title, at: iso(a.opened_at), href: "/admin/monitoring" });
  }

  // Logged out, or waiting on a code, for an hour: it will not come back without the clinic.
  const wa = (
    await c.query(
      `select ${name} as name, cl.slug, ws.status, ws.updated_at
         from whatsapp_sessions ws join clinics cl on cl.id = ws.clinic_id
        where ${live} and cl.subscription_status <> 'suspended'
          and ws.connected_at is not null and ws.status in ('logged_out', 'qr')`
    )
  ).rows;
  for (const r of wa) needs.push({ kind: "whatsapp", clinic: { name: r.name, slug: r.slug }, href: `/admin/clinics/${r.slug}` });

  const billing = (
    await c.query(
      `select ${name} as name, cl.slug, cl.subscription_status as status, cl.trial_ends_at, cl.paid_until
         from clinics cl
        where ${live}
          and (cl.subscription_status = 'past_due'
               or (cl.subscription_status = 'active' and cl.paid_until is not null and cl.paid_until < current_date)
               or (cl.subscription_status = 'trial' and cl.trial_ends_at is not null and cl.trial_ends_at < now() + interval '7 days'))
        order by coalesce(cl.trial_ends_at, cl.paid_until::timestamptz) nulls last`
    )
  ).rows;
  for (const r of billing) {
    const clinic = { name: r.name, slug: r.slug };
    const href = `/admin/clinics/${r.slug}?tab=plan`;
    if (r.status === "past_due") needs.push({ kind: "past_due", clinic, href });
    else if (r.status === "active") needs.push({ kind: "paid_lapsed", clinic, at: iso(r.paid_until), href });
    else
      needs.push({
        kind: new Date(r.trial_ends_at) < new Date() ? "trial_over" : "trial_ending",
        clinic,
        at: iso(r.trial_ends_at),
        href,
      });
  }

  // An owner who never accepted: the clinic exists and nobody can open it.
  const invites = (
    await c.query(
      `select ${name} as name, cl.slug, cm.created_at
         from clinic_members cm join users u on u.id = cm.user_id join clinics cl on cl.id = cm.clinic_id
        where ${live} and cm.is_owner and cm.active and u.password_hash is null
          and cm.created_at < now() - interval '3 days'`
    )
  ).rows;
  for (const r of invites)
    needs.push({ kind: "invite_pending", clinic: { name: r.name, slug: r.slug }, at: iso(r.created_at), href: `/admin/clinics/${r.slug}?tab=members` });

  const over = (
    await c.query(
      `select ${name} as name, cl.slug, cl.member_limit,
              (select count(*)::int from clinic_members m where m.clinic_id = cl.id and m.active) as n
         from clinics cl
        where ${live} and cl.member_limit is not null
          and (select count(*) from clinic_members m where m.clinic_id = cl.id and m.active) > cl.member_limit`
    )
  ).rows;
  for (const r of over)
    needs.push({ kind: "over_limit", clinic: { name: r.name, slug: r.slug }, n: r.n, limit: r.member_limit, href: `/admin/clinics/${r.slug}?tab=members` });

  /*
    The worker's word to the super admins about one clinic's number — paused
    for its own protection, sending without delivering, restricted by
    WhatsApp. They used to surface only inside a clinic's workspace, which an
    agency admin is in only on a support visit.
  */
  const notices = (
    await c.query(
      `select n.title, n.created_at, cl.slug, ${name} as name
         from notifications n left join clinics cl on cl.id = n.clinic_id
        where n.user_id = $1 and n.read_at is null and n.created_at > now() - interval '7 days'
          and n.kind in ('whatsapp_blast_guard', 'whatsapp_undelivered', 'whatsapp_restricted', 'document_integrity')
        order by n.created_at desc limit 10`,
      [opts.userId]
    )
  ).rows;
  for (const r of notices)
    needs.push({
      kind: "notice",
      title: r.title,
      at: iso(r.created_at),
      clinic: r.slug ? { name: r.name, slug: r.slug } : undefined,
      href: r.slug ? `/admin/clinics/${r.slug}` : "/admin/monitoring",
    });

  const f = (
    await c.query(
      `select count(*) filter (where ${live})::int as live,
              count(*) filter (where ${live} and cl.subscription_status = 'active')::int as paying,
              count(*) filter (where ${live} and cl.subscription_status = 'trial')::int as on_trial
         from clinics cl`
    )
  ).rows[0];
  const monthly = (
    await c.query(
      `select cl.currency, sum(cl.plan_price)::float as amount
         from clinics cl where ${live} and cl.subscription_status = 'active' and cl.plan_price > 0
        group by cl.currency order by 2 desc`
    )
  ).rows.map((r) => ({ currency: r.currency as string, amount: Number(r.amount) }));
  const byPlan = Object.fromEntries(PLANS.map((p) => [p, 0])) as Record<Plan, number>;
  for (const r of (await c.query(`select plan, count(*)::int as n from clinics cl where ${live} group by plan`)).rows) {
    byPlan[asPlan(r.plan)] += r.n as number;
  }

  return { needs, figures: { live: f.live, paying: f.paying, onTrial: f.on_trial, monthly, byPlan } };
}

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
