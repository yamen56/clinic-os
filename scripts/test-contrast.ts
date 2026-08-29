/**
 * Text that can be read on a colour the clinic chose.
 *
 * Service and doctor colours are free-form hex, so the calendar has to decide
 * the ink for a background it has never seen. The bug this guards against was
 * arithmetic rather than taste: the blue channel skipped linearisation, which
 * inflated luminance by up to 255x, so every colour with any blue in it
 * measured brighter than white and was given near-black text. Pure black was
 * the only dark colour that came out readable.
 */
import { inkOn, luminance } from "../src/lib/contrast";

const INK = "#000000";
const WHITE = "#ffffff";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* Luminance has to behave like luminance before anything built on it can. */
console.log("\n[the measurement itself]");
check("black is 0", luminance("#000000") === 0, "");
check("white is 1", Math.abs(luminance("#ffffff") - 1) < 1e-9, "");
check(
  "nothing exceeds white",
  ["#0000ff", "#00ff00", "#ff0000", "#2563eb", "#7c3aed"].every((c) => luminance(c) <= 1),
  ""
);
check(
  "pure blue is the darkest primary",
  luminance("#0000ff") < luminance("#ff0000") && luminance("#ff0000") < luminance("#00ff00"),
  `${luminance("#0000ff").toFixed(3)} < ${luminance("#ff0000").toFixed(3)} < ${luminance("#00ff00").toFixed(3)}`
);

/* The colours a clinic actually picks. */
console.log("\n[dark backgrounds get light text]");
for (const c of ["#0b1220", "#16181c", "#1e3a8a", "#0000ff", "#065f46", "#7c3aed", "#2563eb", "#991b1b"]) {
  check(`${c} → white`, inkOn(c) === WHITE, inkOn(c));
}

console.log("\n[light backgrounds get dark text]");
for (const c of ["#ffffff", "#e5e7eb", "#fde68a", "#bbf7d0", "#fecaca", "#a5f3fc"]) {
  check(`${c} → ink`, inkOn(c) === INK, inkOn(c));
}

/*
  The real requirement is not which of the two it picks but that the result can
  be read. 4.5:1 is the WCAG AA floor for body text; these labels are small.
*/
console.log("\n[every choice is actually legible]");
const palette = [
  "#0b1220", "#16181c", "#1e3a8a", "#0000ff", "#065f46", "#7c3aed", "#2563eb",
  "#991b1b", "#ffffff", "#e5e7eb", "#fde68a", "#bbf7d0", "#fecaca", "#a5f3fc",
  "#6b7280", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6",
];
const weak = palette.filter((c) => ratio(c, inkOn(c)) < 4.5);
check(
  "no colour in the palette falls below AA",
  weak.length === 0,
  weak.length ? weak.map((c) => `${c}=${ratio(c, inkOn(c)).toFixed(2)}`).join(", ") : "20 colours"
);

/* Whatever it picks must be the better of the two, at every luminance. */
console.log("\n[it always picks the better ink]");
let wrong: string[] = [];
for (let r = 0; r < 256; r += 15)
  for (let g = 0; g < 256; g += 15)
    for (let b = 0; b < 256; b += 15) {
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      const chosen = inkOn(hex);
      const other = chosen === WHITE ? INK : WHITE;
      if (ratio(hex, chosen) < ratio(hex, other)) wrong.push(hex);
    }
check("across the whole cube", wrong.length === 0, wrong.length ? `${wrong.length} wrong, e.g. ${wrong[0]}` : "5832 colours");

/* Junk in, something readable out — never a crash and never invisible text. */
console.log("\n[garbage input]");
for (const bad of [null, undefined, "", "red", "var(--x)", "#fff"]) {
  check(`${JSON.stringify(bad)} → a colour`, /^#[0-9a-f]{6}$/i.test(inkOn(bad as string)), inkOn(bad as string));
}

console.log(`\n${failures.length ? "✗" : "✓"} ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`   - ${f}`);
process.exit(failures.length ? 1 : 0);
