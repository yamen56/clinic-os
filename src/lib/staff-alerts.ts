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
  /*
    Instant: sent the moment an appointment is booked, cancelled or moved, to
    the people the row names. For these, as for the reminder, "doctor" means the
    appointment's own doctor. Nobody is told about a change they made themselves.
  */
  "appointment_booked",
  "appointment_cancelled",
  "appointment_rescheduled",
  // Scheduled, like the four above.
  "tomorrow_schedule",
  "unconfirmed_tomorrow",
  "weekly_summary",
] as const;
export type StaffAlertKind = (typeof STAFF_ALERT_KINDS)[number];

/** The kinds that fire on an event rather than at an hour. */
export const INSTANT_ALERT_KINDS: ReadonlySet<StaffAlertKind> = new Set([
  "appointment_booked",
  "appointment_cancelled",
  "appointment_rescheduled",
]);

/** Where "doctor" means the appointment's own doctor, not every doctor in the clinic. */
export const followsAppointmentDoctor = (kind: StaffAlertKind) =>
  kind === "appointment_reminder" || INSTANT_ALERT_KINDS.has(kind);

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
  /** weekly_summary only. ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number | null;
  /** unread_digest only: stay quiet below this many unread conversations. */
  threshold: number;
  enabled: boolean;
  sort: number;
};

/** Which fields a kind actually uses, so the editor shows only those. */
export function alertShape(kind: StaffAlertKind): {
  minutes: boolean;
  hour: boolean;
  weekday: boolean;
  threshold: boolean;
} {
  return {
    minutes: kind === "appointment_reminder",
    hour: kind !== "appointment_reminder" && !INSTANT_ALERT_KINDS.has(kind),
    weekday: kind === "weekly_summary",
    threshold: kind === "unread_digest",
  };
}

/**
 * Ready-made alerts, grouped by who they are for.
 *
 * The editor offers these first, so a clinic setting up reception does not have
 * to know that "unconfirmed tomorrow at five" is a thing it could build — it
 * picks "For reception" and sees it. Each is only a starting shape; everything
 * about it stays editable once picked.
 */
export type AlertTemplate = {
  id: string;
  forRole: StaffAlertRole;
  kind: StaffAlertKind;
  roles: StaffAlertRole[];
  minutes_before?: number | null;
  at_hour?: number | null;
  weekday?: number | null;
  threshold?: number;
};

export const ALERT_TEMPLATES: AlertTemplate[] = [
  // Doctors
  { id: "doc-reminder-15", forRole: "doctor", kind: "appointment_reminder", roles: ["doctor"], minutes_before: 15 },
  { id: "doc-booked", forRole: "doctor", kind: "appointment_booked", roles: ["doctor"] },
  { id: "doc-cancelled", forRole: "doctor", kind: "appointment_cancelled", roles: ["doctor"] },
  { id: "doc-moved", forRole: "doctor", kind: "appointment_rescheduled", roles: ["doctor"] },
  { id: "doc-morning", forRole: "doctor", kind: "day_schedule", roles: ["doctor"], at_hour: 8 },
  { id: "doc-evening", forRole: "doctor", kind: "tomorrow_schedule", roles: ["doctor"], at_hour: 20 },
  // Reception
  { id: "rec-booked", forRole: "receptionist", kind: "appointment_booked", roles: ["receptionist"] },
  { id: "rec-cancelled", forRole: "receptionist", kind: "appointment_cancelled", roles: ["receptionist"] },
  { id: "rec-unconfirmed", forRole: "receptionist", kind: "unconfirmed_tomorrow", roles: ["receptionist"], at_hour: 17 },
  { id: "rec-unread", forRole: "receptionist", kind: "unread_digest", roles: ["receptionist"], at_hour: 12, threshold: 3 },
  { id: "rec-morning", forRole: "receptionist", kind: "day_schedule", roles: ["receptionist"], at_hour: 8 },
  // The owner
  { id: "own-day-end", forRole: "owner", kind: "day_end", roles: ["owner"], at_hour: 20 },
  { id: "own-week", forRole: "owner", kind: "weekly_summary", roles: ["owner"], at_hour: 9, weekday: 7 },
  { id: "own-unconfirmed", forRole: "owner", kind: "unconfirmed_tomorrow", roles: ["owner"], at_hour: 17 },
  { id: "own-cancelled", forRole: "owner", kind: "appointment_cancelled", roles: ["owner"] },
];

