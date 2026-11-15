/*
  A tooth, drawn the way the rest of the icon set is drawn (24 grid, 2px
  stroke, round joins), so it sits beside them without looking borrowed.

  Lucide has no tooth. Dental work wore a smiling face instead, which Yamen
  asked to replace (2026-11-15: "put a tooth chart icon instead of the
  smiling face"). Built with lucide's own factory, it takes the same props —
  className, strokeWidth, size — and goes anywhere a LucideIcon goes.
*/

import { createLucideIcon } from "lucide-react";

export const Tooth = createLucideIcon("tooth", [
  [
    "path",
    {
      d: "M7 3C4.8 3 3 4.8 3 7.2c0 2.4.8 3.8 1.5 5.3.6 1.4.8 3 1.1 4.8.3 2 .9 3.7 2.1 3.7 1.4 0 1.7-2 2.1-3.8.3-1.3.9-2.2 2.2-2.2s1.9.9 2.2 2.2c.4 1.8.7 3.8 2.1 3.8 1.2 0 1.8-1.7 2.1-3.7.3-1.8.5-3.4 1.1-4.8.7-1.5 1.5-2.9 1.5-5.3C21 4.8 19.2 3 17 3c-1.9 0-2.9 1-5 1S8.9 3 7 3Z",
      key: "tooth-outline",
    },
  ],
]);
