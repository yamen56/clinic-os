/**
 * The dental chart's rows, read for a patient file and shaped for the page.
 *
 * One function per kind of row so the routes that write a row can answer with
 * it in the same shape the page was loaded with — the client never has to
 * guess what the server stored.
 */

import type { PoolClient } from "pg";
import { BORROWABLE_LOOKS, BUILT_IN_BY_KEY, type Category, type Look, type Scope, type Treatment } from "./catalog";
import type { Mark, MarkEvent } from "./state";

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

export const MARK_SELECT = `
  select m.*, pu.full_name as performer_name, ru.full_name as recorder_name, vu.full_name as voider_name
    from chart_marks m
    left join clinic_members pm on pm.id = m.performed_by
    left join users pu on pu.id = pm.user_id
    left join users ru on ru.id = m.recorded_by
    left join users vu on vu.id = m.voided_by`;

export function toMark(r: Record<string, unknown>): Mark {
  return {
    id: r.id as string,
    site: r.site as string,
    surfaces: (r.surfaces as Mark["surfaces"]) ?? [],
    treatmentKey: r.treatment_key as string,
    label: r.label as string,
    labelAr: r.label_ar as string,
    abbr: (r.abbr as string) ?? undefined,
    look: r.look as Look,
    kind: r.kind as Mark["kind"],
    detail: (r.detail as Record<string, string>) ?? {},
    status: r.status as Mark["status"],
    groupId: (r.group_id as string) ?? undefined,
    role: (r.role as Mark["role"]) ?? undefined,
    performedBy: r.performed_by ? { id: r.performed_by as string, name: (r.performer_name as string) ?? "" } : null,
    recordedBy: { id: (r.recorded_by as string) ?? "", name: (r.recorder_name as string) ?? "" },
    createdAt: iso(r.created_at)!,
    doneAt: iso(r.done_at),
    voidedAt: iso(r.voided_at),
    voidedBy: r.voided_by ? { id: r.voided_by as string, name: (r.voider_name as string) ?? "" } : null,
    voidReason: (r.void_reason as string) ?? null,
    note: (r.note as string) ?? "",
  };
}

export function toEvent(r: Record<string, unknown>): MarkEvent {
  return {
    id: r.id as string,
    markId: r.mark_id as string,
    action: r.action as MarkEvent["action"],
    at: iso(r.at)!,
    by: { id: (r.by_user as string) ?? "", name: (r.by_name as string) ?? "" },
    reason: (r.reason as string) ?? undefined,
  };
}

export const CUSTOM_CATEGORIES: Category[] = [
  "findings",
  "diagnostic",
  "preventive",
  "restorative",
  "endodontic",
  "periodontic",
  "fixed",
  "removable",
  "implant",
  "surgery",
  "ortho",
  "pediatric",
  "cosmetic",
];
export const CUSTOM_SCOPES: Scope[] = ["surface", "tooth", "quadrant", "arch", "mouth"];
export const CUSTOM_LOOKS = BORROWABLE_LOOKS;

/** A clinic's own treatment, as the catalog knows treatments. */
export function toCustomTreatment(r: Record<string, unknown>): Treatment {
  const category = r.category as Category;
  const scope = r.scope as Scope;
  return {
    key: `custom:${r.id as string}`,
    kind: category === "findings" ? "finding" : "procedure",
    category,
    en: r.name as string,
    ar: r.name as string,
    abbr: (r.abbr as string) ?? undefined,
    scope,
    needsSurfaces: scope === "surface",
    look: r.look as Look,
    custom: { addedBy: (r.creator_name as string) ?? "", addedAt: iso(r.created_at)! },
  };
}

export type FavoriteRow = { key: string; addedBy: { id: string; name: string }; addedAt: string };

export type DentalChartData = {
  marks: Mark[];
  events: MarkEvent[];
  custom: Treatment[];
  favorites: FavoriteRow[];
};

/**
 * Everything the chart needs for one patient, in one round trip.
 *
 * One statement rather than one per kind of row: everything on a connection
 * runs in series, so four queries were four round trips to the database, and
 * the patient file waits on them before it can render. Timestamps come back
 * through JSON as ISO strings, which `iso()` reads like the dates node-pg
 * would have handed over.
 */
export async function loadDentalChart(c: PoolClient, clinicId: string, patientId: string): Promise<DentalChartData> {
  const r = (
    await c.query(
      `select
         (select coalesce(json_agg(x order by x.created_at), '[]'::json)
            from (${MARK_SELECT} where m.clinic_id = $1 and m.patient_id = $2) x) as marks,
         (select coalesce(json_agg(x order by x.at), '[]'::json)
            from (select e.*, u.full_name as by_name
                    from chart_mark_events e
                    join chart_marks m on m.id = e.mark_id
                    left join users u on u.id = e.by_user
                   where m.clinic_id = $1 and m.patient_id = $2) x) as events,
         (select coalesce(json_agg(x order by x.created_at), '[]'::json)
            from (select t.*, u.full_name as creator_name
                    from chart_treatments t left join users u on u.id = t.created_by
                   where t.clinic_id = $1 and t.chart = 'dental' and t.archived_at is null) x) as custom,
         (select coalesce(json_agg(x order by x.sort, x.added_at), '[]'::json)
            from (select f.treatment_key, f.added_at, f.added_by, f.sort, u.full_name as added_name
                    from chart_treatment_favorites f left join users u on u.id = f.added_by
                   where f.clinic_id = $1 and f.chart = 'dental') x) as favorites`,
      [clinicId, patientId]
    )
  ).rows[0] as Record<string, Record<string, unknown>[]>;
  return {
    marks: r.marks.map(toMark),
    events: r.events.map(toEvent),
    custom: r.custom.map(toCustomTreatment),
    favorites: r.favorites.map((f) => ({
      key: f.treatment_key as string,
      addedBy: { id: (f.added_by as string) ?? "", name: (f.added_name as string) ?? "" },
      addedAt: iso(f.added_at)!,
    })),
  };
}

/**
 * The treatment behind a key, as this clinic knows it: a built-in, or one of
 * its own (`custom:<uuid>`, still unarchived). Null for anything else — the
 * server never takes a treatment's name or drawing from the browser.
 */
export async function resolveTreatment(c: PoolClient, clinicId: string, key: string): Promise<Treatment | null> {
  const built = BUILT_IN_BY_KEY.get(key);
  if (built) return built;
  const m = /^custom:([0-9a-f-]{36})$/i.exec(key);
  if (!m) return null;
  const r = await c.query(
    `select t.*, u.full_name as creator_name from chart_treatments t left join users u on u.id = t.created_by
      where t.id = $1 and t.clinic_id = $2 and t.archived_at is null`,
    [m[1], clinicId]
  );
  return r.rows[0] ? toCustomTreatment(r.rows[0]) : null;
}
