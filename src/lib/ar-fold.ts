/**
 * `ar_normalize` (migration 0009) for the browser: the same text folded the
 * same way, so a list filtered on the screen agrees with a search the
 * database runs. Strips tatweel and the short-vowel marks, and collapses the
 * letter forms people type interchangeably (أ إ آ ٱ → ا, ة → ه, ى → ي,
 * ؤ → و, ئ → ي).
 */
const MARKS = /[ـً-ْٰ]/g;
const FROM = "أإآٱةىؤئ";
const TO = "ااااهيوي";

export function arFold(text: string | null | undefined): string {
  let s = String(text ?? "").replace(MARKS, "");
  let out = "";
  for (const ch of s) {
    const i = FROM.indexOf(ch);
    out += i >= 0 ? TO[i] : ch;
  }
  s = out.toLowerCase();
  return s;
}
