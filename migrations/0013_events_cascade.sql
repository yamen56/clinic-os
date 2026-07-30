-- Let the audit trail be removed *with* the document it describes, and only then.
--
-- The append-only trigger from 0010 rejected every DELETE, which also rejected
-- the cascade — so deleting a patient, or a whole clinic, failed with
-- "document_events is append-only". That is not a stricter guarantee, it is a
-- broken one: a tenant could never be removed, and the existing QA suites all
-- tear their fixture clinics down.
--
-- The guarantee that actually matters is that *while a document exists*, its
-- history cannot be edited or trimmed. So: UPDATE is refused always, and DELETE
-- is refused unless the parent document has already gone — which is only true
-- inside a cascade, because PostgreSQL removes the referenced row before it
-- cascades to the referencing rows. A targeted `delete from document_events`
-- still fails, which is the case the trigger exists to stop.

create or replace function document_events_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'document_events is append-only (UPDATE is never permitted)'
      using errcode = 'restrict_violation';
  end if;

  -- Cascade: the document (or its clinic, or its patient) is being removed, and
  -- the parent row is already gone by the time this fires.
  if not exists (select 1 from documents where id = old.document_id) then
    return old;
  end if;

  raise exception 'document_events is append-only (a row cannot be deleted while its document exists)'
    using errcode = 'restrict_violation';
end $$;
