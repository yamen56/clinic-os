/**
 * Public base URL of the app.
 *
 * Invitation and reset links are emailed, so they must be absolute and must
 * point at the real deployment — a relative path or a localhost URL in someone's
 * inbox is useless. APP_URL is set explicitly in production; the localhost
 * default is for development only, and an email sent with it is a bug.
 */
export function appUrl(): string {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return "http://localhost:3000";
}
