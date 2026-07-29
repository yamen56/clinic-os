/**
 * Values shared by server and client i18n code.
 *
 * Kept separate because `./index` imports `next/headers`, which cannot be pulled
 * into a client component — the language toggle needs the cookie name in the
 * browser to set it without a server round trip.
 */
export const LOCALE_COOKIE = "cos_locale";
