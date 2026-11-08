import type { DateTime } from "luxon";

/*
  The once-a-day automation triggers — recall, birthdays, unpaid invoices, the
  doctor's next visit, stalled treatments, unsigned documents — used to fire
  only when the scheduler's tick landed in the first three minutes of their
  hour. The tick runs every minute *plus* however long the last one took, and
  a deploy restarts the worker: a restart or a slow tick inside those three
  minutes lost the day for good, because tomorrow's date no longer matches.

  They now run on every tick from their hour until the evening. What stops a
  second run is each trigger's own "already started today for this" check;
  what keeps it cheap is resting a flow for half an hour once a pass starts
  nothing.
*/

export const DAILY_UNTIL_HOUR = 20;

/** From `hour` until the evening, in the clinic's own time. */
export function dailyWindowOpen(localNow: DateTime, hour: number): boolean {
  return localNow.hour >= hour && localNow.hour < DAILY_UNTIL_HOUR;
}

const restingUntil = new Map<string, number>();

/** Whether this flow's daily pass has nothing to do for now. */
export function resting(key: string): boolean {
  return (restingUntil.get(key) ?? 0) > Date.now();
}

/** After a pass: one that started nothing rests for half an hour. */
export function rest(key: string, started: number): void {
  if (!started) restingUntil.set(key, Date.now() + 30 * 60_000);
}
