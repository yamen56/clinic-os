"use client";

/**
 * A button that opens the device's own date picker and answers with the day.
 *
 * The phone's native picker is the best one there is for "show me the 14th",
 * and it costs no calendar widget of our own. A real `<input type="date">`
 * lies invisibly over whatever the caller draws, so a tap lands on the input
 * itself — which is what iOS needs to open its wheel — and a click on a
 * desktop asks for the picker explicitly (`showPicker`), since there clicking
 * the text of a date field only selects its segments. 16px, or iOS zooms the
 * page on focus.
 */
export function DatePickButton({
  value,
  onPick,
  label,
  className = "",
  children,
}: {
  /** yyyy-mm-dd. */
  value: string;
  onPick: (dateISO: string) => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`relative inline-flex ${className}`} data-date-pick>
      {children}
      <input
        type="date"
        value={value}
        aria-label={label}
        title={label}
        onChange={(e) => e.target.value && onPick(e.target.value)}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker?.();
          } catch {}
        }}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none text-base opacity-0"
      />
    </span>
  );
}
