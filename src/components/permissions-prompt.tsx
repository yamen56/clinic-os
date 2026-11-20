"use client";

/*
  What the installed app asks for, the first time it opens.

  Yamen, 2026-11-20: "I want the application to ask for the permissions when
  someone installs the app". Installed, Clinicti is the doctor's and the
  desk's phone app: it needs notifications for a patient's WhatsApp message to
  reach them (worker/wa/message-alert.ts), the camera for photos and x-rays
  into a file, the microphone for voice notes and dictating a visit. Until now
  each was asked for only the first time it was used, and notifications only
  from a switch deep in the notifications screen.

  A sheet rather than three prompts in a row, because a phone shows its own
  question only from a tap, and a question with no reason beside it is the
  one people refuse. Each row asks for one thing when tapped; what is already
  allowed says so; what was refused says where to change it. Only in the
  installed app, only while something is still unasked, and "Not now" holds it
  back for three days. Remembered per device (localStorage), which is what a
  permission is.
*/

import { useEffect, useState } from "react";
import { Bell, Camera, Check, Mic, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { subscribeThisDevice } from "@/components/push-manager";

type Perm = "granted" | "denied" | "prompt" | "unsupported" | "working";
type Kind = "notifications" | "camera" | "microphone";

const KEY = "clinicti:permissions-asked";
const LATER_MS = 3 * 24 * 3600_000;

function installed(): boolean {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: window-controls-overlay)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

async function notificationState(): Promise<Perm> {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "prompt";
  // Allowed, but this device is not registered for push yet: one tap finishes it.
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ? "granted" : "prompt";
  } catch {
    return "prompt";
  }
}

async function mediaState(name: "camera" | "microphone"): Promise<Perm> {
  if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
  try {
    const r = await navigator.permissions?.query({ name: name as PermissionName });
    if (r) return r.state === "granted" ? "granted" : r.state === "denied" ? "denied" : "prompt";
  } catch {
    // A browser that cannot say (older Safari): offer the button, and find out on the tap.
  }
  return "prompt";
}

function remembered(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function remember(v: string) {
  try {
    window.localStorage.setItem(KEY, v);
  } catch {
    // Private mode: it asks again next time, which is harmless.
  }
}

export function PermissionsPrompt() {
  const { t } = useI18n();
  const P = t.permissions;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<Record<Kind, Perm>>({ notifications: "unsupported", camera: "unsupported", microphone: "unsupported" });

  useEffect(() => {
    if (!installed()) return;
    const asked = remembered();
    if (asked === "done") return;
    if (asked?.startsWith("later:") && Date.now() - Number(asked.slice(6)) < LATER_MS) return;
    let live = true;
    void (async () => {
      const s: Record<Kind, Perm> = {
        notifications: await notificationState(),
        camera: await mediaState("camera"),
        microphone: await mediaState("microphone"),
      };
      if (!live) return;
      setState(s);
      if (Object.values(s).some((v) => v === "prompt")) setOpen(true);
      else remember("done");
    })();
    return () => {
      live = false;
    };
  }, []);

  const set = (k: Kind, v: Perm) => setState((cur) => ({ ...cur, [k]: v }));

  const ask = async (k: Kind) => {
    set(k, "working");
    if (k === "notifications") {
      const r = await subscribeThisDevice();
      set(k, r === "on" ? "granted" : r === "blocked" ? "denied" : "prompt");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(k === "camera" ? { video: true } : { audio: true });
      // Only the answer was wanted: the camera's light goes off at once.
      stream.getTracks().forEach((x) => x.stop());
      set(k, "granted");
    } catch (e) {
      const name = (e as DOMException)?.name;
      set(k, name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" ? "unsupported" : "prompt");
    }
  };

  const rows: { k: Kind; icon: LucideIcon; label: string; hint: string }[] = [
    { k: "notifications", icon: Bell, label: P.notifications, hint: P.notificationsHint },
    { k: "camera", icon: Camera, label: P.camera, hint: P.cameraHint },
    { k: "microphone", icon: Mic, label: P.microphone, hint: P.microphoneHint },
  ];
  const shown = rows.filter((r) => state[r.k] !== "unsupported");
  const left = shown.some((r) => state[r.k] === "prompt" || state[r.k] === "working");

  const close = (how: "later" | "done") => {
    remember(how === "done" ? "done" : `later:${Date.now()}`);
    setOpen(false);
  };

  return (
    <Modal
      open={open}
      onClose={() => close(left ? "later" : "done")}
      title={P.title}
      footer={
        <>
          {left && (
            <Button variant="outline" onClick={() => close("later")} data-permissions-later>
              {P.later}
            </Button>
          )}
          <Button variant={left ? "ghost" : "primary"} onClick={() => close("done")} data-permissions-done>
            {P.done}
          </Button>
        </>
      }
    >
      <div className="grid gap-3" data-permissions-prompt>
        <p className="text-[13px] leading-relaxed text-ink-500">{P.sub}</p>
        <ul className="grid gap-2">
          {shown.map(({ k, icon: Icon, label, hint }) => {
            const s = state[k];
            return (
              <li key={k} className="flex flex-wrap items-center gap-3 rounded-ctl border border-line px-3 py-2.5" data-permission={k} data-permission-state={s}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sunken text-ink-700">
                  <Icon className="h-4.5 w-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-ink-900">{label}</span>
                  <span className="block text-[12.5px] leading-snug text-ink-500">{s === "denied" ? P.blocked : hint}</span>
                </span>
                {s === "granted" ? (
                  <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-st-confirmed">
                    <Check className="h-4 w-4" />
                    {P.allowed}
                  </span>
                ) : s === "denied" ? null : (
                  <Button size="sm" loading={s === "working"} onClick={() => void ask(k)} data-permission-allow={k}>
                    {P.allow}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
