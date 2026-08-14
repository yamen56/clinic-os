import { cookies } from "next/headers";
import { cache } from "react";
import { en, type Dict } from "./en";
import { ar } from "./ar";

import { applyVocabulary } from "./vocab";
export type Locale = "ar" | "en";
export type { Dict };

import { LOCALE_COOKIE } from "./shared";
export { LOCALE_COOKIE };

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

/**
 * The dictionary for a workspace, which is not always the dictionary for the
 * visitor.
 *
 * Locale still comes from the person — their cookie, their choice. Vocabulary
 * comes from the clinic they are standing in, because "patient" or "clinic" is a
 * property of whose data this is, not of who is reading it. A Clinicti staffer
 * browsing a customer's workspace should see that customer's words.
 */
export async function dictForClinic(vocabulary: "medical" | "agency"): Promise<Dict> {
  const locale = await getLocale();
  return applyVocabulary(dictFor(locale), vocabulary, locale);
}
