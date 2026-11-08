"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * Makes a box exactly as tall as the screen has room for below where it starts.
 *
 * The inbox and the team chat are a list and a thread with the box to type in at
 * the bottom, so they have to fit the screen. Their height used to be the screen
 * less a fixed guess at what sits above, and anything more above (a clinic notice
 * from the agency, say) pushed the box to type in under a phone's tab bar, out of
 * reach. Measured instead: from the box's top to the bottom of the screen, less the
 * phone's tab bar when it shows, re-measured when anything above it changes size.
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>, opts: { min?: number; gap?: number } = {}) {
  const min = opts.min ?? 360;
  const gap = opts.gap ?? 16;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = el.getBoundingClientRect().top + window.scrollY;
        const bar = document.querySelector<HTMLElement>("[data-mobile-tabbar]");
        const barHeight = bar && bar.offsetParent !== null ? bar.offsetHeight : 0;
        const height = Math.max(min, Math.floor(window.innerHeight - top - barHeight - gap));
        if (el.style.height !== `${height}px`) el.style.height = `${height}px`;
      });
    };
    fit();
    window.addEventListener("resize", fit);
    // Something above appearing or going away moves the top.
    const watch = new ResizeObserver(fit);
    const main = el.closest("main");
    if (main?.parentElement) watch.observe(main.parentElement);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
      watch.disconnect();
    };
  }, [ref, min, gap]);
}
