import { DateTime } from "luxon";
import { withSystem } from "./db";
import { licensed } from "./features";

/*
  Its own module rather than one more function in the scheduler, and not only
  for tidiness: worker/scheduler.ts reaches the WhatsApp session store, which
  pulls in Baileys, which breaks Node's resolver the moment a test tries to
  load it. Keeping the poster here lets the QA suite drive the real thing
  rather than a copy of its logic.
*/
/**
 * Repeating bills — rent, salaries, subscriptions.
 *
 * Driven by stored state rather than by the clock, which is the one thing that
 * matters here. Every other daily job in this file gates on an exact hour with
 * two minutes of slack, and that is right for a reminder: a missed one is stale
 * by tomorrow anyway. Rent is not. And the tick is scheduled 60s *after* the
 * previous pass finishes, so its phase walks forward all day — `dailyBackup`
 * carries a comment about exactly this ("a skipped minute was a skipped day").
 * The same gate here would turn a skipped minute into a skipped *month*, and
 * nobody would notice until the books were short.
 *
 * So the decision is a compare-and-swap on `last_posted_on`, in the same
 * transaction as the insert:
 *
 *   - two workers race, and the `update` returns a row to exactly one of them
 *     (a deploy always overlaps two, so this is the normal case, not the edge);
 *   - a crash between the update and the insert rolls back both;
 *   - a worker down across the due date still catches up, because `due <= today`
 *     stays true tomorrow.
 *
 * It does **not** backfill. Only the current month's occurrence is considered,
 * so a worker down for three months wakes up and posts one rent, not three.
 * Three months of rows nobody checked would rewrite the profit of months the
 * owner has already read and acted on.
 */
export async function postRecurringExpenses() {
  await withSystem(async (c) => {
    const rows = (
      await c.query(
        `select s.id, s.clinic_id, s.category_id, s.amount, s.vendor, s.note,
                s.method, s.day_of_month, s.last_posted_on, cl.timezone
           from expense_schedules s
           join clinics cl on cl.id = s.clinic_id
          where s.active and ${licensed("invoices", "cl")}`
      )
    ).rows;

    for (const s of rows) {
      const local = DateTime.now().setZone(s.timezone);
      // An invalid timezone yields an invalid DateTime. Skip that clinic rather
      // than throwing the whole tick for everybody else.
      if (!local.isValid) continue;

      /*
        This month's occurrence, clamped to the month's own length — so a rule
        that says "the 31st" means the 28th in February rather than never firing,
        which is what somebody choosing 31 meant by it.
      */
      const day = Math.min(Number(s.day_of_month), local.daysInMonth ?? 28);
      const due = local.set({ day }).toISODate();
      if (!due || local.toISODate()! < due) continue;

      /*
        The whole concurrency story, in one statement. Only the worker whose
        update actually moves the row gets to insert, and the insert rides in
        the same transaction.
      */
      const claimed = await c.query(
        `update expense_schedules
            set last_posted_on = $2::date
          where id = $1 and active
            and (last_posted_on is null or last_posted_on < $2::date)
          returning id`,
        [s.id, due]
      );
      if (!claimed.rowCount) continue;

      /*
        A frozen copy, not a live reference: what the rule says today is what
        this month cost, and editing it next week is a statement about next
        month. `spent_on` is the due date rather than today, so a post that
        lands two days late is still dated correctly.
      */
      await c.query(
        `insert into expenses
           (clinic_id, category_id, schedule_id, amount, vendor, note, spent_on, method)
         values ($1, $2, $3, $4, $5, $6, $7::date, $8)
         on conflict do nothing`,
        [s.clinic_id, s.category_id, s.id, s.amount, s.vendor, s.note, due, s.method]
      );
      console.log(`[expenses] posted ${s.vendor || "recurring"} for ${s.clinic_id} on ${due}`);
    }
  });
}
