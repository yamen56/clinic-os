import { en, type Dict } from "./en";
import { ar } from "./ar";

/**
 * A dictionary for an explicitly named locale, usable in a client component.
 *
 * `./index` cannot be imported here because it pulls in `next/headers`, and
 * `./client` requires the provider that wraps the workspace. The signing screens
 * have neither: they render outside the app shell, and their language comes from
 * the document being signed rather than from the visitor's cookie — a patient
 * whose browser is in English still signs the Arabic form they were sent.
 */
export type Locale = "ar" | "en";
export type { Dict };

export function dictFor(locale: Locale): Dict {
  return locale === "en" ? en : ar;
}

export function dirFor(locale: Locale): "rtl" | "ltr" {
  return locale === "en" ? "ltr" : "rtl";
}
