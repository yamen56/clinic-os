/**
 * The whole chart with bridges, full arches and dentures on it, without the
 * app: planned, under way and done, in both jaws, in light and in dark. For
 * working on the drawing: change prosthesis-art.tsx, run this, look.
 *
 *   npx tsx scripts/preview-prosthesis.tsx   → scripts/qa-shots/tooth-art/prosthesis-*.png
 */
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./lib-react-global";
import { createElement as h, Fragment } from "react";
import { BUILT_IN_BY_KEY } from "../src/lib/charts/dental/catalog";
import { toothStates, type Mark, type Status } from "../src/lib/charts/dental/state";
import { cutsDetail, prostheses, stagesOf } from "../src/lib/charts/dental/prosthesis";
import { defaultPlaces, placeDetail, sitesFor, type Place } from "../src/lib/charts/dental/implant-place";
import { prosthesisSites } from "../src/lib/charts/dental/full-arch";
import type { StepRecord } from "../src/lib/charts/dental/protocols";
import { DentalDefs, PaintSwatch } from "../src/components/charts/dental/tooth-art";
import { ArchGlyph, BridgeGlyph } from "../src/components/charts/dental/prosthesis-art";
import { Odontogram } from "../src/components/charts/dental/odontogram";
import type { Arch } from "../src/lib/charts/dental/teeth";

const OUT = join(process.cwd(), "scripts", "qa-shots", "tooth-art");
mkdirSync(OUT, { recursive: true });

let n = 0;
const T0 = Date.parse("2026-11-01T08:00:00Z");
function mark(site: string, key: string, status: Status, extra: Partial<Mark> = {}): Mark {
  const tr = BUILT_IN_BY_KEY.get(key)!;
  const at = new Date(T0 + n++ * 1000).toISOString();
  return {
    id: `m${n}`,
    site,
    surfaces: [],
    treatmentKey: key,
    label: tr.en,
    labelAr: tr.ar,
    look: tr.look,
    kind: tr.kind,
    detail: {},
    status,
    performedBy: null,
    recordedBy: { id: "u", name: "QA" },
    createdAt: at,
    doneAt: status === "done" ? at : null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    note: "",
    emergency: false,
    startedAt: null,
    appointmentId: null,
    fee: null,
    feeManual: false,
    serviceId: null,
    redoOf: null,
    ...extra,
  };
}
const step = (markId: string, key: string): StepRecord => ({
  id: `s${n++}`,
  markId,
  step: key,
  data: {},
  note: "",
  performedBy: null,
  recordedBy: { id: "u", name: "QA" },
  appointmentId: null,
  doneAt: new Date(T0 + n * 1000).toISOString(),
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
});

function arch(a: Arch, places: Place[], st: { arch: Status; implants: Status; bridge: Status }, detail: Record<string, string> = {}, key = "implant_denture", started = false): Mark[] {
  const g = `g${n}`;
  const sites = sitesFor(a, places);
  const count = places.length;
  return [
    mark(a, key, st.arch, { groupId: g, detail: { implants: String(count), ...detail }, startedAt: started ? new Date(T0).toISOString() : null }),
    ...places.map((p, i) => mark(sites[i], "implant", st.implants, { groupId: g, role: "abutment", detail: placeDetail(p) })),
    ...prosthesisSites(key, a, count).map((f) => mark(f, key, st.bridge, { groupId: g, role: "pontic" })),
  ];
}
function bridge(teeth: [string, "abutment" | "pontic"][], status: Status, detail: Record<string, string> = {}, key = "bridge", started = false): Mark[] {
  const g = `g${n}`;
  return teeth.map(([f, role]) => mark(f, key, status, { groupId: g, role, detail, startedAt: started ? new Date(T0).toISOString() : null }));
}
const missing = (...f: string[]) => f.map((x) => mark(x, "missing", "existing"));

type Scene = { name: string; marks: Mark[]; steps?: StepRecord[] };
const done = { arch: "done", implants: "done", bridge: "done" } as const;
const planned = { arch: "planned", implants: "planned", bridge: "planned" } as const;

