import type { PoolClient } from "pg";

/**
 * When the agency goes inside a clinic. See migrations/0067.
 *
 * One module for the three screens that read the record — the clinic's page in
 * /admin, the agency team page, and the clinic's own Settings → Agency access —
 * so that the agency and the clinic are never shown two different accounts of
 * the same visit.
 */

/**
 * How long a support visit lasts before it ends by itself.
 *
 * Long enough for an afternoon of onboarding — services, hours, WhatsApp, the
 * AI knowledge — and short enough that a visit somebody forgot to exit is over
 * by the evening rather than sitting open inside the clinic for the thirty days
 * an ordinary session gets. Running over costs a sign-in and a new reason,
 * which is also a fair description of a second visit.
 */
export const SUPPORT_VISIT_HOURS = Math.max(1, Number(process.env.SUPPORT_VISIT_HOURS) || 4);

export const SUPPORT_REASON_MIN = 3;
export const SUPPORT_REASON_MAX = 300;

/** One line, trimmed; null when it is too short or too long to be a reason. */
export function cleanSupportReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const why = raw.replace(/\s+/g, " ").trim();
  if (why.length < SUPPORT_REASON_MIN || why.length > SUPPORT_REASON_MAX) return null;
  return why;
}

export type SupportEndReason = "exit" | "switched" | "signed_out" | "expired";

export type SupportVisit = {
  id: string;
  clinicName: string;
  clinicNameAr: string | null;
  clinicSlug: string;
  /** The clinic's own clock, which both sides read the visit in. */
  timezone: string;
  adminName: string;
  adminEmail: string;
  reason: string;
  ip: string | null;
  userAgent: string | null;
  startedAt: string;
  lastSeenAt: string;
  /** Null while the visit is still open. */
  endedAt: string | null;
  endReason: SupportEndReason | null;
  patientsViewed: number;
  /** Up to twenty of them, in the order first opened; empty unless asked for. */
  patients: { id: string; name: string }[];
  exports: number;
  changes: number;
};

/*
  What counts as looking rather than changing. Exports are reads too, but they
  are the read a clinic most needs to hear about — a copy of the records leaving
  the building — so they get their own count instead of hiding in either.
*/
const VIEW_ACTIONS = ["patient.view", "patient.file.view", "prescription.view"];
const EXPORT_ACTIONS = ["patient.export", "patient.export_all", "claims.export"];

/**
 * The visits for one clinic, or by one admin, newest first.
 *
 * What a visit did is read from the audit log rather than counted into the
 * visit as it happens: the log is already the record of every action, and a
 * second tally kept beside it would be a second record free to disagree. The
 * join is the admin acting in that clinic inside the visit's window — by
 * `user_id`, not `impersonated_by`, because not every audit call passes the
 * latter, and an agency admin with no membership can only be acting in a
 * clinic at all through a visit.
 *
 * A visit whose expiry has passed is over even though nobody has closed it yet
 * (the worker sweeps the session a day later, and the trigger closes it then);
 * it is reported as ending when it was last used, the same answer the trigger
 * will write.
 */
export async function listSupportVisits(
  c: PoolClient,
  filter: { clinicId?: string; adminUserId?: string },
  opts: { limit?: number; withPatients?: boolean } = {}
): Promise<SupportVisit[]> {
  const r = await c.query(
    `select sv.id, cl.name as clinic_name, cl.name_ar as clinic_name_ar, cl.slug as clinic_slug, cl.timezone,
            sv.admin_name, sv.admin_email, sv.reason, sv.ip, sv.user_agent,
            sv.started_at, sv.last_seen_at,
            coalesce(sv.ended_at,
                     case when sv.expires_at <= now() then least(sv.last_seen_at, sv.expires_at) end)
              as ended_at,
            coalesce(sv.end_reason, case when sv.expires_at <= now() then 'expired' end) as end_reason,
            coalesce(a.patients_viewed, 0)::int as patients_viewed,
            coalesce(a.exports, 0)::int as exports,
            coalesce(a.changes, 0)::int as changes,
            case when $6::boolean then coalesce((
              select json_agg(json_build_object('id', p.id, 'name', p.full_name) order by v.first_at)
                from (
                  select al.entity_id, min(al.created_at) as first_at
                    from audit_log al
                   where al.clinic_id = sv.clinic_id and al.user_id = sv.admin_user_id
                     and al.action = 'patient.view'
                     and al.created_at >= sv.started_at
                     and al.created_at <= coalesce(sv.ended_at, least(now(), sv.expires_at))
                   group by al.entity_id
                   order by min(al.created_at)
                   limit 20
                ) v
                join patients p on p.id::text = v.entity_id and p.clinic_id = sv.clinic_id
            ), '[]'::json) else '[]'::json end as patients
       from support_visits sv
       join clinics cl on cl.id = sv.clinic_id
       left join lateral (
         select count(distinct al.entity_id) filter (where al.action = 'patient.view') as patients_viewed,
                count(*) filter (where al.action = any($4::text[])) as exports,
                count(*) filter (
                  where not (al.action = any($3::text[]) or al.action = any($4::text[])
                             or al.action like 'admin.impersonate.%')
                ) as changes
           from audit_log al
          where al.clinic_id = sv.clinic_id and al.user_id = sv.admin_user_id
            and al.created_at >= sv.started_at
            and al.created_at <= coalesce(sv.ended_at, least(now(), sv.expires_at))
       ) a on true
      where ($1::uuid is null or sv.clinic_id = $1)
        and ($2::uuid is null or sv.admin_user_id = $2)
      order by sv.started_at desc
      limit $5`,
    [
      filter.clinicId ?? null,
      filter.adminUserId ?? null,
      VIEW_ACTIONS,
      EXPORT_ACTIONS,
      opts.limit ?? 50,
      opts.withPatients === true,
    ]
  );
  return r.rows.map((row) => ({
    id: row.id,
    clinicName: row.clinic_name,
    clinicNameAr: row.clinic_name_ar,
    clinicSlug: row.clinic_slug,
    timezone: row.timezone,
    adminName: row.admin_name,
    adminEmail: row.admin_email,
    reason: row.reason,
    ip: row.ip,
    userAgent: row.user_agent,
    startedAt: new Date(row.started_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    endReason: row.end_reason,
    patientsViewed: row.patients_viewed,
    patients: row.patients,
    exports: row.exports,
    changes: row.changes,
  }));
}
