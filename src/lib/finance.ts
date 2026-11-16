import type { CapabilityMap } from "./permissions";

/**
 * Which parts of the money section a member can open.
 *
 * Invoices, Earnings and Expenses were three nav items and are now tabs under
 * one — with Analytics and Claims beside them, and invoices and payments
 * sharing a tab — which turns "can they see it" from independent booleans into
 * one list that three different files have to agree on: the sidebar entry needs
 * the first tab a member can open so it has somewhere to point, the strip needs
 * the whole list so it can draw itself, and the active-state test needs every
 * URL in the section whether or not this member can reach it. Derived in three
 * places, they would drift — and the failure is quiet, a tab that never lights
 * or a link into a redirect.
 *
 * Pure, and importable from a client component: no database, no `next/headers`.
 */

export type FinanceTab = "invoices" | "analytics" | "claims" | "earnings" | "expenses";

export type FinanceViewer = {
  caps: CapabilityMap;
  /** This member has a share agreed, or money already earned under one. */
  hasEarnings: boolean;
  /** `hasFullControl(access)` — an owner, or somebody on `full` access. */
  fullControl: boolean;
  /**
   * The clinic deals with at least one insurance company. Claims is a tab only
   * then: a practice that takes cash should not be shown an empty screen about
   * insurers, any more than its patient files ask about cover.
   */
  hasInsurers?: boolean;
  /**
   * `ownInvoicesOnly(access)` — a doctor whose list is filtered to their own
   * work. They get no clinic-wide figures whatever they were ticked, so no
   * Analytics tab either.
   */
  ownInvoicesOnly?: boolean;
};

/**
 * Every URL prefix the section owns.
 *
 * Deliberately not derived from what this member may see: the sidebar entry
 * must light while they are anywhere in the section, and a member whose first
 * tab is Earnings is still "in Finance" when they are on Expenses.
 */
export const FINANCE_PREFIXES = ["/invoices", "/analytics", "/claims", "/earnings", "/expenses"] as const;

export function financeHref(slug: string, tab: FinanceTab): string {
  /*
    Payments is not here. It was a tab of the strip until 2026-11-15, when
    Yamen asked for invoices and payments in one tab: it is the invoices
    screen's other list, at `/invoices?tab=payments` as it always was, and the
    switch between the two now lives on that screen.
  */
  return `/c/${slug}/${tab}`;
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
  if (v.caps.invoices) out.push("invoices");
  /*
    The clinic's figures in depth. Second rather than last, so it is on screen
    on a phone, where the strip scrolls. The same two conditions the page
    checks for itself: the capability, and a list that is not filtered to one
    doctor's own work.
  */
  if (v.caps["invoices.analytics"] && !v.ownInvoicesOnly) out.push("analytics");
  // Claims answer to Insurance, not Invoices: an insurance clerk works them
  // without raising invoices, and a desk that takes cash need never see them.
  if (v.caps.insurance && v.hasInsurers) out.push("claims");
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
