import { toAsciiDigits } from "../phone";

/**
 * Reading a patient's reply the way a person would.
 *
 * "نعم", "نَعَم" and "نعم ✅" are the same yes, and "١" is the same 1 as "1".
 * Folds the text the way `ar_normalize` in migration 0009 does — tashkeel and
 * tatweel gone, the alef, taa marbuta, alef maqsura and hamza seats collapsed
 * — plus the Arabic-Indic digits, which that function leaves alone.
 */
export function normalizeForMatch(s: string): string {
  return toAsciiDigits(s)
    .replace(/[ـً-ْٰ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىئ]/g, "ي")
    .replace(/ؤ/g, "و")
    .toLowerCase()
    .trim();
}

function words(s: string): string {
  return ` ${normalizeForMatch(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/**
 * Whether the reply contains the keyword as a whole word or phrase.
 *
 * Whole words, because "1" must not match "10:30" and "لا" must not match
 * "لازم". A keyword with no letters or digits at all — 👍 — is looked for as it
 * is.
 */
export function replyMatches(reply: string, keyword: string): boolean {
  const k = keyword.trim();
  if (!k) return false;
  if (!/[\p{L}\p{N}]/u.test(k)) return reply.includes(k);
  const w = words(k);
  return w.trim() !== "" && words(reply).includes(w);
}

export function replyMatchesAny(reply: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => replyMatches(reply, k));
}

/**
 * Which way out of a "wait for a reply" step a reply takes: the first answer
 * whose keywords it contains, else "other" — or simply "replied" when the step
 * listens for no answers in particular.
 */
export function replyHandle(reply: string, options: readonly { keywords: readonly string[] }[]): string {
  if (!options.length) return "replied";
  const i = options.findIndex((o) => replyMatchesAny(reply, o.keywords));
  return i >= 0 ? `opt:${i}` : "other";
}
