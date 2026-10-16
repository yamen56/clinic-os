"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A small dropdown anchored to its button — the board's "more" menu and its
 * room picker. Closes on a tap outside, on Escape, and after a choice.
 */
export function Menu({
  label,
  trigger,
  buttonClassName,
  children,
  align = "end",
  className = "",
}: {
  label: string;
  trigger: (open: boolean) => React.ReactNode;
  buttonClassName: string;
  children: (close: () => void) => React.ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={buttonClassName}
      >
        {trigger(open)}
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute top-full z-30 mt-1 min-w-52 max-w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop animate-fade-in ${
            align === "end" ? "end-0" : "start-0"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  href,
  disabled,
  danger,
  hint,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  danger?: boolean;
  hint?: React.ReactNode;
}) {
  const cls = `flex w-full items-center gap-2.5 px-3 py-2 text-start text-[13px] font-medium transition-colors ${
    disabled ? "cursor-default text-ink-300" : danger ? "text-danger hover:bg-danger-soft" : "text-ink-700 hover:bg-sunken"
  } [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0`;
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {hint && <span className="block truncate text-[11.5px] font-normal text-ink-400">{hint}</span>}
      </span>
    </>
  );
  if (href && !disabled) {
    return (
      <a role="menuitem" href={href} className={cls} onClick={onClick}>
        {body}
      </a>
    );
  }
  return (
    <button role="menuitem" type="button" disabled={disabled} onClick={onClick} className={cls}>
      {body}
    </button>
  );
}
