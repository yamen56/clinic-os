/**
 * Where to fetch a clinic's own logo.
 *
 * The route that serves it caches for five minutes, which is right for the
 * booking page and wrong for the moment straight after an upload — the clinic
 * would pick a new logo and keep being shown the old one. `logo_path` is
 * rewritten on every upload, so keying the URL to it means the new file is
 * asked for under a URL nothing has cached yet, and the old one keeps its cache
 * for anyone still looking at it.
 */
export function clinicLogoUrl(
  slug: string,
  logoPath: string | null | undefined
): string | null {
  if (!logoPath) return null;
  const version = logoPath.replace(/[^a-z0-9]/gi, "").slice(-10);
  return `/api/public/clinic-logo/${encodeURIComponent(slug)}?v=${version}`;
}
