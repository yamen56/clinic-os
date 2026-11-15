import { Skeleton } from "@/components/ui/misc";

/**
 * Patients today, before its patients are in: the board's outline, at each
 * width the way the board lays itself out (./flow-board).
 *
 *   - the counts, three across, six from a laptop up;
 *   - the columns: on a phone one behind its four-way switcher, two on a
 *     tablet, all four on a wide screen.
 *
 * Drawn twice on purpose, by the same component: while the calendar's page
 * comes (../loading.tsx) and while the board fetches the day (flow-board).
 * Before (Yamen, 2026-11-15: "the loading is not in the right proportions")
 * the first was a whole week — seven days stacked down a phone — and the
 * second a thin bar over an empty screen, so the screen changed shape twice
 * before showing anything.
 */
export function BoardOutline() {
  // Cards per column: uneven, so it reads as a day rather than a table not yet loaded.
  const cards = [2, 1, 3, 1];
  return (
    <div aria-busy="true" data-board-outline>
      <div className="mb-4 grid grid-cols-3 gap-2 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-card border border-line bg-surface p-3 shadow-card">
            <Skeleton className="h-3.5 w-16 max-w-full" />
            <Skeleton className="mt-2 h-6 w-8" />
          </div>
        ))}
      </div>

      {/* On a phone, the switcher between the four columns. */}
      <Skeleton className="mb-3 h-12 w-full rounded-full md:hidden" />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((n, col) => (
          // One column on a phone, two on a tablet, all four from xl.
          <div key={col} className={`rounded-card bg-sunken/70 p-2 ${col === 0 ? "" : col === 1 ? "max-md:hidden" : "max-xl:hidden"}`}>
            <Skeleton className="mb-3 ms-1.5 mt-1 h-4 w-24" />
            <div className="grid gap-2">
              {Array.from({ length: n }).map((_, i) => (
                <div key={i} className="rounded-xl border border-line bg-surface p-3">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="mt-2 h-3 w-1/2" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
