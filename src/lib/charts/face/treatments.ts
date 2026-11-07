import type { PoolClient } from "pg";
import { FACE_TREATMENT_BY_KEY, type FaceTreatment, type FaceVariant, type Family, type PricedBy } from "./catalog";

/**
 * The clinic's own face treatments and variants (0094), on the server.
 *
 * Every place that used to look a key up in the fixed catalog asks here instead,
 * so a clinic's own treatment is accepted wherever a built-in one is: recording,
 * pricing, packages, products. Archived ones are still found, because a chart
 * entry from last year still names them; only the pickers leave them out.
 */

export const CUSTOM_PREFIX = "aes_c_";

/** A treatment's key from its id: `aes_` keeps it with the face chart's prices, never the dental list. */
export const customKey = (id: string) => `${CUSTOM_PREFIX}${id.replace(/-/g, "")}`;

type Row = Record<string, unknown>;

const toTreatment = (r: Row): FaceTreatment => ({
  key: r.key as string,
  en: r.name as string,
  ar: (r.name_ar as string) || (r.name as string),
  family: r.family as Family,
  pricedBy: r.priced_by as PricedBy,
  fits: (r.fits as string[]) ?? [],
  units: !!r.units,
  custom: true,
  archived: !!r.archived_at,
});

const toVariant = (r: Row): FaceVariant => ({
  id: r.id as string,
  treatmentKey: r.treatment_key as string,
  name: r.name as string,
  nameAr: (r.name_ar as string) ?? null,
  productId: (r.product_id as string) ?? null,
  active: !!r.active,
});

/** The clinic's own treatments, archived ones included, and every variant. */
export async function loadClinicTreatments(c: PoolClient, clinicId: string): Promise<{ custom: FaceTreatment[]; variants: FaceVariant[] }> {
  const t = await c.query(`select * from aesthetic_treatments where clinic_id = $1 order by created_at`, [clinicId]);
  const v = await c.query(`select * from aesthetic_treatment_variants where clinic_id = $1 order by sort, created_at`, [clinicId]);
  return { custom: t.rows.map(toTreatment), variants: v.rows.map(toVariant) };
}

/** A treatment by key, built-in or this clinic's own, archived or not. */
export async function resolveTreatment(c: PoolClient, clinicId: string, key: string): Promise<FaceTreatment | null> {
  const built = FACE_TREATMENT_BY_KEY.get(key);
  if (built) return built;
  if (!key.startsWith(CUSTOM_PREFIX)) return null;
  const r = await c.query(`select * from aesthetic_treatments where clinic_id = $1 and key = $2`, [clinicId, key]);
  return r.rows[0] ? toTreatment(r.rows[0]) : null;
}

/** Every key this clinic may use, for filtering lists the browser sent. */
export async function clinicTreatmentKeys(c: PoolClient, clinicId: string): Promise<Set<string>> {
  const r = await c.query(`select key from aesthetic_treatments where clinic_id = $1`, [clinicId]);
  return new Set([...FACE_TREATMENT_BY_KEY.keys(), ...r.rows.map((x) => x.key as string)]);
}

/** A variant of this treatment, in this clinic, still in use. */
export async function resolveVariant(c: PoolClient, clinicId: string, treatmentKey: string, id: string): Promise<FaceVariant | null> {
  const r = await c.query(`select * from aesthetic_treatment_variants where id = $1 and clinic_id = $2 and treatment_key = $3 and active`, [id, clinicId, treatmentKey]);
  return r.rows[0] ? toVariant(r.rows[0]) : null;
}
