import { Skeleton } from "@/components/ui/misc";

/** Instant feedback for agency routes — see the workspace loading file for why. */
export default function Loading() {
  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-end justify-between gap-3">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-10 w-32 rounded-ctl" />
      </div>
      <div className="rounded-card border border-line bg-surface shadow-card">
        <div className="divide-y divide-line">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4">
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="mt-1.5 h-3 w-32" />
              </div>
              <Skeleton className="h-6 w-20 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
