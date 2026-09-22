import { Skeleton } from "@/components/ui/misc";

/**
 * Two panes, because the inbox is two panes.
 *
 * This is the screen a receptionist lives in, and it is the one that most
 * needed its own shape: it borrowed the dashboard's four stat tiles, which look
 * nothing like a thread list beside a conversation.
 *
 * The thread list is the taller half of the illusion, so it gets real rows. The
 * message pane gets alternating bubble widths rather than a block, because a
 * conversation is visibly lopsided and a centred grey box is not what lands.
 */
export default function Loading() {
  return (
    <div className="animate-fade-in grid h-[calc(100vh-11rem)] grid-cols-1 gap-4 md:grid-cols-[22rem_1fr]">
      <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <div className="border-b border-line px-4 py-3">
          <Skeleton className="h-9 w-full rounded-ctl" />
        </div>
        <div className="divide-y divide-line">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-1.5 h-3 w-40" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Hidden on a phone, where the list and the thread are separate screens. */}
      <div className="hidden flex-col rounded-card border border-line bg-surface shadow-card md:flex">
        <div className="border-b border-line px-5 py-3.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="mt-1.5 h-3 w-24" />
        </div>
        <div className="flex-1 space-y-3 p-5">
          {/*
            Written out rather than built from numbers: Tailwind generates
            utilities by scanning the source for literal class names, so a
            width composed at runtime produces no CSS at all and every bubble
            would come out the same size.
          */}
          {["w-[62%]", "w-[44%]", "w-[70%]", "w-[38%]", "w-[55%]"].map((w, i) => (
            <div key={i} className={i % 2 ? "flex justify-end" : "flex"}>
              <Skeleton className={`h-12 rounded-card ${w}`} />
            </div>
          ))}
        </div>
        <div className="border-t border-line p-4">
          <Skeleton className="h-11 w-full rounded-ctl" />
        </div>
      </div>
    </div>
  );
}
