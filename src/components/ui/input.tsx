"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
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

/**
 * A number box you can actually empty.
 *
 * Every numeric field in this app was written as a controlled input whose
 * handler read `Number(e.target.value) || fallback`. Select the price, press
 * delete, and the box does not go blank: the empty string becomes `Number("")`,
 * which is 0, which is falsy, so the fallback lands in state and React puts it
 * straight back in the box. The caret sits after a `0` nobody can remove, and
 * typing 50 gives 050. There is no keystroke that fixes it — the only way to
 * replace a price was to select the zero and type over it, which is not
 * something anyone should have to discover.
 *
 * The fix is to stop making the box show a number. It shows *text*, held here,
 * and reports a number upwards whenever that text is one. Empty stays empty for
 * as long as the person is in the field.
 *
 * What the parent sees while the box is blank is `fallback` — so an invoice
 * total recomputed mid-edit is still arithmetic on real numbers rather than on
 * NaN — and on blur the box settles to that same value, so a field left empty
 * ends up agreeing with what was already reported.
 */
export const NumberInput = forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
    value: number;
    onChange: (value: number) => void;
    /** Where an emptied box settles. Defaults to `min`, or 0. */
    fallback?: number;
  }
>(function NumberInput(
  { value, onChange, fallback, min, max, onBlur, className = "", ...rest },
  ref
) {
  const resting = fallback ?? (typeof min === "number" ? min : 0);
  const [text, setText] = useState(() => String(value));
  /*
    The value this component last sent up. Without it the effect below cannot
    tell a genuine outside change — picking a service, which sets the price —
    from the echo of the keystroke just typed, and would re-normalise the text on
    every character. That echo is the original bug wearing a different hat.
  */
  const reported = useRef(value);

  useEffect(() => {
    if (value !== reported.current) {
      reported.current = value;
      setText(String(value));
    }
  }, [value]);

  const send = (n: number) => {
    reported.current = n;
    onChange(n);
  };

  return (
    <input
      ref={ref}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      value={text}
      {...rest}
      // After the spread, so a caller's className is appended to the base styles
      // rather than replacing them — which is what `{...rest}` last would do.
      className={`${base} h-10 ${className}`}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw === "") return send(resting);
        const n = Number(raw);
        // "-", "1e" and "1." are all somebody part-way through typing. Leave the
        // text alone and say nothing upwards until it means something.
        if (Number.isFinite(n)) send(n);
      }}
      onBlur={(e) => {
        const n = Number(text);
        let settled = text === "" || !Number.isFinite(n) ? resting : n;
        // Clamped on the way out rather than on the way in: clamping per
        // keystroke makes it impossible to type 50 into a field whose minimum
        // is 10, because 5 is rejected before the 0 arrives.
        if (typeof min === "number" && settled < min) settled = min;
        if (typeof max === "number" && settled > max) settled = max;
        setText(String(settled));
        if (settled !== reported.current) send(settled);
        onBlur?.(e);
      }}
    />
  );
});

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
  /*
    No `htmlFor`. It used to carry a `useId()` that was never put on the control
    inside, and a `for` naming nothing is worse than no `for` at all: the browser
    stops looking, so the label had no labelled control — clicking the text
    focused nothing, and assistive tech read the field as unlabelled. A label
    that simply wraps its control is associated with it implicitly, which is
    what every one of these was already doing.
  */
  return (
    <label className="block">
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