const prepBridge = bridge([["45", "abutment"], ["46", "pontic"], ["47", "abutment"]], "planned", { material: "zirconia" }, "bridge", true);
const tempBridge = bridge([["34", "abutment"], ["35", "pontic"], ["36", "abutment"]], "planned", { material: "zirconia" }, "bridge", true);
const tempArch = arch("lower", defaultPlaces("lower", 4), { arch: "planned", implants: "done", bridge: "planned" }, { kind: "fixed", material: "zirconia" }, "implant_denture", true);

const odd: Place[] = [
  { pos: 1.35, tilt: 38, depth: 0, len: 15, dia: 4.1 },
  { pos: 4.6, tilt: 12, depth: 0, len: 13, dia: 4.1 },
  { pos: 6.45, tilt: -6, depth: 1, len: 11.5, dia: 3.5 },
  { pos: 9.4, tilt: 0, depth: 0, len: 11.5, dia: 4.1 },
  { pos: 13.2, tilt: -42, depth: 0, len: 15, dia: 5 },
];

const SCENES: Scene[] = [
  { name: "All-on-4 done (upper, zirconia) · All-on-6 done (lower, acrylic on titanium)", marks: [...arch("upper", defaultPlaces("upper", 4), done, { kind: "fixed", material: "zirconia" }), ...arch("lower", defaultPlaces("lower", 6), done, { kind: "fixed", material: "acrylic" })] },
  { name: "Full arch planned (upper, free places) · implants placed, healing (lower)", marks: [...arch("upper", odd, planned, { kind: "fixed", material: "zirconia" }), ...missing("46", "45", "44", "43", "42", "41", "31", "32", "33", "34", "35", "36", "47", "37", "48", "38"), ...arch("lower", odd, { arch: "planned", implants: "done", bridge: "planned" }, { kind: "fixed" }, "implant_denture", true)] },
  { name: "Arch split into bridges and a crown (upper) · temporary bridge in place (lower)", marks: [...arch("upper", defaultPlaces("upper", 6), done, { kind: "fixed", material: "pfm", cuts: cutsDetail([4, 7, 10, 12]) }), ...tempArch], steps: [step(tempArch[0].id, "temporary")] },
  {
    name: "Bridges: zirconia 14–16 done, existing PFM 24–26, cantilever planned 11–13 · prepared 45–47, temporary 34–36",
    marks: [
      ...missing("15", "25", "12", "46", "35"),
      ...bridge([["14", "abutment"], ["15", "pontic"], ["16", "abutment"]], "done", { material: "zirconia" }),
      ...bridge([["24", "abutment"], ["25", "pontic"], ["26", "abutment"]], "existing", { material: "pfm" }),
      ...bridge([["13", "abutment"], ["12", "pontic"], ["11", "pontic"]], "planned", { material: "emax" }),
      ...prepBridge,
      ...tempBridge,
    ],
    steps: [step(prepBridge[0].id, "prep"), step(tempBridge[0].id, "prep"), step(tempBridge[0].id, "temp")],
  },
  {
    name: "Bridge on implants: done 14–16, planned 24–26 · implants healing 46, 44 · missing teeth only 35–37",
    marks: [
      ...missing("14", "15", "16", "24", "25", "26", "46", "44", "45", "35", "36", "37"),
      ...["14", "16", "24", "26", "46", "44"].map((f) => mark(f, "implant", "done", { detail: {} })),
      ...bridge([["14", "abutment"], ["15", "pontic"], ["16", "abutment"]], "done", { material: "zirconia" }, BUILT_IN_BY_KEY.has("implant_bridge") ? "implant_bridge" : "bridge"),
      ...bridge([["24", "abutment"], ["25", "pontic"], ["26", "abutment"]], "planned", { material: "zirconia" }, BUILT_IN_BY_KEY.has("implant_bridge") ? "implant_bridge" : "bridge"),
      mark("47", "crown", "done", { detail: { material: "zirconia" } }),
      mark("11", "crown", "done", { detail: { material: "emax" } }),
    ],
  },
  { name: "Complete denture (upper) · overdenture on two, partial denture (lower)", marks: [...arch("upper", [], { arch: "existing", implants: "existing", bridge: "existing" }, {}, "denture_complete"), ...missing("45", "46", "47"), ...["45", "46", "47"].map((f) => mark(f, "denture_partial", "done", { groupId: "gp" })), ...missing("33", "34", "35")] },
  { name: "Overdenture on two implants, planned (lower)", marks: [...missing("48", "47", "46", "45", "44", "43", "42", "41", "31", "32", "33", "34", "35", "36", "37", "38"), ...arch("lower", defaultPlaces("lower", 2), planned, { kind: "removable" })] },
];

