/**
 * Where a patient is in the clinic today, derived from the appointment.
 *
 * Kept out of `status` on purpose (see migration 0078): arriving is not
 * confirming, and the thirty places that read `status` keep meaning what they
 * meant. Pure, so the board, the calendar cards, the dashboard and QA all
 * derive it the same way.
 */

/** Minutes past the start time before an absent patient shows as late. */
export const LATE_GRACE_MIN = 10;

export type FlowStage = "hidden" | "no_show" | "finished" | "in_room" | "waiting" | "late" | "expected";

export type FlowFields = {
  status: string;
  starts_at: string;
  arrived_at: string | null;
  seated_at: string | null;
  finished_at?: string | null;
};

export function flowStage(a: FlowFields, nowMs: number): FlowStage {
  if (a.status === "cancelled") return "hidden";
  if (a.status === "no_show") return "no_show";
  if (a.status === "completed") return "finished";
  if (a.seated_at) return "in_room";
  if (a.arrived_at) return "waiting";
  if (nowMs > Date.parse(a.starts_at) + LATE_GRACE_MIN * 60_000) return "late";
  return "expected";
}

/** Whole minutes between two instants, never negative. */
export function minutesBetween(fromIso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 60_000));
}
