"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Info } from "lucide-react";

type ToastKind = "success" | "error" | "info";
/** A button on the toast — Undo, after something done in one tap with no confirm box. */
type ToastAction = { label: string; onClick: () => void };
type Toast = { id: number; kind: ToastKind; text: string; action?: ToastAction };

const ToastContext = createContext<{ toast: (text: string, kind?: ToastKind, action?: ToastAction) => void } | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);

  const toast = useCallback((text: string, kind: ToastKind = "success", action?: ToastAction) => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { id, kind, text, action }]);
    // Long enough to reach for Undo.
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), action ? 7000 : 3500);
  }, []);

  // The only place a colored edge is allowed by the brand.
  const barColor: Record<ToastKind, string> = {
    success: "border-s-ok",
    error: "border-s-danger",
    info: "border-s-brand-600",
  };

  const icons: Record<ToastKind, React.ReactNode> = {
    success: <CheckCircle2 className="h-4.5 w-4.5 text-ok" />,
    error: <AlertCircle className="h-4.5 w-4.5 text-danger" />,
    info: <Info className="h-4.5 w-4.5 text-ink-500" />,
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/*
        Clear of the phone's tab bar, which is there below `md` and grows by the
        home-indicator inset on an iPhone: a fixed 80px left the toast sitting
        on the tabs there, and between `sm` and `md` it dropped to 24px while
        the bar was still on screen.
      */}
      <div className="pointer-events-none fixed bottom-[calc(5.5rem_+_env(safe-area-inset-bottom))] z-[60] flex w-full flex-col items-center gap-2 px-4 md:bottom-6">
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex max-w-sm items-center gap-2.5 rounded-card border border-line border-s-4 bg-surface px-4 py-2.5 text-sm font-medium text-ink-900 shadow-pop animate-fade-up ${barColor[t.kind]}`}
          >
            {icons[t.kind]}
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.onClick();
                  setItems((xs) => xs.filter((x) => x.id !== t.id));
                }}
                className="ms-1 -me-1 h-8 shrink-0 rounded-ctl px-2.5 text-[13px] font-semibold text-brand-700 hover:bg-sunken"
                data-toast-action
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const v = useContext(ToastContext);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}
