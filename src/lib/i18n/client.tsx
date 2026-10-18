"use client";

import { createContext, use, useCallback, useContext, useMemo } from "react";
import type { Dict } from "./en";
import type { Vocabulary } from "./vocab";

type Locale = "ar" | "en";
type Sources = Record<Locale, string>;

type I18nValue = { t: Dict; locale: Locale; dir: "rtl" | "ltr" };
type Context = I18nValue & { vocabulary: Vocabulary; src: Sources | null };

const I18nContext = createContext<Context | null>(null);

declare global {
  interface Window {
    __COS_I18N?: Record<string, Dict>;
  }
}

/** One request per file, however many providers and renders ask for it. */
const loading = new Map<string, Promise<Dict>>();

function load(url: string): Promise<Dict> {
  let p = loading.get(url);
  if (!p) {
    p = new Promise<Dict>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => {
        const d = window.__COS_I18N?.[url];
        if (d) resolve(d);
        else reject(new Error(`i18n: ${url} did not define its dictionary`));
      };
      s.onerror = () => {
        // Forgotten, so the next render that needs it tries again.
        loading.delete(url);
        reject(new Error(`i18n: could not load ${url}`));
      };
      document.head.appendChild(s);
    });
    loading.set(url, p);
  }
  return p;
}

/**
 * The words for the components below, which never travel in the page.
 *
 * On the server they come from memory. In the browser they come from the file
 * `src` names, which the root layout loads in `<head>` ahead of the page, so on
 * a normal load it is already there when React hydrates. When it is not — the
 * language was just switched, or sign-in set the account's own — the provider
 * suspends until the file arrives. Inside a navigation or a refresh that keeps
 * the previous screen up, so the text changes once, in the right language.
 * See lib/i18n/asset for why the dictionary moved out of the RSC payload.
 *
 * `dict` replaces the words outright, for a client component that wants the
 * same words under another locale (the dental chart runs in English).
 * `vocabulary` and `src` are inherited from the provider above when omitted.
 */
export function I18nProvider({
  locale,
  vocabulary,
  src,
  dict,
  children,
}: {
  locale: Locale;
  vocabulary?: Vocabulary;
  src?: Sources;
  dict?: Dict;
  children: React.ReactNode;
}) {
  const parent = useContext(I18nContext);
  const voc = vocabulary ?? parent?.vocabulary ?? "medical";
  const arSrc = src?.ar ?? parent?.src?.ar;
  const enSrc = src?.en ?? parent?.src?.en;

  let t: Dict;
  if (dict) {
    t = dict;
  } else if (typeof window === "undefined") {
    /*
      Next replaces `typeof window` at build time, so the browser bundle drops
      this branch and the require with it: the dictionaries are read here on
      the server and never shipped as JavaScript.
    */
    const { resolveDict } = require("./asset") as typeof import("./asset");
    t = resolveDict(locale, voc);
  } else {
    const url = locale === "en" ? enSrc : arSrc;
    if (!url) throw new Error("I18nProvider: no dictionary source");
    t = window.__COS_I18N?.[url] ?? use(load(url));
  }

  /*
    The value is built one component down, and that is load-bearing. A
    component that suspends in `use()` while it is mounting is replayed when
    the file arrives, and a hook after the `use()` then trips React's "update
    hook called on initial render" (#467) — which is what the agency workspace
    did on its first load, the one provider that has to fetch while mounting.
    Nothing here keeps hook state, so there is nothing for the replay to trip on.
  */
  return (
    <ProvideValue t={t} locale={locale} vocabulary={voc} arSrc={arSrc} enSrc={enSrc}>
      {children}
    </ProvideValue>
  );
}

function ProvideValue({
  t,
  locale,
  vocabulary: voc,
  arSrc,
  enSrc,
  children,
}: {
  t: Dict;
  locale: Locale;
  vocabulary: Vocabulary;
  arSrc: string | undefined;
  enSrc: string | undefined;
  children: React.ReactNode;
}) {
  // Stable while nothing changes, so a refresh does not re-render every component that reads a word.
  const value = useMemo<Context>(
    () => ({
      t,
      locale,
      dir: locale === "en" ? "ltr" : "rtl",
      vocabulary: voc,
      src: arSrc && enSrc ? { ar: arSrc, en: enSrc } : null,
    }),
    [t, locale, voc, arSrc, enSrc]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}

/** The provider's value, or null when there is none. For components shared with the signing screens. */
export function useI18nSafe(): I18nValue | null {
  return useContext(I18nContext);
}

/**
 * Starts fetching another language's words. The language toggle calls it
 * before refreshing, so the file and the re-rendered page arrive together
 * rather than one after the other.
 */
export function usePreloadLocale(): (locale: Locale) => void {
  const v = useContext(I18nContext);
  return useCallback(
    (locale: Locale) => {
      const url = v?.src?.[locale];
      if (url && !window.__COS_I18N?.[url]) load(url).catch(() => {});
    },
    [v]
  );
}
