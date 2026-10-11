/**
 * What a dental treatment costs, and how it reads on an invoice.
 *
 * Prices are the clinic's Services: one price list for the invoice builder,
 * the booking page and the chart alike. A treatment's price is the service
 * linked to it — for the variant that sets its price when it has one (a
 * crown's material, a root canal's canals, a full arch's implants), else the
 * treatment's own. A variant with no price of its own costs what the
 * treatment does.
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

/** Charged each visit rather than once: what a new price starts as. */
export const PER_SESSION_BY_DEFAULT = new Set(["ortho_adjust"]);

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

export type PriceRow = { serviceId: string; chartKey: string; variant: string | null; price: number; unit: "item" | "session" };

/** Is a treatment charged once, or per visit? From the price its fee came from. */
export function unitOf(m: { serviceId: string | null }, prices: PriceRow[]): "item" | "session" {
  return prices.find((p) => p.serviceId === m.serviceId)?.unit ?? "item";
}

/** The price of a treatment from the clinic's list: its variant's, else its own. */
export function priceFrom(list: PriceRow[], treatmentKey: string, detail: Record<string, string>): PriceRow | null {
  const variant = variantOf(treatmentKey, detail);
  return (
    (variant ? list.find((p) => p.chartKey === treatmentKey && p.variant === variant) : undefined) ??
    list.find((p) => p.chartKey === treatmentKey && p.variant === null) ??
    null
  );
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
  const what = withVariant(name, variant);
  const where =
    teeth.length > 1
      ? words.teeth.replace("{list}", teeth.join(locale === "ar" ? "، " : ", "))
      : /^[1-8][1-8]$/.test(m.site)
        ? words.tooth.replace("{n}", m.site)
        : (words.sites[m.site] ?? m.site);
  return `${what} — ${where}`.slice(0, 200);
}
