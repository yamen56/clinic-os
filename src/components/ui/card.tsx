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
    /*
      `min-w-0` because a card is almost always a flex or grid item, and such an
      item defaults to `min-width: auto` — it refuses to shrink below the
      min-content of everything inside it. One table, one long token or one
      button row that cannot wrap then sets the width of the card, the track it
      sits in, and the page around it, and a phone scrolls sideways. A card
      should take the width it is given; anything inside that genuinely cannot
      shrink gets its own scroller.
    */
    <div
      className={`min-w-0 rounded-card border border-line bg-surface shadow-card ${
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
    /*
      Wraps, and the text column may shrink.

      Without either, a header holding a button could not break: its smallest
      possible width was the title plus the whole button, and since this sits
      inside a card in a grid, that minimum became the grid's track — so the
      card grew wider than the phone around it and the whole page scrolled
      sideways. It is one component, so it was doing that on every screen that
      puts an action beside a card title.
    */
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">
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
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 md:mb-6">
      <div className="min-w-0">
        <h1 className="font-display text-[22px] font-bold text-ink-900 md:text-2xl">{title}</h1>
        {sub && <p className="mt-1 text-sm text-ink-500">{sub}</p>}
      </div>
      {/*
        flex-wrap, because this holds however many buttons a page decides to put
        in its header — five on a patient file, four on a sent document — and on
        a phone they do not fit on one line. Without it the row simply grew: the
        document page reported itself 761px wide on a 390px screen, which is not
        a header that looks slightly wrong but a whole page that scrolls
        sideways. The header above has always wrapped; this never did.

        On a phone the row also takes the full width and each button grows
        into it. Wrapped at their natural widths, four buttons fell into rows of
        three and one with a ragged edge; grown, every row is flush, and the
        lone primary action on the last line becomes a full-width target. Only
        buttons and links grow: a status chip or a segmented control stretched
        across the screen stops reading as what it is.
      */}
      {action && (
        <div className="flex w-full flex-wrap items-center gap-2 max-sm:[&>a]:grow max-sm:[&>button]:grow sm:w-auto">
          {action}
        </div>
      )}
    </div>
  );
}
