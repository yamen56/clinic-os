"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";

/*
  A strip that scrolls sideways says so (2026-11-27).

  On a phone the patient file's tabs ran past the screen's edge and the last
  one read "l chart" — cut, with nothing to say the strip moves or that more
  tabs wait past it. The same happened to the Finance tabs, the automation
  tabs and the doctor chips on Appointments. Now the edge with more behind it
  fades out, so the cut reads as "keep going", and the fade leaves the side
  that has nothing more. Physical sides, worked out from the scroll position,
  so it is right in Arabic and English alike.

  `selected` (a CSS selector) also brings the chosen item into view whenever
  `key` changes — a tab opened from a link is otherwise selected out of sight.
  It moves the strip only, never the page.

  A callback ref, not a ref object: the strip is often rendered only once its
  data has come (the doctor chips wait for the day), and an effect that ran
  at mount would have missed it.
*/
const FADE = "1.75rem";

function maskFor(left: boolean, right: boolean): string | undefined {
  if (left && right) return `linear-gradient(to right, transparent, #000 ${FADE}, #000 calc(100% - ${FADE}), transparent)`;
  if (left) return `linear-gradient(to right, transparent, #000 ${FADE})`;
  if (right) return `linear-gradient(to left, transparent, #000 ${FADE})`;
  return undefined;
}

export function useEdgeFade<T extends HTMLElement>(opts: { selected?: string; key?: unknown } = {}) {
  const [el, setEl] = useState<T | null>(null);
  const ref = useCallback((node: T | null) => setEl(node), []);
  const [mask, setMask] = useState<string | undefined>();

  useEffect(() => {
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 1) return setMask(undefined);
      // 0…max in a left-to-right strip, 0…−max in a right-to-left one.
      const s = Math.abs(el.scrollLeft);
      const fromStart = s > 1;
      const toEnd = s < max - 1;
      const rtl = getComputedStyle(el).direction === "rtl";
      setMask(maskFor(rtl ? toEnd : fromStart, rtl ? fromStart : toEnd));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [el]);

  const { selected, key } = opts;
  useEffect(() => {
    if (!el || !selected) return;
    const a = el.querySelector(selected);
    if (!a) return;
    const r = a.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    // A little past the edge, so the chosen item is clear of the fade.
    if (r.left < c.left) el.scrollLeft -= c.left - r.left + 28;
    else if (r.right > c.right) el.scrollLeft += r.right - c.right + 28;
  }, [el, selected, key]);

  const style: CSSProperties | undefined = mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined;
  return { ref, style };
}
