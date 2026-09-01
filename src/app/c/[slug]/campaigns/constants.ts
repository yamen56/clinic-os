/**
 * Shared by the campaign actions and the campaign UI.
 *
 * Kept out of `actions.ts` because a "use server" module may only export async
 * functions — anything else there becomes a build error rather than a constant.
 */

/** Pacing floor. Anything faster is a blast wearing a drip's clothes. */
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 86400;

export type CampaignAudience = {
  total: number;
  /** How many will actually be messaged: a number on file, and not muted. */
  reachable: number;
  /** Of those matched, how many are muted from automations and campaigns. */
  muted: number;
  sample: string[];
};
