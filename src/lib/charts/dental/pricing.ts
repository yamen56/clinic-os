/**
 * What a dental treatment costs, and how it reads on an invoice.
 *
 * Prices are the clinic's Services: one price list for the invoice builder,
 * the booking page and the chart alike. A treatment's price is the service
 * linked to it — for the variant that sets its price when it has one (a
 * crown's material, a root canal's canals, a full arch's implants), else the
 * treatment's own. A variant with no price of its own costs what the
 * treatment does.
 *
 * One price for the whole treatment, however many visits it takes (Yamen,
 * 2026-10-17: "delete the pay per visit — the patient can pay on multiple
 * visits from the whole treatment price"). The patient pays it in parts on
 * the one invoice; the per-visit prices of 0076 were retired by 0080.
 */

import { BUILT_IN_BY_KEY } from "./catalog";

/** The detail that sets a treatment's price: its variant. */
export const PRICE_BY: Record<string, "material" | "canals" | "type" | "implants"> = {
  crown: "material",
  bridge: "material",
  veneer: "material",
  hollywood_smile: "material",
  implant_crown: "material",
  inlay: "material",
  onlay: "material",
  rct: "canals",
  rct_retreat: "canals",
  whitening: "type",
  implant_denture: "implants",
};

/** The variant a treatment is priced by, as recorded on the entry, or null when it has none. */
export function variantOf(treatmentKey: string, detail: Record<string, string>): string | null {
  const key = PRICE_BY[treatmentKey];
  return key ? (detail[key] ?? null) : null;
}

/** The variant's own name — "Zirconia", "3 canals" — in the reader's language. */
export function variantName(treatmentKey: string, variant: string | null, locale: string): string | null {
  if (!variant) return null;
  const field = BUILT_IN_BY_KEY.get(treatmentKey)?.details?.find((d) => d.key === PRICE_BY[treatmentKey]);
  const o = field?.options.find((x) => x.key === variant);
  return o ? (locale === "ar" ? o.ar : o.en) : null;
}

/**
 * A treatment's name with its variant: "Crown (Zirconia)". A name with
 * brackets of its own takes a dot instead — "تاج (تلبيسة) · زركون", not
 * "تاج (تلبيسة) (زركون)".
 */
export function withVariant(name: string, variant: string | null): string {
  if (!variant) return name;
  return /[()]/.test(name) ? `${name} · ${variant}` : `${name} (${variant})`;
}

/**
 * A price on the list: the service that is the price, its names — what the
 * patient reads on the invoice — and what its materials cost the clinic,
 * each (0081; null when not set, which costs nothing).
 */
export type PriceRow = { serviceId: string; chartKey: string; variant: string | null; price: number; materialCost?: number | null; name: string; nameAr: string | null };

/**
 * What a treatment's materials cost: set for this patient, else its price's
 * service's on the list — the same rule the server freezes at billing
 * (line-costs.ts). Each; a bridge's is this times its teeth.
 */
export function materialCostOf(m: { materialCost?: number | null; serviceId: string | null }, list: PriceRow[]): number | null {
  if (m.materialCost != null) return m.materialCost;
  return list.find((p) => p.serviceId === m.serviceId)?.materialCost ?? null;
}

/**
 * The price for a treatment, from the clinic's list: its variant's price,
 * else the treatment's own. The server prices with this too, so what is
 * drawn at once is what is stored.
 */
export function pickPrice(list: PriceRow[], treatmentKey: string, variant: string | null): PriceRow | null {
  return (
    (variant ? list.find((p) => p.chartKey === treatmentKey && p.variant === variant) : undefined) ??
    list.find((p) => p.chartKey === treatmentKey && p.variant === null) ??
    null
  );
}

/** The price of a treatment as charted, from the clinic's list. */
export function priceFrom(list: PriceRow[], treatmentKey: string, detail: Record<string, string>): PriceRow | null {
  return pickPrice(list, treatmentKey, variantOf(treatmentKey, detail));
}

/** Where on the mouth, in the words an invoice uses. */
export type LineWords = { tooth: string; teeth: string; sites: Record<string, string> };

/**
 * An invoice line for chart work, in the clinic's own language: "تاج (زركون) —
 * سن 36", "Crown (Zirconia) — tooth 36", "Bridge (E-max) — teeth 14, 15, 16".
 * The patient reads it, so it is not the chart's English.
 */
export function lineDescription(
  m: { label: string; labelAr: string; treatmentKey: string; detail: Record<string, string>; site: string },
  locale: string,
  words: LineWords,
  teeth: string[] = []
): string {
  const name = locale === "ar" ? m.labelAr || m.label : m.label;
  const variant = variantName(m.treatmentKey, variantOf(m.treatmentKey, m.detail), locale);
  return `${withVariant(name, variant)} — ${whereText(m.site, teeth, locale, words)}`.slice(0, 200);
}

/** Where in the mouth, in an invoice's words: "tooth 36", "teeth 14, 15, 16", "upper arch". */
export function whereText(site: string, teeth: string[], locale: string, words: LineWords): string {
  return teeth.length > 1
    ? words.teeth.replace("{list}", teeth.join(locale === "ar" ? "، " : ", "))
    : /^[1-8][1-8]$/.test(site)
      ? words.tooth.replace("{n}", site)
      : (words.sites[site] ?? site);
}

/**
 * The invoice line for chart work, as the patient reads it: the price list's
 * name for it — the service it bills, so a clinic that renames "تاج (تلبيسة) ·
 * زركون" to "تلبيسة زركون" sees the patient's invoice say so — then where in
 * the mouth. A price for the treatment as a whole gets the variant after it,
 * "Crown (E-max)"; work with no price on the list keeps the chart's own words.
 */
export function invoiceLineText(
  m: { label: string; labelAr: string; treatmentKey: string; detail: Record<string, string>; site: string },
  row: Pick<PriceRow, "name" | "nameAr" | "variant"> | null | undefined,
  locale: string,
  words: LineWords,
  teeth: string[] = []
): string {
  if (!row) return lineDescription(m, locale, words, teeth);
  const name = locale === "ar" ? row.nameAr || row.name : row.name;
  const variant = row.variant ? null : variantName(m.treatmentKey, variantOf(m.treatmentKey, m.detail), locale);
  return `${withVariant(name, variant)} — ${whereText(m.site, teeth, locale, words)}`.slice(0, 200);
}
