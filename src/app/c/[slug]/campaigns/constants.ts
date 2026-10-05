/**
 * Shared by the campaign actions and the campaign UI.
 *
 * Kept out of `actions.ts` because a "use server" module may only export async
 * functions — anything else there becomes a build error rather than a constant.
 */

/** Pacing floor. Anything faster is a blast wearing a drip's clothes. */
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 86400;

/** WhatsApp's own ceiling for a photo or video, and the inbox's attachment limit. */
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/*
  What the picker offers. Photos are re-encoded to JPEG on upload, so any of
  these arrive as one format. Video is MP4 only: the worker sends the bytes as
  they are, with no transcoder, and MP4 is the one container every WhatsApp
  client plays. A .mov from an iPhone usually plays too, but "usually" is not a
  promise worth making to three hundred patients at once.
*/
export const MEDIA_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MEDIA_VIDEO_TYPES = ["video/mp4"];

/** What WhatsApp draws before a video is downloaded. Taken in the browser; see migration 0066. */
export type VideoMeta = {
  /** Base64 JPEG, no data: prefix. */
  thumb?: string;
  width?: number;
  height?: number;
  seconds?: number;
};

/** An uploaded file, as the upload route hands it back. */
export type UploadedMedia = { path: string; name: string; kind: "image" | "video" };

export type CampaignAudience = {
  total: number;
  /** How many will actually be messaged: a number on file, and not muted. */
  reachable: number;
  /** Of those matched, how many are muted from automations and campaigns. */
  muted: number;
  sample: string[];
};
