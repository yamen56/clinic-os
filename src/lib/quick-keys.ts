/**
 * The four things a front desk does all day, one key away — the keys
 * themselves, in a module both sides can read: the shell listens for them
 * (app/c/[slug]/quick-actions), and the front page's shortcuts print the
 * letter beside each, on a desk (2026-11-28).
 *
 * `code` is the physical key, not the character: on an Arabic keyboard the A
 * key reports "ش", and every shortcut in an Arabic-first product would be dead.
 */
export type QuickAction = "appointment" | "patient" | "invoice" | "inbox";

export const QUICK_KEYS: Record<QuickAction, { code: string; hint: string }> = {
  appointment: { code: "KeyA", hint: "A" },
  patient: { code: "KeyP", hint: "P" },
  invoice: { code: "KeyI", hint: "I" },
  inbox: { code: "KeyM", hint: "M" },
};

/** Where each one goes. */
export function quickHref(slug: string, a: QuickAction): string {
  return {
    appointment: `/c/${slug}/calendar?new=1`,
    patient: `/c/${slug}/patients?new=1`,
    invoice: `/c/${slug}/invoices/new`,
    inbox: `/c/${slug}/conversations`,
  }[a];
}
