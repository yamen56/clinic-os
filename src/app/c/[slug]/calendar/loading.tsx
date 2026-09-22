import { Skeleton } from "@/components/ui/misc";

/**
 * A week, because the calendar opens on one.
 *
 * Same reason as the other two: the only skeleton in the workspace was the
 * dashboard's, and a grid of stat tiles resolving into a grid of days is a
 * visible relayout rather than a head start.
 *
 * Seven columns on a wide screen and one on a phone, matching how the calendar
 * itself collapses — a skeleton that keeps a layout the real screen drops is
 * the same mistake in the other direction.
 */
export default function Loading() {
  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <Skeleton className="h-7 w-40" />
          <Skeleton className="mt-2 h-4 w-48" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-24 rounded-ctl" />
          <Skeleton className="h-10 w-32 rounded-ctl" />
        </div>
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-7 sm:divide-x sm:divide-y-0">
          {Array.from({ length: 7 }).map((_, day) => (
            <div key={day} className="min-h-40 p-2.5">
              <Skeleton className="h-3 w-14" />
              <div className="mt-3 space-y-2">
                {/*
                  A different number of appointments per day. An even grid reads
                  as a table that has not loaded; an uneven one reads as a week.
                */}
                {Array.from({ length: [2, 3, 1, 3, 2, 1, 0][day] }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full rounded-md" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
