"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Info } from "lucide-react";

type ToastKind = "success" | "error" | "info";
type Toast = { id: number; kind: ToastKind; text: string };

const ToastContext = createContext<{ toast: (text: string, kind?: ToastKind) => void } | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);

  const toast = useCallback((text: string, kind: ToastKind = "success") => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { id, kind, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3500);
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
      <div className="pointer-events-none fixed bottom-20 z-[60] flex w-full flex-col items-center gap-2 px-4 sm:bottom-6">
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex max-w-sm items-center gap-2.5 rounded-card border border-line border-s-4 bg-surface px-4 py-2.5 text-sm font-medium text-ink-900 shadow-pop animate-fade-up ${barColor[t.kind]}`}
          >
            {icons[t.kind]}
            <span>{t.text}</span>
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
