/**
 * Colour utilities that name a token nobody defined.
 *
 * Tailwind emits nothing for `text-ink-800` when `--color-ink-800` does not
 * exist. There is no error and no warning — the element simply inherits its
 * parent's colour, so the bug is invisible everywhere the inherited value
 * happens to look reasonable, and catastrophic in the one place it does not.
 * It shipped exactly once that way: white text on a white button, on the login
 * page, because the surface behind it is dark.
 *
 * Needs no server and no database. Reads globals.css for the truth and greps
 * the tree for claims against it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CSS = "src/app/globals.css";
const ROOT = "src";
// The families whose value comes from a `--color-*` custom property.
const PREFIXES = ["text", "bg", "border", "decoration", "ring", "fill", "stroke", "from", "to", "via"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e) && !p.endsWith("globals.css")) out.push(p);
  }
  return out;
}

const css = readFileSync(CSS, "utf8");
const defined = new Set(
  [...css.matchAll(/--color-([a-z]+-[0-9]+)\s*:/g)].map((m) => m[1])
);
// Scales that exist as a ramp; a utility naming a step outside one is the bug.
const families = new Set([...defined].map((d) => d.split("-")[0]));

const bad: { file: string; token: string; line: number }[] = [];
for (const f of walk(ROOT)) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(
      new RegExp(`(?:${PREFIXES.join("|")})-([a-z]+-[0-9]+)`, "g")
    )) {
      const token = m[1];
      const family = token.split("-")[0];
      if (!families.has(family)) continue; // not a ramp we own
      if (!defined.has(token)) bad.push({ file: f, token: m[0], line: i + 1 });
    }
  });
}

console.log(`ramps: ${[...families].sort().join(", ")}`);
console.log(`defined steps: ${defined.size}`);
if (bad.length) {
  console.log(`\n${bad.length} utilities name a step that does not exist:`);
  for (const b of bad) console.log(`  ${b.file}:${b.line}  ${b.token}`);
  console.log("\nTailwind emits nothing for these. The element inherits instead.");
  process.exit(1);
}
console.log("\nok — every colour utility resolves to a defined token");
