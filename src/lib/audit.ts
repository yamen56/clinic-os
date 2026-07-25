import type { PoolClient } from "pg";

export async function audit(
  c: PoolClient,
  entry: {
    clinicId?: string | null;
    userId?: string | null;
    impersonatedBy?: string | null;
    action: string;
    entity?: string;
    entityId?: string;
    detail?: Record<string, unknown>;
  }
) {
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
