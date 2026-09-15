import type { Page } from "playwright";

/**
 * Shared layout measurement for the phone and tablet suites.
 *
 * Both used to carry their own route list, and both drifted: the phone list
 * still named `/reports` and `/settings/templates`, neither of which has
 * existed for months, so two of its assertions were measuring a 404 page — and
 * a 404 page never overflows, so they passed. Meanwhile Expenses, Earnings and
 * the Payments tab were in neither list, which is how a header 516px wide
 * inside a 358px column reached a customer's phone with the suite green.
 *
 * One list, used by both. Adding a section to the app and forgetting to test it
 * is now a single edit rather than two.
 */

export type PageIds = {
  slug: string;
  patientId?: string | null;
  invoiceId?: string | null;
  documentId?: string | null;
  automationId?: string | null;
  bookingSlug?: string | null;
};

/** Every screen a member can open, named for what a failure should say. */
export function workspacePages(ids: PageIds): [string, string][] {
  const s = `/c/${ids.slug}`;
  const pages: [string, string][] = [
    ["dashboard", s],
    ["patients list", `${s}/patients`],
    ["calendar", `${s}/calendar`],
    ["waitlist", `${s}/waitlist`],
    ["conversations", `${s}/conversations`],
    // The finance section, all four tabs. Absent from both suites until the
    // expenses header shipped broken.
    ["finance · invoices", `${s}/invoices`],
    ["finance · payments", `${s}/invoices?tab=payments`],
    ["finance · earnings", `${s}/earnings`],
    ["finance · expenses", `${s}/expenses`],
    ["documents", `${s}/documents`],
    ["automations", `${s}/automations`],
    ["campaigns", `${s}/campaigns`],
    ["ai agent", `${s}/ai`],
    ["notifications", `${s}/notifications`],
    ["profile", `${s}/profile`],
    ["signature", `${s}/signature`],
    ["patient import", `${s}/patients/import`],
    ["settings · clinic", `${s}/settings`],
    ["settings · staff", `${s}/settings/staff`],
    ["settings · services", `${s}/settings/services`],
    ["settings · hours", `${s}/settings/hours`],
    ["settings · whatsapp", `${s}/settings/whatsapp`],
    ["settings · tags", `${s}/settings/tags`],
    ["settings · booking", `${s}/settings/booking`],
    ["settings · fields", `${s}/settings/fields`],
    ["settings · documents", `${s}/settings/documents`],
    ["settings · insurers", `${s}/settings/insurers`],
    ["settings · invoicing", `${s}/settings/invoicing`],
  ];
  if (ids.patientId) pages.push(["patient file", `${s}/patients/${ids.patientId}`]);
  if (ids.invoiceId) pages.push(["invoice detail", `${s}/invoices/${ids.invoiceId}`]);
  if (ids.documentId) {
    // Named for what it is testing, so a failure says which content broke it.
    pages.push(["document detail (oversized image + wide table)", `${s}/documents/${ids.documentId}`]);
  }
  if (ids.automationId) pages.push(["automation builder", `${s}/automations/${ids.automationId}`]);
  return pages;
}

export type Spill = {
  tag: string;
  cls: string;
  over: number;
  width: number;
  parentWidth: number;
  text: string;
};

/**
 * Anything sitting outside the box that contains it.
 *
 * Distinct from the document-scrolls-sideways check, and it catches what that
 * one cannot: when an ancestor clips or truncates, an element can overflow it
 * by two hundred pixels while the page width stays exactly right. That is how
 * the payments list hid a patient's name — the column was squeezed to zero and
 * the note beside it ran off into a box with `overflow: hidden`, so nothing
 * scrolled and nothing was readable either.
 *
 * Containers that scroll on purpose are skipped: a wide table inside its own
 * `overflow-x: auto` wrapper is the fix, not the bug.
 */
export async function spills(page: Page, root = "main"): Promise<Spill[]> {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel);
    if (!host) return [];
    const out: Spill[] = [];
    for (const el of Array.from(host.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const p = el.parentElement;
      if (!p) continue;
      const pcs = getComputedStyle(p);
      if (pcs.overflowX === "auto" || pcs.overflowX === "scroll") continue;
      const pr = p.getBoundingClientRect();
      // Two pixels of slack: sub-pixel layout and focus rings are not defects.
      const over = Math.round(Math.max(r.right - pr.right, pr.left - r.left));
      if (over > 2) {
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 70),
          over,
          width: Math.round(r.width),
          parentWidth: Math.round(pr.width),
          text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
        });
      }
    }
    return out;
  }, root);
}

/** One line per offender, for a failure message somebody can act on. */
export function describeSpills(list: Spill[], limit = 3): string {
  return list
    .slice(0, limit)
    .map((s) => `+${s.over}px <${s.tag} class="${s.cls}"> ${s.width}>${s.parentWidth} "${s.text}"`)
    .join(" | ");
}
