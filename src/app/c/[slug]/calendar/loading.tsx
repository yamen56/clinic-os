import { Skeleton } from "@/components/ui/misc";
import { BoardOutline } from "./flow/board-outline";

/**
 * Patients today, because that is what the calendar opens on.
 *
 * It used to draw a week: seven days side by side on a computer and, on a
 * phone, seven of them stacked — a page several screens tall, under a header
 * wider than the screen — which then became the Today board (Yamen,
 * 2026-11-15: "the loading is not in the right proportions"). The calendar
 * has opened on Today since the board came (calendar/page.tsx), so this is
 * its tabs over the board's own outline, which the board shows too while it
 * fetches the day: one shape from the tap to the patients.
 *
 * A link about the calendar (a visit to open, a patient to book) opens the
 * Schedule instead; its moment of this outline is far shorter than the week
 * was tall on a phone, which is the trade this makes.
 */
export default function Loading() {
  return (
    <div className="animate-fade-in">
      {/* The tabs: Today, Schedule, Waitlist. */}
      <div className="mb-4 grid grid-cols-3 gap-2 border-b border-line pb-3 sm:flex sm:gap-6">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="mx-auto h-5 w-20 sm:mx-0" />
        ))}
      </div>
      <BoardOutline />
    </div>
  );
}
