"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Download, Share } from "lucide-react";

/**
 * The event Chromium fires once the app clears the installability bar. It is
 * not in lib.dom because it never became a standard, so it is typed here.
 */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

declare global {
  interface Window {
    __installPrompt?: InstallPromptEvent;
  }
}

/**
 * Registers the service worker for the whole app.
 *
 * It used to be registered only by the push toggle, which lives on the
 * notification settings screen — so a member of staff who never opened that
 * screen had no offline fallback, and the browser never considered the app
 * installable at all (Chromium requires a live registration before it will
 * fire `beforeinstallprompt`). Registration is idempotent, so the push toggle
 * calling it again is harmless.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}

/**
 * Offers to install the app, and says nothing at all when that is not on the
 * table — already installed, or a browser that cannot do it. A button that is
 * always visible but only sometimes works is worse than no button.
 */
export function InstallApp({
  onDark,
  presentation = "row",
}: {
  onDark?: boolean;
  /** `row` sits in a menu list; `button` stands on its own inside a card. */
  presentation?: "row" | "button";
}) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [isIos, setIsIos] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  useEffect(() => {
    const installed =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (installed) return;

    /*
      Chromium fires the event during page load, usually before React has
      mounted, and it only fires once. The snippet in the document head parks it
      on `window` and re-announces it, so it does not matter which of the two
      lands first.
    */
    if (window.__installPrompt) setPrompt(window.__installPrompt);
    const pick = () => {
      if (window.__installPrompt) setPrompt(window.__installPrompt);
    };
    window.addEventListener("installpromptready", pick);

    const done = () => {
      setPrompt(null);
      setIsIos(false);
      window.__installPrompt = undefined;
    };
    window.addEventListener("appinstalled", done);

    /*
      iOS has no install prompt to trigger: Safari only offers Add to Home
      Screen from its share sheet, so there the button can do nothing but say
      where to find it. Chrome and Firefox on iOS cannot install at all — they
      are excluded rather than shown instructions that lead nowhere.
    */
    const ua = navigator.userAgent;
    const iOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (iOS && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) setIsIos(true);

    return () => {
      window.removeEventListener("installpromptready", pick);
      window.removeEventListener("appinstalled", done);
    };
  }, []);

  if (!prompt && !isIos) return null;

  const click = async () => {
    if (!prompt) {
      setShowSteps((v) => !v);
      return;
    }
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      // The event is single-use; a second press would reject. Nothing to say.
    }
    // Consumed either way — Chromium re-fires it on a later visit if declined.
    setPrompt(null);
    window.__installPrompt = undefined;
  };

  const expanded = isIos && !prompt ? showSteps : undefined;

  return (
    <div>
      {presentation === "button" ? (
        <Button variant="outline" onClick={click} aria-expanded={expanded}>
          <Download strokeWidth={1.75} />
          {t.install.cta}
        </Button>
      ) : (
        <button
          type="button"
          onClick={click}
          aria-expanded={expanded}
          className={
            onDark
              ? "flex w-full touch-manipulation items-center gap-2.5 rounded-ctl px-3 py-2 text-[13px] font-medium text-white/70 transition-colors duration-140 ease-out hover:bg-white/5 hover:text-white"
              : "flex w-full touch-manipulation items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-700 transition-colors duration-140 ease-out hover:bg-sunken"
          }
        >
          <Download
            className={onDark ? "h-4.5 w-4.5 shrink-0" : "h-[18px] w-[18px] shrink-0 text-ink-400"}
            strokeWidth={1.75}
          />
          {t.install.cta}
        </button>
      )}

      {showSteps && !prompt && (
        <ol
          className={`mt-1 space-y-1.5 rounded-ctl px-3 py-2.5 text-[12px] leading-snug animate-fade-up ${
            onDark ? "bg-white/5 text-white/60" : "bg-sunken text-ink-500"
          }`}
        >
          <li className="flex items-start gap-2">
            <Share className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            {t.install.iosShare}
          </li>
          <li className="ps-5.5">{t.install.iosAdd}</li>
        </ol>
      )}
    </div>
  );
}
