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
/**
 * The full lockup — mark, كلينيكتي and CLINICTI — for the sidebar header.
 *
 * Kept separate from BrandMark rather than made a variant of it, because the
 * two have different jobs. The lockup names the product where there is width to
 * read it; the mark stands alone where there is not. Both are white on
 * transparency and both therefore need a dark surface under them.
 *
 * No load-state fallback here on purpose: this sits inside the sidebar's own
 * header, so a missing file leaves a gap rather than a broken layout, and
 * BrandMark is the one that has to survive being the only thing on a login page.
 */
export function BrandLockup({ className = "" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/assets/logo-mark-wide.png"
      alt="Clinicti"
      /*
        Width-driven, not height-driven: the asset is 4:1, and the sidebar's
        constraint is its 248px width rather than the 88px header. Sizing by
        width fills the space the panel actually has and keeps the Arabic
        readable, which at 44px tall it was not.
      */
      className={`h-auto w-[196px] object-contain ${className}`}
    />
  );
}

/**
 * The mark on its own navy plate, for chrome that sits on a light surface.
 *
 * The source mark is white on transparency, so a light header cannot show it
 * directly — which is exactly why the admin header used to draw a literal "M"
 * on a dark square instead. This is that same dark square with the real mark on
 * it, and it reuses `mark-light.png` rather than introducing a second hand-made
 * asset: that file is generated from `logo-mark-primary.png` by `npm run icons`,
 * so replacing the one source still rebrands everything.
 *
 * Rounding is applied here rather than baked into the asset. Every generated
 * plate is a full square on purpose — a radius in the file would leave
 * transparent corners that read as white notches — so the corners are clipped
 * at the point of use, where the surface behind them is known.
 */
export function BrandPlate({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/assets/mark-light.png"
      alt="Clinicti"
      width={size}
      height={size}
      className={`shrink-0 rounded-lg object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

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
