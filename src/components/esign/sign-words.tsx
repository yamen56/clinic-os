"use client";

import { createContext, useContext } from "react";
import { useI18nSafe } from "@/lib/i18n/client";
import type { SignWords } from "@/lib/esign/sign-words";

const SignWordsContext = createContext<SignWords | null>(null);

/** Set by the signing pages, in the document's language. See lib/esign/sign-words. */
export function SignWordsProvider({ words, children }: { words: SignWords; children: React.ReactNode }) {
  return <SignWordsContext.Provider value={words}>{children}</SignWordsContext.Provider>;
}

/**
 * The signing screens' words. Inside the workspace (the signature pad on a
 * document, or the staff member's own signature) there is no signing provider,
 * and the workspace dictionary, which holds every one of these, answers.
 */
export function useSignWords(): SignWords {
  const own = useContext(SignWordsContext);
  const app = useI18nSafe();
  const words = own ?? app?.t;
  if (!words) throw new Error("useSignWords outside a SignWordsProvider or I18nProvider");
  return words;
}
