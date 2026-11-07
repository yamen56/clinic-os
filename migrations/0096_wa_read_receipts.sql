-- Reading a patient's message in the app tells WhatsApp it was read, as reading it
-- on the clinic's phone does (Yamen, 2026-11-07: "go ahead").
--
-- A read receipt must go back to the chat the message arrived on, and a thread's
-- stored address can since have moved between the patient's number and their LID.
-- So each patient message keeps the address it came from, verbatim. Older messages
-- have none and fall back to the thread's.
alter table messages add column if not exists wa_remote_jid text;
