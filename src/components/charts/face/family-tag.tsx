"use client";

/*
  A treatment's kind, in its colour — a tinted label, not a dot (Yamen,
  2026-10-28: "you can use colors but without those circles"). The words stay
  in the theme's ink so they read in light and dark alike; the colour is the
  tint and the edge.
*/

import { FAMILY_COLOR, type Family } from "@/lib/charts/face/catalog";

export function familyTint(f: Family, alpha = "24"): string {
  return `${FAMILY_COLOR[f]}${alpha}`;
}

export function FamilyTag({ family, label, className = "" }: { family: Family; label: string; className?: string }) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[11px] font-semibold text-ink-900 ${className}`}
      style={{ background: familyTint(family), borderColor: `${FAMILY_COLOR[family]}80` }}
      data-family={family}
    >
      {label}
    </span>
  );
}
