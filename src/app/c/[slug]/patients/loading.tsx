import { Skeleton } from "@/components/ui/misc";

/**
 * A list, because that is what arrives.
 *
 * The workspace already had a skeleton, but only one, and it is the dashboard's
 * — four stat tiles above a two-thirds/one-third grid. Every other route
 * borrowed it, so opening Patients showed a row of tiles for a moment and then
 * snapped to a list of people. That is the failure its own docstring names:
 * a skeleton is meant to give the eye "the right shape to land on", and the
 * wrong shape is worse than none, because the layout visibly changes under
 * somebody who has already started reading it.
 *
 * Header, filter row, then rows with an avatar — the real screen, greyed out.
 */
export default function Loading() {
  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <Skeleton className="h-7 w-32" />
          <Skeleton className="mt-2 h-4 w-52" />
        </div>
        <Skeleton className="h-10 w-36 rounded-ctl" />
      </div>

      {/* The filter row, which is present before any data is. */}
      <div className="mb-3 flex flex-wrap gap-2">
        <Skeleton className="h-10 flex-1 min-w-48 rounded-ctl" />
        <Skeleton className="h-10 w-32 rounded-ctl" />
        <Skeleton className="h-10 w-32 rounded-ctl" />
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <div className="divide-y divide-line">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3.5 px-4 py-3">
              <Skeleton className="h-[38px] w-[38px] shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="mt-1.5 h-3 w-56" />
              </div>
              <Skeleton className="hidden h-6 w-16 shrink-0 rounded-full sm:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
