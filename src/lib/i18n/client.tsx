"use client";

import { createContext, useContext } from "react";
import type { Dict } from "./en";
import type { Locale } from "./index";

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
