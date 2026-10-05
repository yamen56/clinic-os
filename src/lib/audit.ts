import type { PoolClient } from "pg";

type AuditEntry = {
  clinicId?: string | null;
  userId?: string | null;
  impersonatedBy?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  detail?: Record<string, unknown>;
};

export async function audit(c: PoolClient, entry: AuditEntry) {
  await c.query(
    `insert into audit_log (clinic_id, user_id, impersonated_by, action, entity, entity_id, detail)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.clinicId ?? null,
      entry.userId ?? null,
      entry.impersonatedBy ?? null,
      entry.action,
      entry.entity ?? "",
      entry.entityId ?? "",
      JSON.stringify(entry.detail ?? {}),
    ]
  );
}

/**
 * Somebody looked at a patient's record.
 *
 * Writes used to be the only thing recorded, so "who opened this file" had no
 * answer — and it is the first question a health-data review asks, and the one
 * a patient asks after a leak. At most one row per person, file and action an
 * hour: a receptionist refreshing a file all morning is one fact, not three
 * hundred, and a log nobody can read for the noise answers nothing either.
 *
 * One statement, so the page that calls it pays one round trip, not two.
 */
export async function auditView(c: PoolClient, entry: AuditEntry) {
  await c.query(
    `insert into audit_log (clinic_id, user_id, impersonated_by, action, entity, entity_id, detail)
     select $1, $2::uuid, $3, $4, $5, $6, $7
      where not exists (
        select 1 from audit_log
         where entity_id = $6 and action = $4 and user_id is not distinct from $2::uuid
           and created_at > now() - interval '1 hour')`,
    [
      entry.clinicId ?? null,
      entry.userId ?? null,
      entry.impersonatedBy ?? null,
      entry.action,
      entry.entity ?? "",
      entry.entityId ?? "",
      JSON.stringify(entry.detail ?? {}),
    ]
  );
}
