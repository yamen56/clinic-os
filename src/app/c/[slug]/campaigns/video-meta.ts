import type { VideoMeta } from "./constants";

/**
 * A video's first proper frame, size and length, measured by the browser that
 * picked it.
 *
 * WhatsApp draws a video from these before anybody downloads it. Baileys would
 * work them out with ffmpeg, which the worker does not have, so without this
 * the recipient sees a grey box with no length — a poor first impression for a
 * clinic's promotion. The browser has to decode the file to preview it anyway.
 *
 * Best effort throughout: a codec this browser cannot play (HEVC on most
 * desktops) or a phone that will not load media without a tap just means fewer
 * fields, never a refused upload. Whatever was measured before a step failed is
 * still returned.
 */
export async function readVideoMeta(file: File): Promise<VideoMeta | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const meta: VideoMeta = {};

  try {
    const loaded = event(video, "loadedmetadata");
    video.src = url;
    await loaded;
    if (video.videoWidth && video.videoHeight) {
      meta.width = video.videoWidth;
      meta.height = video.videoHeight;
    }
    if (Number.isFinite(video.duration) && video.duration > 0) meta.seconds = video.duration;

    // A second in, or a quarter of a short clip: frame zero is often a fade from black.
    const seeked = event(video, "seeked");
    video.currentTime = Math.min(1, (meta.seconds ?? 0) / 4);
    await seeked;
    const thumb = frame(video);
    if (thumb) meta.thumb = thumb;
  } catch {
    // Keep what was measured.
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
  return Object.keys(meta).length ? meta : null;
}

/** Resolves on the event, rejects on an error or after five seconds. */
function event(video: HTMLVideoElement, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 5000);
    video.addEventListener(name, () => (clearTimeout(timer), resolve()), { once: true });
    video.addEventListener("error", () => (clearTimeout(timer), reject(new Error("decode"))), {
      once: true,
    });
  });
}

/** A small JPEG of the current frame, base64 without the data: prefix. */
function frame(video: HTMLVideoElement): string | undefined {
  const w0 = video.videoWidth;
  const h0 = video.videoHeight;
  if (!w0 || !h0) return;
  // Copied into every recipient's message, so kept to a few kilobytes.
  const scale = Math.min(1, 160 / Math.max(w0, h0));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL("image/jpeg", 0.7);
  return data.startsWith("data:image/jpeg;base64,") ? data.slice(data.indexOf(",") + 1) : undefined;
}
