/**
 * Text sized in px does not follow the workspace's density.
 *
 * On a tablet or a desktop the staff screens run a touch smaller (the root is
 * 93.75%, `data-density="compact"`), and everything sized in rem follows it.
 * A `text-[13px]` does not: it stays at 13px while the boxes around it shrink,
 * and the screen comes out lopsided — which is why every one of them was
 * converted to rem on 2026-11-21. This keeps new ones out.
 *
 * Allowed: 10px and 10.5px (count badges inside a fixed-size circle), and the
 * floor form `text-[length:max(11px,…rem)]`, which keeps the smallest text
 * readable in Arabic when the root drops.
 *
 * Needs no server and no database.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/app/c", "src/app/admin", "src/components"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

const offenders: string[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        if (parseFloat(m[1]) >= 11) offenders.push(`${file}:${i + 1}  ${m[0]}`);
      }
    });
  }
}

if (offenders.length) {
  console.log(`✗ ${offenders.length} text size(s) in px — use rem (13px = text-[0.8125rem]):`);
  for (const o of offenders.slice(0, 40)) console.log(`  ${o}`);
  process.exit(1);
}
console.log("✓ no px text sizes in the workspace");
