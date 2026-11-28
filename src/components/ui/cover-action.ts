/*
  Actions on a navy cover — the patient file's and the front page's welcome
  (2026-11-28). On a phone a tile, icon over name, a thumb tall, the name
  allowed two lines; from a tablet up a pill in a row. The lead is solid white
  on the navy, the rest translucent: one style, one thing to press first.

  Their ink is set here, never inherited: a menu or a child that took the
  cover's white on a white surface is how a list of words disappeared.
*/
const COVER_ACTION =
  "flex min-h-[3.75rem] touch-manipulation flex-col items-center justify-center gap-1 rounded-xl px-1.5 py-2 text-center text-[0.75rem] font-semibold leading-tight transition-colors disabled:opacity-60 sm:min-h-10 sm:flex-row sm:gap-2 sm:rounded-full sm:px-4 sm:py-2 sm:text-[0.8125rem]";

export const COVER_LEAD = `${COVER_ACTION} bg-white text-night hover:bg-white/90`;
export const COVER_QUIET = `${COVER_ACTION} bg-white/[0.09] text-white ring-1 ring-inset ring-white/10 hover:bg-white/[0.16]`;

/** The icon inside a cover action: a little larger on a phone, where it sits above its name. */
export const COVER_ICON = "h-[18px] w-[18px] shrink-0 sm:h-4 sm:w-4";

export function coverAction(lead: boolean): string {
  return lead ? COVER_LEAD : COVER_QUIET;
}
