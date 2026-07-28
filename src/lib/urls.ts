/**
 * Public base URL of the app.
 *
 * Invitation and reset links are emailed, so they must be absolute and must
 * point at the real deployment — a relative path or a localhost URL in someone's
 * inbox is useless. APP_URL is set explicitly in production; VERCEL_URL is the
 * fallback for preview deployments, which have no stable hostname.
 */
export function appUrl(): string {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
