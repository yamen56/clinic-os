/**
 * Every treatment and finding in the catalog, drawn on a tooth it fits —
 * planned and done, from the side and from above — and a map of the five
 * surfaces in all four quadrants. For checking the chart draws each of them,
 * and puts each surface where it belongs, without opening the app.
 *
 *   npx tsx scripts/preview-treatments.tsx
 *     → scripts/qa-shots/tooth-art/treatments.png, surfaces.png
 */
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./lib-react-global";
import { createElement as h, Fragment } from "react";
import { tooth, surfaceAt, surfaceCode, type Surface } from "../src/lib/charts/dental/teeth";
import type { Layer, Paint, ToothState } from "../src/lib/charts/dental/state";
import { BUILT_IN, type Treatment } from "../src/lib/charts/dental/catalog";
import { CW, OCC, SIDE_H, DentalDefs, ToothSide, ToothTop } from "../src/components/charts/dental/tooth-art";

const OUT = join(process.cwd(), "scripts", "qa-shots", "tooth-art");
mkdirSync(OUT, { recursive: true });
const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
const vars = [...new Map([...css.matchAll(/^\s*(--color-[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], `${m[1]}: ${m[2]};`])).values()].join("\n");

const EMPTY: ToothState = { gone: false, buried: null, layers: [], badges: [] };
const FRONT = new Set(["veneer", "bracket", "rotation", "stain", "wear", "inflamed", "overgrowth"]);

/** A tooth the treatment fits, the way the picker chooses one. */
function toothFor(tr: Treatment): string {
  const f = tr.fits;
  if (f?.kinds?.length === 1 && f.kinds[0] === "incisor") return f.arch === "lower" ? "41" : "11";
  if (f?.kinds?.includes("molar")) return f.arch === "upper" ? "26" : "36";
  if (f?.primary) return f.kinds?.includes("molar") ? "75" : "51";
  if (f?.arch === "upper") return "16";
  return FRONT.has(tr.look) ? "11" : "36";
}

function cell(fdi: string, st: ToothState, label: string, uid: string) {
  const t = tooth(fdi);
  const k = 1.5;
  return h(
    "figure",
    { key: uid, style: { margin: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: CW * k + 18 } },
    h("svg", { viewBox: `0 0 ${CW} ${SIDE_H}`, width: CW * k, height: SIDE_H * k, style: { overflow: "visible" } }, h(ToothSide, { t, st, uid })),
    h("svg", { viewBox: `-4 -4 ${OCC + 8} ${OCC + 8}`, width: OCC * k * 0.8, height: OCC * k * 0.8 }, h(ToothTop, { t, st, uid: `${uid}t` })),
    h("figcaption", { style: { font: "10.5px system-ui", textAlign: "center", color: "#334", lineHeight: 1.25 } }, label)
  );
}

function layerOf(tr: Treatment, t: ReturnType<typeof tooth>, paint: Paint): Layer {
  const surfaces: Surface[] = tr.needsSurfaces || tr.scope === "surface" ? ["O", t.side === "right" ? "M" : "D"] : [];
  const detail: Record<string, string> = {};
  for (const d of tr.details ?? []) detail[d.key] = d.options[0]?.key ?? "";
  return { markId: `${tr.key}-${paint}`, treatmentKey: tr.key, look: tr.look, paint, surfaces, detail };
}

const shown = BUILT_IN.filter((tr) => tr.look !== "dot");
const cells = shown.flatMap((tr) => {
  const fdi = toothFor(tr);
  const t = tooth(fdi);
  const paints: Paint[] = tr.kind === "finding" ? ["finding"] : ["planned", "done"];
  return paints.map((paint) => {
    const layer = layerOf(tr, t, paint);
    const gone = (tr.look === "implant" || tr.look === "denture" || layer.role === "pontic") && paint !== "planned";
    const st: ToothState =
      tr.look === "missing"
        ? { ...EMPTY, gone: true }
        : tr.look === "impacted" || tr.look === "unerupted"
          ? { ...EMPTY, buried: { look: tr.look, paint } }
          : tr.look === "extraction" && paint === "done"
            ? { ...EMPTY, gone: true }
            : { ...EMPTY, gone, layers: [layer] };
    return cell(fdi, st, `${tr.en}${paint === "finding" ? "" : ` · ${paint}`} (${fdi})`, `c-${tr.key}-${paint}`);
  });
});

// The surface map: one filling per surface, in each quadrant, labelled with its code.
const SURF: Surface[] = ["M", "D", "B", "L", "O"];
const surfaceCells = ["16", "26", "36", "46", "11", "21", "31", "41"].flatMap((fdi) => {
  const t = tooth(fdi);
  return SURF.map((sf) => {
    const st: ToothState = { ...EMPTY, layers: [{ markId: `s-${fdi}-${sf}`, treatmentKey: "filling_amalgam", look: "filling", paint: "done", surfaces: [sf], detail: {} }] };
    const where = (["top", "bottom", "left", "right", "center"] as const).find((r) => surfaceAt(t, r) === sf);
    return cell(fdi, st, `${fdi} ${surfaceCode(t, [sf])} (${where})`, `s-${fdi}-${sf}`);
  });
});

const page = (title: string, body: ReturnType<typeof h>[]) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>:root{${vars}} body{margin:0;padding:14px;background:#fff;font:13px system-ui} h2{font-size:14px;margin:6px 0 10px}</style></head><body>${renderToStaticMarkup(
    h(Fragment, null, h(DentalDefs), h("h2", null, title), h("div", { style: { display: "flex", flexWrap: "wrap", gap: 10 } }, ...body))
  ).replace(/href="\/charts\//g, `href="file:///${join(process.cwd(), "public").replace(/\\/g, "/")}/charts/`)}</body></html>`;

(async () => {
  const browser = await chromium.launch();
  for (const [name, title, body] of [
    ["treatments", `Every treatment and finding (${shown.length})`, cells],
    ["surfaces", "One amalgam filling per surface, in every quadrant — M must face the midline, B the outside of the arch", surfaceCells],
  ] as const) {
    const file = join(OUT, `${name}.html`);
    writeFileSync(file, page(title, body as ReturnType<typeof h>[]));
    const p = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1.5 });
    await p.goto(`file://${file.replace(/\\/g, "/")}`);
    await p.waitForLoadState("load");
    await p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
    await p.close();
  }
  await browser.close();
  console.log("written treatments.png, surfaces.png");
})();
