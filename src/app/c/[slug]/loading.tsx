import { Skeleton } from "@/components/ui/misc";

/**
 * Shown the instant a workspace route is clicked.
 *
 * Every page here is server-rendered against the database, so without this file
 * Next holds the previous screen until the whole render finishes — the click
 * appears to do nothing for the length of a round trip. A skeleton makes the
 * navigation feel immediate and gives the eye the right shape to land on.
 *
 * It is the fallback for every page without a skeleton of its own, and before a
 * page's own skeleton has been fetched — which on a phone on mobile data is most
 * first taps. So it is drawn as the shape nearly every page shares, a title over
 * a list, and not as the dashboard's tiles: Patients, Finance, Documents and the
 * rest each used to open on four stat cards that then turned into a list
 * (2026-11-14).
 */
export default function Loading() {
  return (
    <div className="animate-fade-in" data-page-loading>
      <div className="mb-5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <Skeleton className="h-7 w-40 max-w-full" />
          <Skeleton className="mt-2 h-4 w-56 max-w-[70vw]" />
        </div>
        <Skeleton className="h-10 w-28 shrink-0 rounded-ctl" />
      </div>

      <Skeleton className="mb-4 h-10 w-full rounded-ctl" />

      <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <div className="divide-y divide-line">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-4 w-40 max-w-[60%]" />
                <Skeleton className="mt-1.5 h-3 w-28 max-w-[45%]" />
              </div>
              <Skeleton className="h-6 w-16 shrink-0 rounded-full max-sm:hidden" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
