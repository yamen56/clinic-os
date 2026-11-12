import type { PoolClient } from "pg";

/**
 * The services of a visit after its first (migration 0106).
 *
 * `appointments.service_id` is the first service and everything that already
 * read it still does. This file is the rest: writing them, and reading them
 * back in the order they were chosen.
 *
 * Relative imports only — the worker loads src/lib and cannot resolve `@/`.
 */

/** A visit never needs more, and a public form must not be able to ask for a hundred. */
export const MAX_VISIT_SERVICES = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One of a visit's further services, as the calendar carries it. */
export type ExtraService = { id: string; name: string; name_ar: string | null; duration_min: number };

/**
 * What the browser sent, as a list worth trusting the shape of: real ids, each
 * once, in the order given, no more than a visit may hold. Whether they are
 * this clinic's services is checked where they are written.
 */
export function cleanServiceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string" || !UUID.test(x) || out.includes(x)) continue;
    out.push(x);
    if (out.length >= MAX_VISIT_SERVICES) break;
  }
  return out;
}

/**
 * Replaces a visit's further services with these, in this order.
 *
 * Only the clinic's own services are written — the insert selects them from
 * `services`, so an id from anywhere else is dropped rather than trusted. The
 * foreign key would not catch it: it runs as the table owner and does not see
 * row-level security. The visit's first service is left out, so naming it
 * twice cannot list it twice.
 */
export async function setExtraServices(
  c: PoolClient,
  clinicId: string,
  appointmentId: string,
  primaryId: string | null,
  extraIds: string[]
): Promise<void> {
  const ids = cleanServiceIds(extraIds).filter((x) => x !== primaryId);
  await c.query(`delete from appointment_extra_services where appointment_id = $1 and clinic_id = $2`, [
    appointmentId,
    clinicId,
  ]);
  if (!ids.length) return;
  await c.query(
    `insert into appointment_extra_services (clinic_id, appointment_id, service_id, sort)
     select $1, $2, s.id, x.ord::int
       from unnest($3::uuid[]) with ordinality as x(id, ord)
       join services s on s.id = x.id and s.clinic_id = $1
     on conflict (appointment_id, service_id) do nothing`,
    [clinicId, appointmentId, ids]
  );
}

/**
 * A visit's further services as a JSON array, for a query that already has the
 * appointment under `alias`. Empty array when there are none.
 */
export function extraServicesSql(alias: string): string {
  return `(select coalesce(json_agg(json_build_object(
                    'id', xs.id, 'name', xs.name, 'name_ar', xs.name_ar, 'duration_min', xs.duration_min)
                  order by xe.sort), '[]'::json)
             from appointment_extra_services xe join services xs on xs.id = xe.service_id
            where xe.appointment_id = ${alias}.id)`;
}

/** The ids of every service on a visit, first one first. */
export async function visitServiceIds(c: PoolClient, appointmentId: string): Promise<string[]> {
  const r = await c.query(
    `select x.service_id from (
       select a.service_id, 0 as ord from appointments a where a.id = $1 and a.service_id is not null
       union all
       select e.service_id, 1 + e.sort from appointment_extra_services e where e.appointment_id = $1
     ) x order by x.ord`,
    [appointmentId]
  );
  return r.rows.map((x) => x.service_id as string);
}
