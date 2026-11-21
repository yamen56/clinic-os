"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Bell, BellOff, BellRing } from "lucide-react";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type State = "unsupported" | "blocked" | "off" | "on" | "working";

/**
 * Ask for notifications and register this device for push. Shared by the
 * switch on the notifications screen and the sheet an installed app opens
 * with (permissions-prompt.tsx), so both register the same way.
 *
 * Must be called from a tap: a phone refuses the question otherwise.
 */
export async function subscribeThisDevice(): Promise<"on" | "blocked" | "off" | "error"> {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
    const reg = await navigator.serviceWorker.ready;
    const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!key) return "error";
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      }));
    const res = await fetch("/api/me/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    return res.ok ? "on" : "error";
  } catch {
    return "error";
  }
}

/**
 * Registers the service worker and manages this device's push subscription.
 * `compact` renders the small toggle used in the notification center header.
 */
export function PushManager({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [state, setState] = useState<State>("working");

  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("blocked");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setState(sub ? "on" : "off");
    } catch {
      setState("off");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      setState("unsupported");
      return;
    }
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => refresh())
      .catch(() => setState("unsupported"));
  }, [refresh]);

  const enable = async () => {
    setState("working");
    const r = await subscribeThisDevice();
    if (r === "on") {
      setState("on");
      toast(t.notifications.pushEnabled);
      return;
    }
    if (r === "error") toast(t.common.genericError, "error");
    setState(r === "blocked" ? "blocked" : "off");
  };

  const disable = async () => {
    setState("working");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/me/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("off");
      toast(t.notifications.pushDisabled, "info");
    } catch {
      setState("off");
    }
  };

  if (state === "unsupported") {
    return compact ? null : (
      <p className="text-[0.8125rem] text-ink-500">{t.notifications.pushUnsupported}</p>
    );
  }
  if (state === "blocked") {
    return (
      <p className="flex items-center gap-2 text-[0.8125rem] text-st-pending">
        <BellOff className="h-4 w-4" />
        {t.notifications.pushBlocked}
      </p>
    );
  }
  if (state === "on") {
    return (
      <Button variant="ghost" size={compact ? "sm" : "md"} onClick={disable}>
        <BellRing className="h-4 w-4 text-brand-700" />
        {t.notifications.pushOn}
      </Button>
    );
  }
  return (
    <Button variant={compact ? "outline" : "primary"} size={compact ? "sm" : "md"} loading={state === "working"} onClick={enable}>
      <Bell className="h-4 w-4" />
      {t.notifications.enablePush}
    </Button>
  );
}
