-- A message is not a patient.
--
-- Every inbound WhatsApp message created a patient file, so the patient list
-- filled with anyone who ever texted the clinic — wrong numbers, suppliers,
-- someone asking the price. The list is meant to be the clinic's patients: the
-- ones staff added, the AI booked, or who came through the booking link.
--
-- The conversation keeps the thread either way. What it needs is somewhere of
-- its own to remember the sender's WhatsApp name, which until now was borrowed
-- from the patient row that this change stops creating.

alter table conversations add column if not exists whatsapp_name text;

-- Carry across the names already learned, so existing threads keep their
-- titles instead of falling back to a bare number.
update conversations c
   set whatsapp_name = p.whatsapp_name
  from patients p
 where p.id = c.patient_id
   and c.whatsapp_name is null
   and p.whatsapp_name is not null;
