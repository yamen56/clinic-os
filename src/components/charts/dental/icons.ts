/*
  The icon for work that has no shape on a single tooth — an x-ray, a
  cleaning, a night guard — by the group it belongs to. One map, used by the
  picker's chips, the badges beside a tooth number and the whole-mouth cards,
  so the same treatment wears the same picture everywhere.
*/

import { Activity, Anchor, Baby, CircleDot, Crown, ScanSearch, Scissors, Smile, Sparkles, Sun, Waves, Wrench, type LucideIcon } from "lucide-react";
import type { Category } from "@/lib/charts/dental/catalog";

const BY_CATEGORY: Record<Category, LucideIcon> = {
  findings: CircleDot,
  diagnostic: ScanSearch,
  preventive: Sparkles,
  restorative: Wrench,
  endodontic: Activity,
  periodontic: Waves,
  fixed: Crown,
  removable: Smile,
  implant: Anchor,
  surgery: Scissors,
  ortho: Smile,
  pediatric: Baby,
  cosmetic: Sun,
};

export function iconFor(category: Category | undefined): LucideIcon {
  return (category && BY_CATEGORY[category]) || CircleDot;
}
