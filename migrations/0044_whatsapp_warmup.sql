-- A new WhatsApp number does not get to send three hundred messages on its
-- first day.
--
-- Sending bulk from a freshly registered number is the classic pattern WhatsApp
-- bans for, and until now nothing stopped it: a clinic that linked a brand-new
-- SIM could hit the full `daily_outbound_cap` within hours of scanning the QR.
-- The existing rails — randomised delays, the blast guard, auto-pause on errors
-- — all shape *how* messages go out. None of them cares how old the number is,
-- which is the single strongest predictor of whether it survives.
--
-- Anchored to the number rather than to the clinic, because that is what gets
-- banned. A clinic that switches to a different number starts a fresh ramp;
-- one that reconnects the same number after an outage does not.

alter table whatsapp_sessions
  add column if not exists warmup_number     text,
  add column if not exists warmup_started_at timestamptz;

/*
  Every number already in use is, by definition, already warm — it has been
  sending for weeks under the old rules and has the reputation to show for it.
  Backfilling from `connected_at` would be wrong in the one direction that
  hurts: that column is rewritten on every reconnect, so a long-established
  clinic that happened to reconnect yesterday would be throttled to twenty
  messages today for no reason at all.

  So: treat what exists as warm, and let the ramp apply to numbers linked from
  here on. Setting warmup_number to the current phone is what makes that work —
  the session handler resets the ramp only when the connected number differs
  from this, so an existing clinic reconnecting is untouched and a new number is
  not.
*/
update whatsapp_sessions
   set warmup_started_at = now() - interval '60 days',
       warmup_number     = phone_number
 where warmup_started_at is null;
