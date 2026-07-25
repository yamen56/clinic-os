import { cookies } from "next/headers";
import { cache } from "react";
import { en, type Dict } from "./en";
import { ar } from "./ar";

export type Locale = "ar" | "en";
export type { Dict };

export const LOCALE_COOKIE = "cos_locale";

export function dictFor(locale: Locale): Dict {
  return locale === "en" ? en : ar;
}

export function dirFor(locale: Locale): "rtl" | "ltr" {
  return locale === "en" ? "ltr" : "rtl";
}

/** Resolves the request locale: cookie wins, Arabic is the default. */
export const getLocale = cache(async (): Promise<Locale> => {
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  return v === "en" ? "en" : "ar";
});

export const getDict = cache(async (): Promise<Dict> => dictFor(await getLocale()));
