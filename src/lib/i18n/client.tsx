"use client";

import { createContext, useContext } from "react";
import type { Dict } from "./en";
import { ar } from "./ar";

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
 * The provider's value, or Arabic defaults when there is none.
 *
 * For components shared between the workspace and the public signing screens.
 * The signing screens pass their locale in explicitly — it belongs to the
 * document, not to the visitor — so they must not be forced to mount a provider
 * just to satisfy a hook they are overriding anyway.
 */
export function useI18nSafe(): I18nValue {
  const v = useContext(I18nContext);
  return v ?? { t: ar as Dict, locale: "ar", dir: "rtl" };
}
