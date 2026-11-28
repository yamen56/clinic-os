"use client";

import { useI18n } from "@/lib/i18n/client";
import type { SaveState } from "@/lib/use-autosave";
import { Check, CloudOff, AlertTriangle } from "lucide-react";

/** `tone="dark"`: on a navy surface (the patient's cover), where the status colours would not read. */
export function SaveIndicator({ state, tone = "light" }: { state: SaveState; tone?: "light" | "dark" }) {
  const { t } = useI18n();
  // On the cover nothing holds its place: an empty row there would still take a line.
  if (state === "idle") return tone === "dark" ? null : <span className="h-5" />;
  const map = {
    saving: {
      icon: <span className="slim-progress w-6 rounded-full" />,
      text: t.common.saving,
      cls: "text-ink-500",
    },
    saved: {
      icon: <Check className="h-3.5 w-3.5" />,
      text: t.common.saved,
      cls: "text-ok",
    },
    offline: {
      icon: <CloudOff className="h-3.5 w-3.5" />,
      text: t.common.offline,
      cls: "text-st-pending",
    },
    error: {
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      text: t.common.offline,
      cls: "text-st-pending",
    },
    // The server read the value and refused it; the rest of the form is saved.
    rejected: {
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      text: t.common.saveRejected,
      cls: "text-danger",
    },
  }[state];
  return (
    <span className={`inline-flex h-5 items-center gap-1.5 text-xs font-medium ${tone === "dark" ? (state === "rejected" ? "text-white" : "text-white/75") : map.cls}`}>
      {map.icon}
      {map.text}
    </span>
  );
}
