import type { CapabilityMap } from "./permissions";

/**
 * Which parts of the money section a member can open.
 *
 * Invoices, Earnings and Expenses were three nav items and are now three tabs
 * under one, which turns "can they see it" from three independent booleans into
 * one list that three different files have to agree on: the sidebar entry needs
 * the first tab a member can open so it has somewhere to point, the strip needs
 * the whole list so it can draw itself, and the active-state test needs every
 * URL in the section whether or not this member can reach it. Derived in three
 * places, they would drift — and the failure is quiet, a tab that never lights
 * or a link into a redirect.
 *
 * Pure, and importable from a client component: no database, no `next/headers`.
 */

export type FinanceTab = "invoices" | "payments" | "earnings" | "expenses";

export type FinanceViewer = {
  caps: CapabilityMap;
  /** This member has a share agreed, or money already earned under one. */
  hasEarnings: boolean;
  /** `hasFullControl(access)` — an owner, or somebody on `full` access. */
  fullControl: boolean;
};

/**
 * Every URL prefix the section owns.
 *
 * Deliberately not derived from what this member may see: the sidebar entry
 * must light while they are anywhere in the section, and a member whose first
 * tab is Earnings is still "in Finance" when they are on Expenses.
 */
export const FINANCE_PREFIXES = ["/invoices", "/earnings", "/expenses"] as const;

export function financeHref(slug: string, tab: FinanceTab): string {
  const base = `/c/${slug}`;
  // Payments is not its own route — it is the invoices screen's other list, and
  // it stays that way because both read the same three tables and the same
  // guard. Only the strip treats it as a tab.
  if (tab === "payments") return `${base}/invoices?tab=payments`;
  return `${base}/${tab}`;
}

/**
 * The tabs this member may open, in the order they are shown.
 *
 * Earnings has two doors, and they are not the same door. A doctor reaches it
 * because the clinic agreed a share with *them* — the capability alone is not
 * enough, or every doctor at a practice that splits with nobody gets an empty
 * screen about money. Whoever holds the clinic reaches it for the other half,
 * what the clinic kept and what each doctor is owed, which is not grantable.
 */
export function financeTabs(v: FinanceViewer): FinanceTab[] {
  const out: FinanceTab[] = [];
  if (v.caps.invoices) out.push("invoices", "payments");
  if ((v.caps.earnings && v.hasEarnings) || (v.caps["invoices.analytics"] && v.fullControl)) {
    out.push("earnings");
  }
  if (v.caps.expenses) out.push("expenses");
  return out;
}

/** Where the sidebar entry points, or null when the member has no money section at all. */
export function firstFinanceHref(slug: string, v: FinanceViewer): string | null {
  const [first] = financeTabs(v);
  return first ? financeHref(slug, first) : null;
}