const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
const grab = (block: string) => [...new Map([...block.matchAll(/^\s*(--color-[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], `${m[1]}: ${m[2]};`])).values()].join("\n");
const darkAt = css.indexOf(':root[data-theme="dark"] {');
const light = grab(css.slice(0, darkAt));
const dark = grab(css.slice(darkAt, css.indexOf("}", darkAt)));

function chart(s: Scene) {
  const stages = stagesOf(s.marks, s.steps ?? [], null);
  const states = toothStates(s.marks, null, undefined, stages);
  const work = prostheses(s.marks, null, stages);
  return h(
    "section",
    { key: s.name, "data-scene": "", style: { width: 1150, padding: 12, background: "var(--color-surface)" } },
    h("h2", null, s.name),
    h(Odontogram, {
      dentition: "permanent",
      states,
      work,
      visible: () => true,
      selected: [],
      half: null,
      locale: "en",
      brush: false,
      highlight: null,
      regions: [],
      addRegionLabel: null,
      imageCounts: {},
      imagesLabel: "",
      onTooth: () => {},
      onSurface: () => {},
      onImages: () => {},
      onRegion: () => {},
      onRegionHover: () => {},
      categoryOf: () => undefined,
    })
  );
}

const glyphs = h(
  "section",
  { style: { display: "flex", gap: 24, alignItems: "center", padding: 12 } },
  (["planned", "done"] as const).flatMap((p) => [
    h(BridgeGlyph, { key: `b${p}`, paint: p, size: 60 }),
    h(BridgeGlyph, { key: `i${p}`, paint: p, size: 60, implants: true }),
    h(ArchGlyph, { key: `a${p}`, paint: p, size: 90 }),
    h(PaintSwatch, { key: `s${p}`, paint: p }),
  ])
);

const body = renderToStaticMarkup(h(Fragment, null, h(DentalDefs), glyphs, ...SCENES.map(chart)));
const publicDir = `file:///${join(process.cwd(), "public").replace(/\\/g, "/")}`;
const page = (vars: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
:root { ${vars} }
body { font: 13px system-ui; background: var(--color-canvas, #fff); color: var(--color-ink-900, #111); padding: 16px; margin: 0; }
h2 { font-size: 13px; margin: 4px 0 8px; font-weight: 600; }
.fill-transparent { fill: transparent } .stroke-transparent { stroke: transparent } .fill-ink-500 { fill: var(--color-ink-500, #667) }
</style></head><body>${body.replace(/href="\/charts\//g, `href="${publicDir}/charts/`)}</body></html>`;

(async () => {
  const browser = await chromium.launch();
  for (const [name, vars] of [
    ["light", light],
    ["dark", `${light}\n${dark}`],
  ] as const) {
    const file = join(OUT, `prosthesis-${name}.html`);
    writeFileSync(file, page(vars));
    const p = await browser.newPage({ viewport: { width: 1220, height: 900 }, deviceScaleFactor: 2 });
    await p.goto(`file://${file.replace(/\\/g, "/")}`);
    const scenes = p.locator("[data-scene]");
    for (let i = 0; i < (await scenes.count()); i++) await scenes.nth(i).screenshot({ path: join(OUT, `prosthesis-${name}-${i + 1}.png`) });
    await p.screenshot({ path: join(OUT, `prosthesis-${name}-glyphs.png`), clip: { x: 0, y: 0, width: 900, height: 120 } });
    await p.close();
  }
  await browser.close();
  console.log(`written ${join(OUT, "prosthesis-*.png")}`);
})();
