"use client";

import { forwardRef, useId } from "react";
import { Search } from "lucide-react";

const base =
  "w-full rounded-ctl border border-line bg-surface px-3 text-sm text-ink-900 placeholder:text-ink-500 transition-[border-color,box-shadow] duration-140 ease-out hover:border-line-strong focus:border-brand-600 focus:shadow-[0_0_0_3px_rgb(105_137_166/0.30)] focus:outline-none disabled:bg-subtle disabled:text-ink-500";

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
      <Search className="pointer-events-none absolute inset-inline-start-3 start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
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
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5.5 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-brand-600" : "bg-ink-300"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-all ${
          checked ? "inset-inline-start-[calc(100%-1.25rem)]" : "inset-inline-start-0.5"
        }`}
      />
    </button>
  );
}
