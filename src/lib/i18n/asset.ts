import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlib } from "node:zlib";
import { dictFor, type Dict, type Locale } from "./client-dict";
import { applyVocabulary, type Vocabulary } from "./vocab";

/**
 * The dictionary as a file the browser keeps.
 *
 * It used to travel as a prop. Every page's HTML carried the whole dictionary
 * for the reader's language inside the RSC payload — 200 KB of the login page's
 * 227 — and so did every `router.refresh()`, which is what each realtime event
 * costs an open inbox. The words were sent again with every refresh, and every
 * component that reads them re-rendered, because a deserialised dictionary is a
 * new object each time.
 *
 * Now a page names a URL, `/i18n/<locale>-<vocabulary>.<hash>.js`, and the
 * script there sets the dictionary on `self.__COS_I18N`. The hash is of the
 * words themselves, so a deploy that changes no copy keeps the browser's file,
 * and one that does gets a new name instead of a stale cache.
 *
 * Server-only: `I18nProvider` reaches it through a `typeof window` branch that
 * Next removes from the browser build, so neither dictionary is in any bundle.
 */

const VOCABULARIES: Vocabulary[] = ["medical", "agency"];
const LOCALES: Locale[] = ["ar", "en"];

const resolved = new Map<string, Dict>();

/**
 * The words a workspace with this vocabulary speaks. One object per pair, so
 * React sees the same dictionary on every render rather than an equal copy.
 */
export function resolveDict(locale: Locale, vocabulary: Vocabulary): Dict {
  const key = `${locale}-${vocabulary}`;
  let d = resolved.get(key);
  if (!d) {
    d = applyVocabulary(dictFor(locale), vocabulary, locale);
    resolved.set(key, d);
  }
  return d;
}

type Asset = { json: string; hash: string };
const assets = new Map<string, Asset>();

function asset(locale: Locale, vocabulary: Vocabulary): Asset {
  const key = `${locale}-${vocabulary}`;
  let a = assets.get(key);
  if (!a) {
    const json = JSON.stringify(resolveDict(locale, vocabulary));
    a = { json, hash: createHash("sha256").update(json).digest("base64url").slice(0, 12) };
    assets.set(key, a);
  }
  return a;
}

/** Where each language's file is, for a provider of this vocabulary. */
export function dictSources(vocabulary: Vocabulary): Record<Locale, string> {
  return {
    ar: `/i18n/ar-${vocabulary}.${asset("ar", vocabulary).hash}.js`,
    en: `/i18n/en-${vocabulary}.${asset("en", vocabulary).hash}.js`,
  };
}

export type Encoding = "br" | "gzip";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const bodies = new Map<string, string>();
const encoded = new Map<string, Promise<Buffer>>();

/**
 * The script for a requested file name, or null for a name that is not one.
 *
 * A hash that is not the current one still gets the current words — a tab left
 * open across a deploy asks for the old name — but marked uncacheable, so the
 * old URL never comes to hold new content in somebody's cache for a year.
 *
 * Compressed here because nothing else does it: `next start` compresses pages
 * and its own chunks but not a route handler's response, and the file went out
 * at 212 KB when it is 47 once compressed. Once per file and kept, off the
 * event loop: brotli's best setting takes a quarter of a second on this file,
 * which every other request would otherwise wait out after each deploy.
 */
export function dictScript(
  file: string
): { body: string; fresh: boolean; encode: (e: Encoding) => Promise<Buffer> } | null {
  const m = /^(ar|en)-([a-z]+)\.([A-Za-z0-9_-]{1,32})\.js$/.exec(file);
  if (!m) return null;
  const locale = m[1] as Locale;
  const vocabulary = m[2] as Vocabulary;
  if (!LOCALES.includes(locale) || !VOCABULARIES.includes(vocabulary)) return null;
  const a = asset(locale, vocabulary);
  const fresh = a.hash === m[3];
  /*
    Keyed by the path the page asked for, which is the key the provider looks
    up. JSON.parse over a string literal, because V8 parses JSON several times
    faster than the same data written as an object literal.
  */
  let body = fresh ? bodies.get(file) : undefined;
  if (!body) {
    const key = JSON.stringify(`/i18n/${file}`);
    body = `(self.__COS_I18N=self.__COS_I18N||{})[${key}]=JSON.parse(${JSON.stringify(a.json)});`;
    if (fresh) bodies.set(file, body);
  }
  const text = body;
  const encode = (e: Encoding): Promise<Buffer> => {
    const cacheKey = `${file}:${e}`;
    const hit = fresh ? encoded.get(cacheKey) : undefined;
    if (hit) return hit;
    const out =
      e === "br"
        ? brotliAsync(text, { params: { [zlib.BROTLI_PARAM_QUALITY]: fresh ? 11 : 5 } })
        : gzipAsync(text, { level: 9 });
    // Only the current files are kept; an old name is answered and forgotten.
    if (fresh) {
      encoded.set(cacheKey, out);
      out.catch(() => encoded.delete(cacheKey));
    }
    return out;
  };
  return { body: text, fresh, encode };
}
