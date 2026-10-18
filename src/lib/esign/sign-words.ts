import { dictFor, type Dict, type Locale } from "@/lib/i18n/client-dict";

/**
 * Every word the signing screens say, in the document's language.
 *
 * The signing screens speak the document's language, not the visitor's, so
 * they cannot read the page's dictionary. They used to import both whole
 * dictionaries instead, which put 100 KB (gzipped) of JavaScript on a patient's
 * phone to show about sixty strings. The page now resolves these on the server
 * and hands them down through `SignWordsProvider`.
 *
 * The type is the subset, so a signing component that reaches for a word
 * outside it fails to compile rather than rendering `undefined`.
 */
export type SignWords = {
  sign: Dict["sign"];
  common: Pick<Dict["common"], "cancel" | "close" | "genericError">;
  docs: Pick<Dict["docs"], "errors" | "notYourTurn">;
};

export function signWordsFor(locale: Locale): SignWords {
  const t = dictFor(locale);
  return {
    sign: t.sign,
    common: { cancel: t.common.cancel, close: t.common.close, genericError: t.common.genericError },
    docs: { errors: t.docs.errors, notYourTurn: t.docs.notYourTurn },
  };
}
