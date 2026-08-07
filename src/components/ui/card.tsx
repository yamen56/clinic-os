/*
  Cards are white with a hairline and shadow-1 — never a colored left edge and
  never a gradient. Status belongs in a chip, not the card border.
*/
export function Card({
  className = "",
  children,
  clickable,
}: {
  className?: string;
  children: React.ReactNode;
  clickable?: boolean;
}) {
  return (
    <div
      className={`rounded-card border border-line bg-surface shadow-card ${
        clickable ? "cursor-pointer transition-shadow duration-220 ease-out hover:shadow-pop" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  sub,
  action,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div>
        <h3 className="font-display text-base font-semibold text-ink-900">{title}</h3>
        {sub && <p className="mt-0.5 text-[13px] text-ink-500">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  sub,
  action,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">{title}</h1>
        {sub && <p className="mt-1 text-sm text-ink-500">{sub}</p>}
      </div>
      {/*
        flex-wrap, because this holds however many buttons a page decides to put
        in its header — five on a patient file, four on a sent document — and on
        a phone they do not fit on one line. Without it the row simply grew: the
        document page reported itself 761px wide on a 390px screen, which is not
        a header that looks slightly wrong but a whole page that scrolls
        sideways. The header above has always wrapped; this never did.
      */}
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}
