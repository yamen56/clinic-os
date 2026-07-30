import { Skeleton } from "@/components/ui/misc";

/**
 * Covers only the settings content pane — the layout, and with it the tab
 * strip, stays mounted across the switch. Without this file Next holds the
 * previous settings screen until the next one has finished rendering, which is
 * what made moving between tabs feel like nothing had happened.
 */
export default function Loading() {
  return (
    <div className="animate-fade-in rounded-card border border-line bg-surface shadow-card">
      <div className="border-b border-line px-5 py-4">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="mt-2 h-3 w-56" />
      </div>
      <div className="grid gap-5 p-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-2 h-10 w-full rounded-ctl" />
          </div>
        ))}
        <Skeleton className="h-10 w-32 rounded-ctl" />
      </div>
    </div>
  );
}
