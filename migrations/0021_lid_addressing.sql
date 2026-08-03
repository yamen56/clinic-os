-- Reply to the address the message came from.
--
-- WhatsApp now addresses many chats by a "LID" — an opaque identity like
-- 191091802390675@lid — instead of the sender's phone number. We were matching
-- the digits out of any JID, calling them a phone number, and then *rebuilding*
-- the address as <digits>@s.whatsapp.net. That address does not exist. The
-- socket accepts the send without complaint and the message goes nowhere, which
-- is why documents, invoices and automation messages appeared in the thread and
-- never arrived on the phone.
--
-- The conversation now remembers the real JID and the LID, and outbound sends
-- to the JID WhatsApp itself gave us.

alter table conversations
  add column if not exists wa_lid text,
  -- Whether `phone_e164` is a real dialable number or a LID stood in for one,
  -- so nothing tries to check, dial or match a patient against an identity.
  add column if not exists identifier_kind text not null default 'phone'
    check (identifier_kind in ('phone', 'lid'));

create index if not exists conversations_wa_lid_idx
  on conversations (clinic_id, wa_lid) where wa_lid is not null;

/*
  Repair the threads already broken by this.

  A LID is 14+ digits; E.164 allows 15 but numbers that long do not occur in
  this market — Jordan, the Gulf and Egypt are all 11 to 13 including the
  country code. The app corrects itself on the next inbound message anyway, so
  the only cost of a mistake here is one round trip; the benefit is that a
  thread with 55 messages in it can be replied to today.
*/
update conversations
   set wa_lid = regexp_replace(phone_e164, '^\+', ''),
       wa_jid = regexp_replace(phone_e164, '^\+', '') || '@lid',
       identifier_kind = 'lid',
       -- These were checked against WhatsApp as if they were phone numbers and
       -- came back "no such account", which is true and beside the point.
       on_whatsapp = null,
       wa_checked_at = null
 where phone_e164 ~ '^\+\d{14,}$';

-- The messages we gave up on for that reason are worth another try; they were
-- never actually undeliverable, only addressed wrongly.
update messages m
   set status = 'queued', error = null, attempts = 0, scheduled_at = now()
  from conversations cv
 where cv.id = m.conversation_id
   and cv.identifier_kind = 'lid'
   and m.direction = 'out'
   and m.status = 'failed'
   and m.error = 'no_whatsapp_account';
