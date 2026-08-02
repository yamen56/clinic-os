import { Skeleton } from "@/components/ui/misc";

/**
 * Shown the instant a workspace route is clicked.
 *
 * Every page here is server-rendered against the database, so without this file
 * Next holds the previous screen until the whole render finishes — the click
 * appears to do nothing for the length of a round trip. A skeleton makes the
 * navigation feel immediate and gives the eye the right shape to land on.
 */
export default function Loading() {
  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <Skeleton className="h-7 w-44" />
          <Skeleton className="mt-2 h-4 w-64" />
        </div>
        <Skeleton className="h-10 w-32 rounded-ctl" />
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-card border border-line bg-surface p-4 shadow-card">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-8 w-20" />
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="rounded-card border border-line bg-surface shadow-card lg:col-span-2">
          <div className="border-b border-line px-5 py-4">
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="divide-y divide-line">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3.5">
                <Skeleton className="h-4 w-16 shrink-0" />
                <div className="flex-1">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="mt-1.5 h-3 w-28" />
                </div>
                <Skeleton className="h-6 w-16 shrink-0 rounded-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-card border border-line bg-surface p-5 shadow-card">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-4 h-4 w-full" />
          <Skeleton className="mt-2.5 h-4 w-3/4" />
        </div>
      </div>
    </div>
  );
}
