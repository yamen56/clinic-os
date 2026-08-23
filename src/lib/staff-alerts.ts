import type { PoolClient } from "pg";

/**
 * The alerts a clinic's own people get: doctors, reception, the owner.
 *
 * These were four hardcoded rules in the worker — a reminder before each
 * appointment, a morning schedule at 08:00, an end-of-day summary at 20:00, an
 * unread-messages nudge at noon. Every clinic got exactly those four, at exactly
 * those hours, and the only control anyone had was a per-person on/off switch
 * buried in their notification preferences.
 *
 * Now they are rows. A clinic can add a second reminder at a different lead
 * time, send the morning list to reception as well as the doctors, move the
 * summary to whenever their day actually ends, or delete the ones they never
 * read.
 */

export const STAFF_ALERT_KINDS = [
  "appointment_reminder",
  "day_schedule",
  "day_end",
  "unread_digest",
] as const;
export type StaffAlertKind = (typeof STAFF_ALERT_KINDS)[number];

/** Same vocabulary as notify.staffInRoles — 'owner' is a flag, not a job title. */
export const STAFF_ALERT_ROLES = ["owner", "doctor", "receptionist"] as const;
export type StaffAlertRole = (typeof STAFF_ALERT_ROLES)[number];

export type StaffAlert = {
  id: string;
  kind: StaffAlertKind;
  roles: StaffAlertRole[];
  /** appointment_reminder only. null = whatever each recipient set for themselves. */
  minutes_before: number | null;
  /** Digests only, in the clinic's own timezone. */
  at_hour: number | null;
  /** unread_digest only: stay quiet below this many unread conversations. */
  threshold: number;
  enabled: boolean;
  sort: number;
};

/** Which fields a kind actually uses, so the editor shows only those. */
export function alertShape(kind: StaffAlertKind): {
  minutes: boolean;
  hour: boolean;
  threshold: boolean;
} {
  return {
    minutes: kind === "appointment_reminder",
    hour: kind !== "appointment_reminder",
    threshold: kind === "unread_digest",
  };
}

/**
 * What a brand-new clinic gets, and what migration 0033 backfilled onto every
 * clinic that already existed: precisely the behaviour the worker had hardcoded,
 * so nobody's notifications changed on the day this shipped.
 */
export const DEFAULT_STAFF_ALERTS: Omit<StaffAlert, "id">[] = [
  {
    kind: "appointment_reminder",
    roles: ["doctor"],
    minutes_before: null,
    at_hour: null,
    threshold: 0,
    enabled: true,
    sort: 0,
  },
  { kind: "day_schedule", roles: ["doctor"], minutes_before: null, at_hour: 8, threshold: 0, enabled: true, sort: 1 },
  { kind: "day_end", roles: ["owner"], minutes_before: null, at_hour: 20, threshold: 0, enabled: true, sort: 2 },
  {
    kind: "unread_digest",
    roles: ["owner", "receptionist"],
    minutes_before: null,
    at_hour: 12,
    threshold: 3,
    enabled: true,
    sort: 3,
  },
];

/**
 * Belt-and-braces.
 *
 * The real guarantee is a trigger on `clinics` (migration 0033), because a
 * clinic created down some path that forgot to call this would not look broken —
 * its doctors would simply stop being reminded. This stays because it costs one
 * query and covers the day somebody drops the trigger; it is a no-op in
 * practice, and it never resurrects an alert a clinic deliberately deleted.
 */
export async function seedStaffAlerts(c: PoolClient, clinicId: string): Promise<void> {
  const existing = await c.query(`select 1 from clinic_staff_alerts where clinic_id = $1 limit 1`, [
    clinicId,
  ]);
  if (existing.rowCount) return;
  for (const a of DEFAULT_STAFF_ALERTS) {
    await c.query(
      `insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, at_hour, threshold, enabled, sort)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [clinicId, a.kind, a.roles, a.minutes_before, a.at_hour, a.threshold, a.enabled, a.sort]
    );
  }
}

export async function loadStaffAlerts(c: PoolClient, clinicId: string): Promise<StaffAlert[]> {
  const r = await c.query(
    `select id, kind, roles, minutes_before, at_hour, threshold, enabled, sort
     from clinic_staff_alerts where clinic_id = $1 order by sort, created_at`,
    [clinicId]
  );
  return r.rows as StaffAlert[];
}

/**
 * The notification `kind` each alert writes.
 *
 * Deliberately the values that already existed, because every user's saved
 * notification preferences are keyed by them — changing the string here would
 * silently un-mute everyone who had muted their morning digest.
 */
export const ALERT_NOTIFICATION_KIND: Record<StaffAlertKind, string> = {
  appointment_reminder: "doctor_reminder",
  day_schedule: "daily_summary",
  day_end: "day_end",
  unread_digest: "unread_digest",
};
