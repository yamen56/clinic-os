"use client";

import { forwardRef, useEffect, useId, useState } from "react";
import { Search } from "lucide-react";

/*
  `text-base md:text-sm` is a mobile fix, not a type choice: iOS zooms the whole
  page in whenever a focused field's text is under 16px, and then leaves it
  zoomed. 16px on phones keeps the field readable and the page still, and the
  design's 14px returns from `md` up where no such behaviour exists. This is
  what lets the viewport allow pinch-zoom again instead of banning it outright.
*/
const base =
  "w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink-900 placeholder:text-ink-500 transition-[border-color,box-shadow] duration-140 ease-out hover:border-line-strong focus:border-brand-600 focus:shadow-[0_0_0_3px_rgb(105_137_166/0.30)] focus:outline-none disabled:bg-subtle disabled:text-ink-500 md:text-sm";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...rest }, ref) {
    return <input ref={ref} className={`${base} h-10 ${className}`} {...rest} />;
  }
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = "", ...rest }, ref) {
  return <textarea ref={ref} className={`${base} min-h-20 py-2 ${className}`} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", children, ...rest }, ref) {
    return (
      <select ref={ref} className={`${base} h-10 appearance-none ${className}`} {...rest}>
        {children}
      </select>
    );
  }
);

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-1.5 flex items-baseline gap-1 text-[13px] font-semibold text-ink-900">
        {label}
        {required && <span className="text-danger">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}

export function SearchInput({
  className = "",
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
      <input className={`${base} h-10 ps-9`} type="search" {...rest} />
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  /*
    The switch answers the finger, not the database.

    `checked` arrives from a server round trip, so driving the knob straight
    from it means the control sits still for the length of that trip and the
    click reads as ignored. Holding the position locally moves it on the press
    instead; the prop takes over again the moment it catches up — which also
    snaps the knob back on its own if the write was rejected.
  */
  const [shown, setShown] = useState(checked);
  useEffect(() => setShown(checked), [checked]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={shown}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        setShown(!shown);
        onChange(!shown);
      }}
      /*
        `before:-inset-2` is an invisible hit area. The switch is 40×22 to sit
        quietly in a settings row, which is well under the 44px a fingertip
        needs; the pseudo-element buys the missing millimetres without making
        the control louder. `touch-manipulation` drops the browser's wait for a
        possible double-tap, which is what makes a mobile press feel delayed.
      */
      className={`group relative h-5.5 w-10 shrink-0 touch-manipulation rounded-full transition-colors duration-200 ease-out before:absolute before:-inset-2 before:content-[''] disabled:opacity-50 ${
        shown ? "bg-brand-600" : "bg-ink-300"
      }`}
    >
      {/*
        Travels on `translate` rather than `start`: the knob gets its own layer,
        so the movement is composited instead of relaid out on every frame.
        200ms on the brand curve reads as travel — at 140 the knob teleports and
        the eye never sees which way it went. The press-scale confirms the touch
        landed before the round trip that follows has returned.
      */}
      <span
        className={`absolute top-0.5 start-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-transform duration-200 ease-out group-active:scale-90 ${
          shown ? "translate-x-[1.125rem] rtl:-translate-x-[1.125rem]" : "translate-x-0"
        }`}
      />
    </button>
  );
}
