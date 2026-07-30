export type StatusKey =
  | "scheduled"
  | "confirmed"
  | "completed"
  | "no_show"
  | "cancelled"
  | "pending"
  | "ok"
  | "danger"
  | "neutral"
  | "brand";

export const statusColors: Record<StatusKey, { fg: string; bg: string }> = {
  scheduled: { fg: "var(--color-st-scheduled)", bg: "var(--color-st-scheduled-soft)" },
  confirmed: { fg: "var(--color-st-confirmed)", bg: "var(--color-st-confirmed-soft)" },
  completed: { fg: "var(--color-st-completed)", bg: "var(--color-st-completed-soft)" },
  no_show: { fg: "var(--color-st-noshow)", bg: "var(--color-st-noshow-soft)" },
  cancelled: { fg: "var(--color-st-cancelled)", bg: "var(--color-st-cancelled-soft)" },
  pending: { fg: "var(--color-st-pending)", bg: "var(--color-st-pending-soft)" },
  ok: { fg: "var(--color-st-confirmed)", bg: "var(--color-st-confirmed-soft)" },
  danger: { fg: "var(--color-danger)", bg: "var(--color-danger-soft)" },
  neutral: { fg: "var(--color-ink-700)", bg: "var(--color-st-completed-soft)" },
  brand: { fg: "var(--color-brand-700)", bg: "var(--color-brand-100)" },
};

export function Badge({
  status = "neutral",
  children,
  dot,
  className = "",
}: {
  status?: StatusKey;
  children: React.ReactNode;
  dot?: boolean;
  className?: string;
}) {
  const c = statusColors[status];
  return (
    <span
      // shrink-0 so a truncating sibling (a patient name, a campaign title)
      // squeezes itself rather than crushing the status chip next to it.
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap [&_svg]:shrink-0 ${className}`}
      style={{ color: c.fg, background: c.bg }}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.fg }} />}
      {children}
    </span>
  );
}
