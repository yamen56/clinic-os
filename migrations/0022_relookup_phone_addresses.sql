-- Ask WhatsApp again for every number we addressed the old way.
--
-- `onWhatsApp` answers with both the legacy `<phone>@s.whatsapp.net` and the
-- account's LID, and we were keeping the wrong one. WhatsApp has moved these
-- accounts onto LID addressing, so the legacy address no longer routes: the
-- socket accepts the message, hands back an id, and nothing is delivered.
--
-- That is why messages to numbers which had written to the clinic arrived and
-- messages to numbers which had not never did — the first kind had a LID we had
-- captured from their message, the second only ever had a phone address we had
-- resolved and stored.
--
-- Clearing the check forces the next send to look the number up again and keep
-- the LID this time. The lookup is one round trip per conversation and only
-- happens on the next message to it.

update conversations
   set wa_checked_at = null,
       on_whatsapp = null
 where identifier_kind = 'phone'
   and wa_lid is null;

-- Anything still sitting at 'sent' with no acknowledgement was addressed the
-- old way. Sending it again costs one message and is the only way it arrives;
-- leaving it means a document or reminder the patient never got. Bounded to a
-- day so this cannot resurrect a week of history.
update messages m
   set status = 'queued', error = null, scheduled_at = now()
  from conversations cv
 where cv.id = m.conversation_id
   and cv.identifier_kind = 'phone'
   and cv.wa_lid is null
   and m.direction = 'out'
   and m.status = 'sent'
   and m.delivered_at is null
   and m.created_at > now() - interval '24 hours';
