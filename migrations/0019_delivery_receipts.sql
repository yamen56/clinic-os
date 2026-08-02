-- Delivery receipts, and knowing whether a number is on WhatsApp at all.
--
-- Outbound messages stopped at 'sent' — the moment the socket accepted them.
-- The inbox already draws a second tick for 'delivered' and 'read', but nothing
-- ever wrote those, so every message looked equally successful whether it
-- arrived or vanished into a mistyped number.

alter table messages
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz;

-- Answering "how much of what we sent this week actually landed" without a
-- sequential scan of the clinic's whole history.
create index if not exists messages_delivery_idx
  on messages (clinic_id, created_at desc)
  where direction = 'out';

-- Whether the number on the other end has WhatsApp. Checked against the
-- servers once and remembered, because asking on every send is both slow and
-- exactly the sort of repeated lookup that gets a number rate-limited.
alter table conversations
  add column if not exists on_whatsapp boolean,
  add column if not exists wa_checked_at timestamptz;
