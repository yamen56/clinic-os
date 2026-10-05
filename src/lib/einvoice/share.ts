import { round2 } from "../invoices";
import type { EinvoiceLine } from "./ubl";

/**
 * The patient's own tax document, when an insurer covers part of the bill.
 *
 * The invoice a clinic raises is for the full price — that is what the visit
 * cost, and what the claim is argued from. But the patient did not buy the
 * insurer's share. That half of the sale is invoiced to the insurer: by Hakeem
 * Claim, which issues the JoFotara invoice itself when a claim is submitted
 * through it, or by the clinic directly. Filing the full total against the
 * patient as well reported the insurer's share twice.
 *
 * So the document filed for the patient carries only what the patient owes,
 * spread over the same lines in proportion to each line's gross, to the fil:
 * every line keeps its service, quantity, tax category and rate, and the lines
 * add up to exactly `total - excluded`. Each line's original discount is folded
 * into its price — the patient's price for that line is their share of what it
 * cost after the discount. What is left in `discount` is the rounding needed
 * for `qty × price − discount` to land on the line's net, which ISTD checks.
 *
 * Tax is the line's share less its net, rather than net × rate rounded on its
 * own, so the document totals exactly what the patient pays; the two readings
 * differ by at most one fil, and only on a standard-rated line.
 *
 * Pure, and deterministic for the same input — which is what lets a credit note
 * mirror the filed document by running the same split over the same lines.
 *
 * Returns the lines unchanged when nothing is excluded, and none at all when
 * the insurer covers everything: there is no sale to the patient to report.
 */
export function patientShareLines(lines: EinvoiceLine[], excluded: number): EinvoiceLine[] {
  const cents = (n: number) => Math.round(n * 100);
  const gross = lines.map((l) => cents(l.amount) - cents(l.discount) + cents(l.tax));
  const whole = gross.reduce((s, g) => s + g, 0);
  const cut = Math.max(0, Math.min(cents(excluded), whole));
  if (cut === 0) return lines;
  const target = whole - cut;
  if (target <= 0) return [];

  // Largest remainder, so the shares are whole fils and sum to the target exactly.
  const exact = gross.map((g) => (g * target) / whole);
  const share = exact.map(Math.floor);
  let left = target - share.reduce((s, n) => s + n, 0);
  const byRemainder = exact
    .map((x, i) => ({ i, r: x - share[i] }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) share[byRemainder[k % byRemainder.length].i]++;

  return lines.map((l, i) => {
    const rate = l.taxCategory === "S" ? l.taxRate : 0;
    const net = rate > 0 ? Math.round(share[i] / (1 + rate / 100)) : share[i];
    const tax = share[i] - net;
    const qty = l.qty > 0 ? l.qty : 1;
    // The smallest price that reaches the net; the overshoot is the discount.
    const price = Math.ceil(net / qty);
    const amount = Math.round(qty * price);
    return {
      ...l,
      qty,
      unitPrice: price / 100,
      amount: amount / 100,
      discount: (amount - net) / 100,
      tax: tax / 100,
    };
  });
}

/** What an insured invoice leaves off the patient's document: never more than the invoice. */
export function insurerShareOf(total: number, insurerAmount: unknown): number {
  const n = Number(insurerAmount ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return round2(Math.min(n, total));
}