/**
 * What a brand-new clinic gets. The first four are what migration 0033
 * backfilled — precisely the behaviour the worker had hardcoded. The rest came
 * with 0061 and were backfilled the same way. Kept in step with the
 * `seed_clinic_staff_alerts` trigger, which is the real guarantee.
 */
const row = (
  kind: StaffAlertKind,
  roles: StaffAlertRole[],
  sort: number,
  more: Partial<Omit<StaffAlert, "id" | "kind" | "roles" | "sort">> = {}
): Omit<StaffAlert, "id"> => ({
  kind,
  roles,
  minutes_before: null,
  at_hour: null,
  weekday: null,
  threshold: 0,
  enabled: true,
  sort,
  ...more,
});

export const DEFAULT_STAFF_ALERTS: Omit<StaffAlert, "id">[] = [
  row("appointment_reminder", ["doctor"], 0),
  row("day_schedule", ["doctor"], 1, { at_hour: 8 }),
  row("day_end", ["owner"], 2, { at_hour: 20 }),
  row("unread_digest", ["owner", "receptionist"], 3, { at_hour: 12, threshold: 3 }),
  row("appointment_booked", ["doctor"], 4),
  row("appointment_cancelled", ["doctor"], 5),
  row("appointment_rescheduled", ["doctor"], 6),
  row("unconfirmed_tomorrow", ["owner", "receptionist"], 7, { at_hour: 17 }),
  // Off until a clinic wants it: doctors already get their list each morning.
  row("tomorrow_schedule", ["doctor"], 8, { at_hour: 20, enabled: false }),
  // Sunday morning, the start of the working week here — as for the documents digest.
  row("weekly_summary", ["owner"], 9, { at_hour: 9, weekday: 7 }),
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
      `insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, at_hour, weekday, threshold, enabled, sort)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [clinicId, a.kind, a.roles, a.minutes_before, a.at_hour, a.weekday, a.threshold, a.enabled, a.sort]
    );
  }
}

export async function loadStaffAlerts(c: PoolClient, clinicId: string): Promise<StaffAlert[]> {
  const r = await c.query(
    `select id, kind, roles, minutes_before, at_hour, weekday, threshold, enabled, sort
     from clinic_staff_alerts where clinic_id = $1 order by sort, created_at`,
    [clinicId]
  );
  return r.rows as StaffAlert[];
}

/**
 * The alert kinds this clinic currently sends to one member — what decides
 * which switches their own preferences page shows. A doctor on a clinic that
 * never sends the end-of-day summary to doctors is not offered a switch for it.
 */
export async function alertKindsFor(
  c: PoolClient,
  clinicId: string,
  member: { role: string; isOwner: boolean }
): Promise<Set<string>> {
  const r = await c.query(
    `select distinct kind from clinic_staff_alerts
      where clinic_id = $1 and enabled
        and (($2 and 'owner' = any(roles)) or $3 = any(roles))`,
    [clinicId, member.isOwner, member.role]
  );
  return new Set(r.rows.map((x) => x.kind as string));
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
  appointment_booked: "appointment_booked",
  appointment_cancelled: "appointment_cancelled",
  appointment_rescheduled: "appointment_rescheduled",
  tomorrow_schedule: "tomorrow_schedule",
  unconfirmed_tomorrow: "unconfirmed_tomorrow",
  weekly_summary: "weekly_summary",
};
