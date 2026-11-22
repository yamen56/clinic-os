import type { PoolClient } from "pg";
import type { PatientFill } from "./questions";

/**
 * The details a patient filled in on the signing page, written into their file.
 *
 * Gaps only: a value staff already entered is never replaced by what the
 * patient typed (`coalesce` on columns, `new || stored` on custom fields, so
 * the stored object wins key by key) — the same rule booking intake follows.
 * Name and phone are never fillable; they are how the patient was reached.
 */
export async function applyPatientFills(
  c: PoolClient,
  args: { clinicId: string; patientId: string; fills: PatientFill[]; answers: Record<string, unknown> }
): Promise<void> {
  const given = args.fills.filter((f) => {
    const v = args.answers[f.key];
    return v !== undefined && v !== null && String(v).trim() !== "";
  });
  if (!given.length) return;

  const defs = (
    await c.query(
      `select key, source_column, storage_key from patient_field_definitions
        where clinic_id = $1 and key = any($2::text[])`,
      [args.clinicId, given.map((f) => f.key)]
    )
  ).rows as { key: string; source_column: string | null; storage_key: string | null }[];
  const byKey = new Map(defs.map((d) => [d.key, d]));

  const custom: Record<string, unknown> = {};
  for (const f of given) {
    const def = byKey.get(f.key);
    if (!def) continue;
    const raw = args.answers[f.key];
    const value = typeof raw === "string" ? raw.trim().slice(0, 500) : raw;
    if (def.source_column === "birth_date") {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        await c.query(`update patients set birth_date = coalesce(birth_date, $3::date) where id = $1 and clinic_id = $2`, [
          args.patientId,
          args.clinicId,
          value,
        ]);
      }
      continue;
    }
    if (def.source_column === "gender") {
      if (value === "male" || value === "female") {
        await c.query(`update patients set gender = coalesce(gender, $3) where id = $1 and clinic_id = $2`, [
          args.patientId,
          args.clinicId,
          value,
        ]);
      }
      continue;
    }
    // Any other real column (name, phone) is not the patient's to set from a link.
    if (def.source_column) continue;
    custom[def.storage_key ?? def.key.replace(/^patient\./, "")] = value;
  }

  if (Object.keys(custom).length) {
    // Re-stringified: a JS object handed to a jsonb parameter goes out as a PG array literal.
    await c.query(`update patients set custom_fields = $3::jsonb || custom_fields where id = $1 and clinic_id = $2`, [
      args.patientId,
      args.clinicId,
      JSON.stringify(custom),
    ]);
  }
}
