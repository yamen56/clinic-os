/*
  Two radiographs for the preview's sample mouth — a panoramic (OPG) from the
  first visit and a periapical of 35–37 from the third — drawn from the same
  tooth shapes as the chart and marked SAMPLE in the corner, so the image
  viewer has something real-looking to open on a file that has no x-rays yet.

  Grey on black the way film reads: enamel and metal brightest, dentine and
  bone grey, pulp, caries and a periapical lesion dark. Nothing here is a
  patient's image; real ones come from the file's own uploads.
*/

import { tooth as toothOf, PERMANENT_UPPER, PERMANENT_LOWER } from "@/lib/charts/dental/teeth";
import { crownPath, rootGeom, shapeOf } from "./tooth-art";

const H = 104; // tooth-local height, as in tooth-art

function toothSvg(fdi: string, o: { x: number; y: number; s: number; tilt?: number; crown?: "metal" | "amalgam"; caries?: boolean; lesion?: boolean }): string {
  const t = toothOf(fdi);
  const sh = shapeOf(t);
  const crown = crownPath(sh);
  const roots = rootGeom(sh);
  const flip = t.arch === "lower" ? `matrix(1 0 0 -1 0 ${H})` : "";
  const tilt = o.tilt ? `rotate(${o.tilt} 22 62)` : "";
  const parts = [
    roots.back ? `<path d="${roots.back}" fill="#8d8d8d" opacity="0.6"/>` : "",
    `<path d="${roots.body}" fill="#a9a9a9"/>`,
    ...roots.canals.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#3a3a3a" stroke-width="1.6" stroke-linecap="round"/>`),
    `<path d="${crown}" fill="${o.crown === "metal" ? "#ffffff" : "#dcdcdc"}"/>`,
    o.crown === "metal" ? "" : `<path d="${crown}" fill="none" stroke="#f2f2f2" stroke-width="2.4" opacity="0.8"/>`,
    o.crown === "amalgam" ? `<rect x="10" y="88" width="24" height="10" rx="3" fill="#ffffff"/>` : "",
    o.caries ? `<circle cx="30" cy="94" r="4.2" fill="#262626"/><circle cx="18" cy="96" r="3" fill="#2c2c2c"/>` : "",
    o.lesion ? roots.apices.map(([x, y]) => `<circle cx="${x}" cy="${y + 1}" r="6.5" fill="#2b2b2b" opacity="0.85"/>`).join("") : "",
  ];
  return `<g transform="translate(${o.x} ${o.y}) scale(${o.s})"><g transform="${flip} ${tilt}">${parts.join("")}</g></g>`;
}

const GRAIN = `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 0.18"/></feComponentTransfer></filter>`;

function label(w: number, h: number): string {
  return `<g font-family="Inter, Arial, sans-serif" font-weight="700"><rect x="${w - 92}" y="${h - 30}" width="80" height="20" rx="4" fill="#ffffff" opacity="0.14"/><text x="${w - 52}" y="${h - 16}" font-size="11" fill="#ffffff" opacity="0.85" text-anchor="middle" letter-spacing="2">SAMPLE</text></g>`;
}

const url = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The panoramic from the first visit: 18, 48 and 14 already gone, 38 impacted, 17 crowned, 25 filled, 16 decayed. */
export function sampleOpg(): string {
  const W = 960;
  const HH = 440;
  const gone = new Set(["18", "48", "14"]);
  const teeth: string[] = [];
  const row = (list: string[], baseY: number, curve: number) =>
    list.forEach((fdi, i) => {
      if (gone.has(fdi)) return;
      const k = (i - 7.5) / 7.5; // -1 .. 1 across the arch
      const y = baseY + curve * k * k;
      teeth.push(
        toothSvg(fdi, {
          x: 64 + i * 52,
          y,
          s: 1.08,
          tilt: fdi === "38" ? -22 : 0,
          crown: fdi === "17" ? "metal" : fdi === "25" ? "amalgam" : undefined,
          caries: fdi === "16",
        })
      );
    });
  row(PERMANENT_UPPER, 54, -26);
  row(PERMANENT_LOWER, 228, 30);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${HH}" width="${W}" height="${HH}">
<defs>${GRAIN}<radialGradient id="v" cx="0.5" cy="0.5" r="0.7"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/></radialGradient>
<linearGradient id="bone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a4a4a"/><stop offset="0.5" stop-color="#2a2a2a"/><stop offset="1" stop-color="#555"/></linearGradient></defs>
<rect width="${W}" height="${HH}" fill="#0b0b0b"/>
<path d="M40 40 Q480 -10 920 40 L920 190 Q480 160 40 190 Z" fill="url(#bone)" opacity="0.9"/>
<path d="M40 250 Q480 230 920 250 L900 400 Q480 470 60 400 Z" fill="url(#bone)" opacity="0.9"/>
${teeth.join("\n")}
<rect width="${W}" height="${HH}" filter="url(#grain)"/>
<rect width="${W}" height="${HH}" fill="url(#v)"/>
${label(W, HH)}
</svg>`;
  return url(svg);
}

/** The periapical of 35–37 from the third visit: caries and a periapical lesion on 36. */
export function samplePa(): string {
  const W = 330;
  const HH = 420;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${HH}" width="${W}" height="${HH}">
<defs>${GRAIN}<radialGradient id="v" cx="0.5" cy="0.45" r="0.75"><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.8"/></radialGradient>
<linearGradient id="bone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2e2e2e"/><stop offset="1" stop-color="#5a5a5a"/></linearGradient></defs>
<rect width="${W}" height="${HH}" rx="18" fill="#0d0d0d"/>
<rect x="0" y="150" width="${W}" height="${HH - 150}" fill="url(#bone)"/>
${toothSvg("35", { x: -18, y: 40, s: 2.5 })}
${toothSvg("36", { x: 92, y: 40, s: 2.5, caries: true, lesion: true })}
${toothSvg("37", { x: 214, y: 40, s: 2.5 })}
<rect width="${W}" height="${HH}" rx="18" filter="url(#grain)"/>
<rect width="${W}" height="${HH}" rx="18" fill="url(#v)"/>
<circle cx="24" cy="24" r="5" fill="#fff" opacity="0.7"/>
${label(W, HH)}
</svg>`;
  return url(svg);
}
