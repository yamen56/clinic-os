-- 0052: a repeating bill counts in the month it falls in.
--
-- The poster used to wait for the due day to arrive, and a new rule was created
-- with `last_posted_on` set to today so that the current month was skipped —
-- both in the name of not duplicating a bill the clinic had already entered by
-- hand. Together they meant a rule described on the 14th for "the 13th" did
-- nothing at all for six weeks, and the month's expenses did not include a bill
-- the owner had just entered. A bill belongs to the month it falls in whatever
-- day it lands on, so the poster now writes the month's occurrence as soon as
-- the month is current.
--
-- This leaves the rules already carrying that suppression marker. For those,
-- `last_posted_on` is not a record of anything having been posted — it is the
-- opposite, a note saying "do not post". Clearing it lets this month post.
--
-- Only where nothing was ever posted. A schedule with expenses behind it has a
-- `last_posted_on` that means what it says, and clearing that would bill the
-- same month twice.

update expense_schedules s
   set last_posted_on = null
 where s.last_posted_on is not null
   and not exists (select 1 from expenses e where e.schedule_id = s.id);
