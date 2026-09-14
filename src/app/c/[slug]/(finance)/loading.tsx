import { Skeleton } from "@/components/ui/misc";

/**
 * Covers only the content below the tab strip, which stays mounted across the
 * switch — the same reason `settings/loading.tsx` exists. Without this file Next
 * holds the previous tab on screen until the next one has finished its queries,
 * and a month of invoices is long enough that pressing Earnings looks like
 * pressing nothing.
 *
 * Shaped like what these three screens actually have in common: a header with an
 * action on the right, a row of figures, and a list.
 */
export default function Loading() {
  return (
    <div className="animate-fade-in">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="mt-2 h-3 w-52" />
        </div>
        <Skeleton className="h-9 w-28 rounded-ctl" />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-card border border-line bg-surface p-4 shadow-card">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-6 w-24" />
          </div>
        ))}
      </div>
      <div className="rounded-card border border-line bg-surface shadow-card">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5 last:border-b-0">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="mt-2 h-3 w-24" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
