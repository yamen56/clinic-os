"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The Clinicti mark, used alone — never with the wordmark set beside it.
 *
 * Rendered from `public/assets/logo-mark-primary.png` — never redrawn in SVG or
 * CSS, never recolored. The monogram plate shows only if that asset is missing,
 * so the chrome never flashes a broken image.
 *
 * The asset is white on transparency, which is why every surface that uses it is
 * a dark one: the sidebar's night panel, the login page, and the navy plate the
 * icon generator composites onto. Dropping it on a light background would render
 * an invisible square.
 *
 * The status is settled in an effect rather than via `onLoad`: the browser
 * usually finishes decoding before React hydrates, so the load event fires with
 * no listener attached and would leave the fallback showing forever.
 */
export function BrandMark({
  size = 64,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [state, setState] = useState<"pending" | "ok" | "failed">("pending");

  useEffect(() => {
    const img = ref.current;
    if (!img) return;
    if (img.complete) {
      setState(img.naturalWidth > 0 ? "ok" : "failed");
      return;
    }
    const ok = () => setState("ok");
    const fail = () => setState("failed");
    img.addEventListener("load", ok);
    img.addEventListener("error", fail);
    return () => {
      img.removeEventListener("load", ok);
      img.removeEventListener("error", fail);
    };
  }, []);

  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center ${className}`}
      style={{ width: size, height: size }}
    >
      {state === "failed" && (
        <span
          aria-hidden
          className="absolute inset-0 grid place-items-center rounded-card"
          style={{ background: "rgb(105 137 166 / 0.22)", color: "#fff" }}
        >
          <span
            className="font-display font-extrabold"
            style={{ fontSize: size * 0.34, letterSpacing: "-0.02em" }}
          >
            C
          </span>
        </span>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={ref}
        src="/assets/logo-mark-primary.png"
        alt="Clinicti"
        width={size}
        height={size}
        className="relative object-contain"
        style={{ width: size, height: size, opacity: state === "failed" ? 0 : 1 }}
      />
    </span>
  );
}
