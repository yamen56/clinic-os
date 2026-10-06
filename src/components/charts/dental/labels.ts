import type { Dict } from "@/lib/i18n/en";
import { findTreatment, type Treatment } from "@/lib/charts/dental/catalog";
import { isToothSite, type Mark } from "@/lib/charts/dental/state";
import { surfaceCode, tooth } from "@/lib/charts/dental/teeth";

/** "Tooth 16", "Upper arch", "Whole mouth". */
export function siteLabel(site: string, T: Dict["dental"]): string {
  if (isToothSite(site)) return T.tooth.replace("{n}", site);
  return (T.sites as Record<string, string>)[site] ?? site;
}

/** The entry's name as it was recorded, with its surfaces: "Composite filling MO". */
export function markLabel(m: Mark, locale: string): string {
  const name = locale === "ar" ? m.labelAr : m.label;
  if (m.surfaces.length === 0 || !isToothSite(m.site)) return name;
  return `${name} · ${surfaceCode(tooth(m.site), m.surfaces)}`;
}

/** "Zirconia", "3 canals": the chosen details, named in the reader's language. */
export function detailLabels(m: Mark, custom: Treatment[], locale: string): string[] {
  const tr = findTreatment(m.treatmentKey, custom);
  if (!tr?.details) return [];
  return tr.details
    .map((d) => d.options.find((o) => o.key === m.detail[d.key]))
    .filter((o): o is NonNullable<typeof o> => !!o)
    .map((o) => (locale === "ar" ? o.ar : o.en));
}
