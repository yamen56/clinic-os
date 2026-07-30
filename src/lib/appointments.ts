import type { PoolClient } from "pg";

/**
 * Serialises scheduling for one clinic until the surrounding transaction ends.
 *
 * Every booking path — staff calendar, public link, AI receptionist — checks
 * that a slot is free and then inserts. Those are two statements, and nothing
 * stood between them: two people booking the same slot at the same moment both
 * saw it free (an uncommitted row is invisible under READ COMMITTED) and both
 * wrote. The result is two patients arriving for one appointment, which the
 * clinic only discovers in the waiting room.
 *
 * The lock is taken per clinic rather than per doctor because a booking may
 * still be choosing between doctors when it needs the lock, and because
 * scheduling writes are rare enough that clinic-wide serialisation costs
 * nothing. It is released automatically on commit or rollback.
 *
 * Call this *before* the availability check, never between the check and the
 * insert.
 */
export async function lockClinicSchedule(c: PoolClient, clinicId: string): Promise<void> {
  await c.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [clinicId]);
}
