-- E-sign, 2026-11-21 (Yamen): "we want them to be able to sign at the same
-- time, we don't want that order of signing; and the doctor should be notified
-- to sign, or he can be signed automatically, because mostly there is no need
-- for him to sign every time".

-- 1. Everyone signs at once. New documents are parallel; templates say so too,
--    so the editor never offers an order again. Documents already out for
--    signature keep the order they were sent with: switching them would put
--    later signers' links in nobody's hands without a message.
alter table document_templates
  alter column signer_config set default '{"mode":"parallel","signers":[{"role_key":"patient","required":true,"order":0}]}';
update document_templates
   set signer_config = jsonb_set(coalesce(signer_config, '{}'::jsonb), '{mode}', '"parallel"')
 where coalesce(signer_config->>'mode', 'sequential') <> 'parallel';
update document_template_library
   set signer_config = jsonb_set(coalesce(signer_config, '{}'::jsonb), '{mode}', '"parallel"')
 where coalesce(signer_config->>'mode', 'sequential') <> 'parallel';
alter table documents alter column signing_mode set default 'parallel';
update documents set signing_mode = 'parallel' where status = 'draft' and signing_mode <> 'parallel';

-- 2. A staff member's standing instruction: "apply my saved signature to any
--    document that needs my signature here". Per clinic, because a doctor who
--    works in two clinics may want it in one and not the other. Only the member
--    can switch it on for themselves — never an owner for them — and it only
--    acts while a saved signature exists. RLS does not protect the column
--    (members_access admits any member to every row of the clinic), so
--    setMyAutoSignAction writes only `id = my member id and user_id = me`.
alter table clinic_members
  add column if not exists auto_sign_documents boolean not null default false;

-- 3. Which signatures were applied by that instruction rather than by a tap,
--    so the document, the certificate and the audit trail can say so.
alter table document_signers
  add column if not exists signed_automatically boolean not null default false;
