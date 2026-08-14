/**
 * How long a deleted clinic can still be brought back.
 *
 * Shared between the web app, which shows the countdown and offers the restore,
 * and the worker, which performs the irreversible delete once it runs out. Two
 * copies of this number would eventually disagree, and the disagreement would
 * only ever be discovered by somebody asking for data that was destroyed a week
 * before the screen said it would be.
 *
 * Sixty days is a deliberate choice rather than a round one. A clinic that
 * leaves is usually gone for good, but the cases where somebody wants their
 * records back — a dispute, an audit, a change of heart, a wrong button — do not
 * surface in a week. It is also long enough that a purge is never a surprise:
 * the clinic sat visibly in the deleted list for two months first.
 */
export const RESTORE_WINDOW_DAYS = 60;

/** Whole days left before the purge. Zero once it is due; never negative. */
export function daysUntilPurge(deletedAt: Date | string): number {
  const at = typeof deletedAt === "string" ? new Date(deletedAt) : deletedAt;
  const due = at.getTime() + RESTORE_WINDOW_DAYS * 86_400_000;
  return Math.max(0, Math.ceil((due - Date.now()) / 86_400_000));
}
