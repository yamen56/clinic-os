"use client";

import { createContext, useContext } from "react";
import type { Dict } from "./en";

type Locale = "ar" | "en";

type I18nValue = { t: Dict; locale: Locale; dir: "rtl" | "ltr" };

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  dict,
  locale,
  children,
}: {
  dict: Dict;
  locale: Locale;
  children: React.ReactNode;
}) {
  return (
    <I18nContext.Provider value={{ t: dict, locale, dir: locale === "en" ? "ltr" : "rtl" }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}

/**
 * The provider's value, or null when there is none.
 *
 * For components shared between the workspace and the public signing screens.
 * The signing screens pass their locale in explicitly — it belongs to the
 * document, not to the visitor — so they must not be forced to mount a provider
 * just to satisfy a hook they are overriding anyway.
 *
 * **Null rather than an Arabic default, and the reason is weight.** Returning a
 * ready-made fallback meant importing `ar` here, and this module is what the
 * workspace layout mounts — so every signed-in page carried the whole Arabic
 * dictionary in its JavaScript bundle (28 KB gzipped, measured) to serve a
 * default that only one component on the signing screens could ever reach, and
 * that reached it only when rendered outside a provider.
 *
 * The caller decides instead. There is exactly one, `signature-pad`, and it
 * already imports `dictFor` for the locale it is handed — so the dictionary is
 * loaded by the screens that need it and by nothing else.
 */
export function useI18nSafe(): I18nValue | null {
  return useContext(I18nContext);
}
