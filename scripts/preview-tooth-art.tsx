/**
 * The tooth drawings, on one page, without the app: both arches as they stand,
 * then every treatment and finding on a molar and an incisor — planned and
 * done, from the side and from above. For working on the art: change
 * tooth-art.tsx, run this, look at the picture.
 *
 *   npx tsx scripts/preview-tooth-art.tsx   → scripts/qa-shots/tooth-art/*.png
 */
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./lib-react-global";
import { createElement as h, Fragment } from "react";
import { tooth, PERMANENT_UPPER, PERMANENT_LOWER, type Surface } from "../src/lib/charts/dental/teeth";
import type { Layer, Paint, ToothState } from "../src/lib/charts/dental/state";
import type { Look } from "../src/lib/charts/dental/catalog";
import { CW, OCC, SIDE_H, DentalDefs, ToothSide, ToothTop } from "../src/components/charts/dental/tooth-art";

const OUT = join(process.cwd(), "scripts", "qa-shots", "tooth-art");
mkdirSync(OUT, { recursive: true });

// The theme's colour tokens, as the app defines them.
const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
const tokens = [...css.matchAll(/^\s*(--color-[a-z0-9-]+):\s*([^;]+);/gm)]
  .filter((m) => /tooth|gum|dental|mat-|night|ink-/.test(m[1]))
  .map((m) => `${m[1]}: ${m[2]};`);
const vars = [...new Map(tokens.map((t) => [t.split(":")[0], t])).values()].join("\n");

const EMPTY: ToothState = { gone: false, buried: null, layers: [], badges: [] };
const layer = (look: Look, paint: Paint, surfaces: Surface[] = [], detail: Record<string, string> = {}): Layer => ({ markId: `${look}-${paint}`, look, paint, surfaces, detail });

/** One tooth, side over top, in a column 44 wide. */
function cell(fdi: string, st: ToothState, label: string, uid: string) {
  const t = tooth(fdi);
  const scale = 1.6;
  return h(
    "figure",
    { key: uid, style: { margin: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, width: CW * scale + 8 } },
    h("svg", { viewBox: `0 0 ${CW} ${SIDE_H}`, width: CW * scale, height: SIDE_H * scale, style: { overflow: "visible" } }, h(ToothSide, { t, st, uid })),
    h("svg", { viewBox: `0 0 ${OCC} ${OCC}`, width: OCC * scale, height: OCC * scale }, h(ToothTop, { t, st, uid })),
    h("figcaption", { style: { font: "11px system-ui", color: "#555", textAlign: "center", maxWidth: CW * scale + 8 } }, label)
  );
}

function arch(fdis: string[], prefix: string) {
  return h(
    "div",
    { style: { display: "flex", gap: 0 } },
    fdis.map((f) => {
      const t = tooth(f);
      const scale = 1.6;
      return h(
        "svg",
        { key: f, viewBox: `0 0 ${CW} ${SIDE_H}`, width: CW * scale, height: SIDE_H * scale, style: { overflow: "visible" } },
        h(ToothSide, { t, st: EMPTY, uid: `${prefix}${f}` })
      );
    })
  );
}

type Case = { look: Look; fdi: string; surfaces?: Surface[]; detail?: Record<string, string>; treatmentKey?: string; state?: Partial<ToothState> };
const CASES: Case[] = [
  { look: "caries", fdi: "36", surfaces: ["O", "M"] },
  { look: "filling", fdi: "36", surfaces: ["O", "D"], treatmentKey: "filling_composite" },
  { look: "filling", fdi: "46", surfaces: ["O", "M"], treatmentKey: "filling_amalgam" },
  { look: "inlay", fdi: "36", surfaces: ["O"], detail: { material: "ceramic" } },
  { look: "sealant", fdi: "36" },
  { look: "crown", fdi: "36", detail: { material: "zirconia" } },
  { look: "crown", fdi: "46", detail: { material: "pfm" } },
  { look: "crown", fdi: "26", detail: { material: "metal" } },
  { look: "crown", fdi: "11", detail: { material: "emax" } },
  { look: "veneer", fdi: "11", detail: { material: "porcelain" } },
  { look: "rct", fdi: "36", detail: { canals: "3" } },
  { look: "rct", fdi: "11", detail: { canals: "1" } },
  { look: "post", fdi: "11" },
  { look: "core", fdi: "36" },
  { look: "pulp", fdi: "36" },
  { look: "implant", fdi: "36", state: { gone: true } },
  { look: "extraction", fdi: "36" },
  { look: "apico", fdi: "11" },
  { look: "fracture", fdi: "11" },
  { look: "wear", fdi: "11" },
  { look: "stain", fdi: "11" },
  { look: "lesion", fdi: "36" },
  { look: "furcation", fdi: "36" },
  { look: "recession", fdi: "11" },
  { look: "gum", fdi: "36" },
  { look: "rotation", fdi: "11" },
  { look: "graft", fdi: "36" },
  { look: "bracket", fdi: "11" },
  { look: "band", fdi: "36" },
  { look: "denture", fdi: "36", state: { gone: true } },
  { look: "root", fdi: "36" },
  { look: "mobility", fdi: "11", detail: { grade: "2" } },
];

function gallery(paints: Paint[]) {
  return h(
    "div",
    { style: { display: "flex", flexWrap: "wrap", gap: 14 } },
    CASES.flatMap((c, i) =>
      paints.map((p) => {
        const finding = ["caries", "fracture", "wear", "stain", "lesion", "furcation", "recession", "rotation", "root", "mobility"].includes(c.look);
        const paint: Paint = finding ? "finding" : p;
        const st: ToothState = { ...EMPTY, ...c.state, layers: [{ ...layer(c.look, paint, c.surfaces ?? [], c.detail ?? {}), treatmentKey: c.treatmentKey }] };
        const what = `${c.look}${c.detail?.material ? ` ${c.detail.material}` : c.treatmentKey ? ` ${c.treatmentKey.replace("filling_", "")}` : ""}`;
        return cell(c.fdi, st, finding ? what : `${what} · ${paint}`, `g${i}${paint}`);
      })
    )
  );
}

const body = renderToStaticMarkup(
  h(
    Fragment,
    null,
    h(DentalDefs),
    h("h2", null, "Upper arch"),
    arch(PERMANENT_UPPER, "u"),
    h("h2", null, "Lower arch"),
    arch(PERMANENT_LOWER, "l"),
    h("h2", null, "Treatments and findings"),
    gallery(["planned", "done"])
  )
);
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { ${vars} }
body { font: 13px system-ui; background: #fff; padding: 16px; margin: 0; }
h2 { font-size: 14px; margin: 14px 0 6px; }
.tooth-pop { }
</style></head><body>${body}</body></html>`;
const file = join(OUT, "preview.html");
writeFileSync(file, html);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1.5 });
  await page.goto(`file://${file.replace(/\\/g, "/")}`);
  await page.screenshot({ path: join(OUT, "arches.png"), clip: { x: 0, y: 0, width: 1500, height: 560 } });
  await page.screenshot({ path: join(OUT, "all.png"), fullPage: true });
  // Close up: a few teeth of each arch, the way a phone shows them.
  const close = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 3 });
  await close.goto(`file://${file.replace(/\\/g, "/")}`);
  await close.screenshot({ path: join(OUT, "close-upper.png"), clip: { x: 0, y: 40, width: 600, height: 200 } });
  await close.screenshot({ path: join(OUT, "close-lower.png"), clip: { x: 0, y: 262, width: 600, height: 200 } });
  await browser.close();
  console.log(`written ${join(OUT, "all.png")}`);
})();
