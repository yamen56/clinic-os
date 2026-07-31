"use client";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-ink-900/6 ${className}`} />;
}

/** Loading is a slim bar, never a spinner. */
export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-ink-500">
      <span className="slim-progress w-40 rounded-full" role="progressbar" aria-label={label} />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-line bg-surface px-6 py-14 text-center">
      {icon && (
        <div className="grid h-16 w-16 place-items-center rounded-card bg-sunken text-brand-600 [&>svg]:h-8 [&>svg]:w-8">
          {icon}
        </div>
      )}
      <h3 className="font-display text-lg font-semibold text-ink-900">{title}</h3>
      {body && <p className="max-w-sm text-sm text-ink-500">{body}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Avatar({
  name,
  size = 36,
  color,
  src,
}: {
  name: string;
  size?: number;
  color?: string;
  /** A photo. Initials are drawn underneath and show through if it fails. */
  src?: string | null;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] ?? "")
    .join("");
  return (
    <span
      className="font-display relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: color || "var(--color-brand-100)",
        color: color ? "#fff" : "var(--color-brand-700)",
      }}
    >
      {initials}
      {src && (
        /*
          Layered over the initials rather than swapped for them, so there is
          never an empty circle: a photo that 404s (deleted, or the storage
          backend having a moment) simply reveals what was already behind it.
          eslint-disable — next/image cannot help here; these are authorised
          API routes, not optimisable static assets.
        */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}
    </span>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: React.ReactNode; count?: number }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={`relative flex h-10 touch-manipulation items-center whitespace-nowrap px-3.5 text-sm font-semibold transition-colors duration-140 ease-out ${
            active === t.key ? "text-ink-900" : "text-ink-500 hover:text-ink-700"
          }`}
        >
          {t.label}
          {typeof t.count === "number" && t.count > 0 && (
            <span className="ms-1.5 rounded-full bg-brand-100 px-1.5 py-0.5 text-[11px] font-semibold text-brand-700 tnum">
              {t.count}
            </span>
          )}
          {active === t.key && (
            <span className="absolute inset-x-0 bottom-0 h-0.5 bg-brand-600" />
          )}
        </button>
      ))}
    </div>
  );
}
