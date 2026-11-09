-- Every outbound WhatsApp message either arrives or says why it did not.
--
-- wa_payload: the exact message WhatsApp was handed, as the encoded proto.
-- When a patient's phone cannot decrypt something we sent it asks for it
-- again, and the worker has to re-encrypt the same content. Text can be
-- rebuilt from `body`; a picture, video or document cannot — it needs the
-- uploaded media's key and address — so until now every such retry went
-- unanswered and the patient saw "Waiting for this message" for good. Kept
-- only for media, which is what cannot be rebuilt.
--
-- resent_at: staff pressed "Send again" on a message that failed, was not
-- sent, or never reached the phone. The copy is a new row; this one keeps its
-- reason and stops offering the button.
alter table messages add column if not exists wa_payload bytea;
alter table messages add column if not exists resent_at timestamptz;

-- An automation's history now shows what became of each message it sent, so
-- the runs page looks messages up by run.
create index if not exists messages_automation_run_idx
  on messages (automation_run_id) where automation_run_id is not null;
