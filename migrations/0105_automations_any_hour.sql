-- Automations send at any hour (Yamen, 2026-11-10).
--
-- Until now an automation's message waited for the clinic's sending window
-- (09:00–21:00 by default) and was queued with `scheduled_at` set to the next
-- opening. The worker no longer does that, but messages already queued that
-- way would still sit until the morning. Release them now.
--
-- Only automation messages held for the window: a message held by a rail says
-- so in `error` (held:daily_cap, held:warmup_cap, held:blast_guard, see
-- lib/wa-delivery) and keeps its time. One deferred by the daily cap before
-- those reasons existed has no error; releasing it costs nothing, because the
-- outbox checks the cap again and puts it back with the reason. The outbox
-- also still cancels any whose appointment has already begun.
update messages
   set scheduled_at = now()
 where status = 'queued'
   and sender_kind = 'automation'
   and direction = 'out'
   and scheduled_at > now()
   and error is null;
