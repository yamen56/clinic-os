"use client";

import { useI18n } from "@/lib/i18n/client";
import type { SaveState } from "@/lib/use-autosave";
import { Check, CloudOff, AlertTriangle } from "lucide-react";

export function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useI18n();
  if (state === "idle") return <span className="h-5" />;
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
  }[state];
  return (
    <span className={`inline-flex h-5 items-center gap-1.5 text-xs font-medium ${map.cls}`}>
      {map.icon}
      {map.text}
    </span>
  );
}
