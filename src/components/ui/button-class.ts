/*
  The button's look, apart from the <button>.

  A module of its own, without "use client", so a server page can style a link
  with it: a function exported from a client module reaches the server as a
  reference that cannot be called.

  Navigation that looks like a button is a link styled with this — not a
  <Button> inside a <Link>. That nesting put a button inside an anchor, which
  the HTML spec forbids: two tab stops for one control, and a screen reader
  announcing "link, button" for every one of them.
*/

export type Variant = "primary" | "outline" | "ghost" | "danger" | "soft";
/**
 * `icon` and `iconMd` are the square sizes. They exist as a pair because an
 * icon button is almost always sitting next to a labelled one, and a row of
 * mixed heights is the thing that reads as unfinished: `icon` matches `sm`,
 * `iconMd` matches `md`. Pick the one whose neighbour it shares a row with.
 */
export type Size = "sm" | "md" | "lg" | "icon" | "iconMd";

/*
  Brand rules: press translates 1px down — never scales. Loading keeps the label
  and animates a slim bar along the bottom edge; the product has no spinners.
*/
const variants: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-700",
  outline: "border border-line bg-transparent text-ink-900 hover:bg-brand-100",
  ghost: "text-ink-700 hover:bg-sunken hover:text-ink-900",
  danger: "bg-danger text-white hover:bg-danger-hover",
  soft: "bg-brand-100 text-brand-700 hover:bg-brand-200",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3 text-[13px] gap-2 rounded-ctl",
  md: "h-10 px-4 text-sm gap-2 rounded-ctl",
  lg: "h-11 px-6 text-[15px] gap-2 rounded-ctl",
  icon: "h-9 w-9 rounded-ctl",
  iconMd: "h-10 w-10 rounded-ctl",
};

/*
  shrink-0 and whitespace-nowrap keep the button at its intended size in a
  crowded row: without them a long Arabic label wraps to two lines and a flex
  sibling can squeeze the box, so buttons in the same row end up different
  heights. The icon gets shrink-0 for the same reason.

  `touch-manipulation` removes the ~300ms the browser otherwise waits to see
  whether a tap is the start of a double-tap zoom. Without it every button on a
  phone feels a beat behind the finger.
*/
const base =
  "relative isolate inline-flex shrink-0 touch-manipulation items-center justify-center overflow-hidden whitespace-nowrap font-semibold transition-colors duration-140 ease-out select-none active:translate-y-px disabled:opacity-45 disabled:pointer-events-none [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0";

export function buttonClass({
  variant = "primary",
  size = "md",
  className = "",
}: { variant?: Variant; size?: Size; className?: string } = {}): string {
  return `${base} ${variants[variant]} ${sizes[size]} ${className}`;
}
