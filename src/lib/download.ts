/**
 * Serving a stored file back to a browser, without handing it the origin.
 *
 * Every file this app stores arrives with a content type somebody else chose.
 * A patient's upload carries whatever the browser put in the multipart part; a
 * WhatsApp attachment carries whatever the *sender's* client declared, and the
 * sender is an unauthenticated stranger who only had to message the clinic's
 * number. Echoing that back as the response's `Content-Type` — which is what
 * these routes used to do — turns any such file into a page on our own origin:
 * `text/html` runs as the staff member who clicked it, with their session, and
 * from there the whole clinic is readable through the app's own API.
 *
 * So the declared type is treated as a hint, never as an instruction. Only
 * types that cannot carry script are rendered in place; everything else is
 * downloaded as opaque bytes. `image/svg+xml` is on the wrong side of that line
 * despite being an image — an SVG opened at a URL is a document, and it scripts.
 */

/**
 * Types safe to show inside the app.
 *
 * PDF stays here deliberately: it is most of what a clinic files, the built-in
 * viewers run it out of process, and forcing every scan and consent form to
 * download instead of preview would be a real cost paid for no real risk.
 */
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "application/pdf",
  "text/plain",
]);

/** Audio and video are inline too — the inbox plays voice notes in place. */
const INLINE_PREFIXES = ["audio/", "video/"];

function isInlineSafe(type: string): boolean {
  return INLINE_TYPES.has(type) || INLINE_PREFIXES.some((p) => type.startsWith(p));
}

/** Strips parameters and casing, so `TEXT/HTML; charset=x` cannot slip past the set. */
function baseType(raw: string | null | undefined): string {
  return String(raw ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Headers for handing back a stored file.
 *
 * `wantsDownload` only ever makes the response *more* conservative: a type that
 * is not inline-safe is an attachment whether the caller asked for one or not.
 */
export function fileResponseHeaders(opts: {
  declaredType: string | null | undefined;
  fileName: string | null | undefined;
  size: number;
  wantsDownload?: boolean;
  cacheControl?: string;
}): Record<string, string> {
  const declared = baseType(opts.declaredType);
  const inlineOk = isInlineSafe(declared) && !opts.wantsDownload;
  const name = opts.fileName || "file";

  const headers: Record<string, string> = {
    // An unrecognised type is served as opaque bytes rather than as whatever it
    // claimed to be, so a mislabelled upload cannot pick its own renderer.
    "Content-Type": inlineOk ? declared : "application/octet-stream",
    "Content-Length": String(opts.size),
    "Content-Disposition": `${inlineOk ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    // Belt to the allowlist's braces: without this a browser may sniff the bytes
    // and decide an `application/octet-stream` is really HTML after all.
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": opts.cacheControl ?? "private, max-age=3600",
  };

  /*
    No Content-Security-Policy is set here, and that is deliberate rather than
    an omission.

    A per-response `sandbox` was the obvious fourth layer, and measuring it
    showed it never arrives: the app-wide policy in next.config.ts is applied to
    every response and replaces whatever a route handler sets for the same
    header. A directive that silently does nothing is worse than no directive,
    because the next person reads it as protection that is already in place.

    What actually stops the attack is the three headers above, and they were
    tested together against a real `text/html` upload: the type is replaced,
    the disposition forces a download, and nosniff stops the browser
    second-guessing either. The script does not run.
  */
  return headers;
}
