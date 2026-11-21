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
  /*
    Instant, the moment a patient writes on WhatsApp (0110, a row since 0111).
    "doctor" here means the patient's own doctor; see worker/wa/message-alert.
  */
  "patient_message",
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
  "patient_message",
  "appointment_booked",
  "appointment_cancelled",
  "appointment_rescheduled",
]);

/** Where "doctor" means the appointment's own doctor, not every doctor in the clinic. */
export const followsAppointmentDoctor = (kind: StaffAlertKind) =>
  kind === "appointment_reminder" || (INSTANT_ALERT_KINDS.has(kind) && kind !== "patient_message");

/** Where "doctor" means the patient's own doctor: of their next visit, else their last. */
export const followsPatientDoctor = (kind: StaffAlertKind) => kind === "patient_message";

/**
 * Whether a clinic may hold more than one row of this kind. A timed one can
 * be wanted twice — a reminder an hour before and again ten minutes before, a
 * morning list for doctors at 8 and for reception at 7. An instant one has
 * no time to differ by: a second row of it is the same alert sent twice, so
 * adding one adds its people to the row there is.
 */
export const allowsSeveral = (kind: StaffAlertKind) => !INSTANT_ALERT_KINDS.has(kind);

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
  row("patient_message", ["owner", "receptionist", "doctor"], -1),
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

