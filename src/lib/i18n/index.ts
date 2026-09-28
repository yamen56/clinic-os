import { cookies } from "next/headers";
import { cache } from "react";
import { applyVocabulary } from "./vocab";
import { dictFor, type Dict, type Locale } from "./client-dict";

// One definition, in the module the signing screens can import without
// `next/headers`; the server side re-exports it rather than keeping a copy.
export { dictFor, dirFor, type Dict, type Locale } from "./client-dict";

import { LOCALE_COOKIE } from "./shared";
export { LOCALE_COOKIE };

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
