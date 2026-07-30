-- CLINIC OS · patient document signing
--
-- A document is a frozen thing. Once it is sent (or in-person signing begins)
-- the rendered content, its hash, and every merged value stop tracking their
-- sources: editing a template, renaming a field, or correcting a patient record
-- afterwards must never change what somebody already put their name to. That is
-- why `documents.content_snapshot` and `document_field_values` exist alongside
-- the live template and the live patient row rather than being derived from them.

------------------------------------------------------------------------------
-- Field definitions: the single source of truth for what a patient record holds
-- and, therefore, what merge variables a template can use.
------------------------------------------------------------------------------

-- `key` is the merge token exactly as it appears between the braces, so the
-- template editor, the preview and the renderer all agree without a mapping
-- table. Patient-scoped keys are namespaced `patient.*`; everything the clinic
-- does not store per patient (clinic details, the booked service, today's date)
-- lives under its own prefix and is resolved from context at merge time.
create table patient_field_definitions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  scope text not null default 'patient' check (scope in ('patient', 'context')),
  key text not null,
  label text not null,
  label_ar text,
  field_type text not null default 'text'
    check (field_type in ('text', 'number', 'date', 'phone', 'email', 'select', 'checkbox', 'longtext')),
  options jsonb not null default '[]',
  is_required boolean not null default false,
  -- System fields can be renamed and hidden but never deleted: the platform
  -- reads them by key (phone is the patient identity rule, birth date decides
  -- whether a guardian must sign).
  is_system boolean not null default false,
  hidden boolean not null default false,
  show_in_profile boolean not null default true,
  -- Exactly one of these is set for system fields. `source_column` names a real
  -- column on `patients`; `source_path` names a value resolved from the document
  -- context (clinic, doctor, service, appointment, today).
  source_column text,
  source_path text,
  -- Where a non-system patient value is stored inside patients.custom_fields.
  storage_key text,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, key)
);
create index patient_field_defs_clinic_idx on patient_field_definitions (clinic_id, display_order);

-- Signer roles, so a clinic can go beyond the built-in six.
create table signer_roles (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,38}$'),
  label text not null,
  label_ar text,
  -- Staff roles are signed inside the workspace with a saved signature; the
  -- others are people who are handed a device or sent a link.
  is_staff boolean not null default false,
  is_system boolean not null default false,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, key)
);

------------------------------------------------------------------------------
-- Templates
------------------------------------------------------------------------------
create table document_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  name_ar text,
  category text not null default 'consent'
    check (category in ('consent', 'treatment_plan', 'financial', 'privacy', 'other')),
  source text not null default 'template' check (source in ('template', 'upload')),
  -- Rich text with {{merge.tokens}}. Both languages are held so one template
  -- serves an Arabic and an English patient; `language` says which are authored.
  body text not null default '',
  body_ar text not null default '',
  language text not null default 'both' check (language in ('ar', 'en', 'both')),
  -- Uploaded templates keep the original file plus its field placement.
  source_pdf_path text,
  -- { mode: 'sequential'|'parallel', signers: [{ role_key, required, order }] }
  signer_config jsonb not null default '{"mode":"sequential","signers":[{"role_key":"patient","required":true,"order":0}]}',
  -- Extra inputs collected from the signer at signing time.
  fields_schema jsonb not null default '[]',
  version integer not null default 1,
  is_active boolean not null default true,
  library_key text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index document_templates_clinic_idx on document_templates (clinic_id, is_active, category);

-- Every published edit, kept so a document can name the exact wording it froze.
create table document_template_versions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  template_id uuid not null references document_templates(id) on delete cascade,
  version integer not null,
  name text not null default '',
  body text not null default '',
  body_ar text not null default '',
  signer_config jsonb not null default '{}',
  fields_schema jsonb not null default '[]',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (template_id, version)
);

-- Consent forms a service always needs, so booking it can raise them.
create table service_documents (
  clinic_id uuid not null references clinics(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  template_id uuid not null references document_templates(id) on delete cascade,
  auto_send boolean not null default true,
  primary key (service_id, template_id)
);
create index service_documents_clinic_idx on service_documents (clinic_id);

------------------------------------------------------------------------------
-- Documents
------------------------------------------------------------------------------
create table documents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  -- Nullable: a document the clinic owner signs alone is still a document.
  patient_id uuid references patients(id) on delete cascade,
  template_id uuid references document_templates(id) on delete set null,
  template_version integer,
  source text not null default 'template' check (source in ('template', 'upload')),
  title text not null,
  language text not null default 'ar' check (language in ('ar', 'en')),
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'partially_signed', 'completed', 'declined', 'expired', 'voided')),
  signing_mode text not null default 'sequential' check (signing_mode in ('sequential', 'parallel')),
  -- Frozen at send time. Never recomputed.
  content_snapshot text,
  source_pdf_path text,
  final_pdf_path text,
  content_hash text,
  appointment_id uuid references appointments(id) on delete set null,
  service_id uuid references services(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  sent_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  declined_at timestamptz,
  void_reason text,
  voided_by uuid references users(id) on delete set null,
  voided_at timestamptz,
  -- A completed document is immutable; it can only be replaced by one that
  -- points back at it.
  supersedes_document_id uuid references documents(id) on delete set null,
  -- Held while a tablet is in a patient's hands, so a second staff member
  -- cannot open the same document at the same time.
  locked_by uuid references users(id) on delete set null,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_clinic_idx on documents (clinic_id, created_at desc);
create index documents_patient_idx on documents (patient_id, created_at desc);
create index documents_pending_idx on documents (clinic_id, status)
  where status in ('draft', 'sent', 'partially_signed');
create index documents_expiry_idx on documents (expires_at)
  where status in ('sent', 'partially_signed');
create index documents_appointment_idx on documents (appointment_id);

create table document_signers (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  role_key text not null,
  signing_order integer not null default 0,
  is_required boolean not null default true,
  display_name text not null default '',
  phone_e164 text,
  -- Set when the signer is a staff member; they sign inside the workspace.
  user_id uuid references users(id) on delete set null,
  relationship text,
  status text not null default 'pending'
    check (status in ('pending', 'viewed', 'signed', 'declined')),
  link_opened_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  signature_svg_path text,
  signature_png_path text,
  typed_name text,
  consent_confirmed boolean not null default false,
  decline_reason text,
  ip_address text,
  user_agent text,
  otp_verified_at timestamptz,
  signed_in_person boolean not null default false,
  witnessed_by_user_id uuid references users(id) on delete set null,
  -- Answers to the template's fields_schema, captured at signing time.
  field_answers jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index document_signers_doc_idx on document_signers (document_id, signing_order);
create index document_signers_user_idx on document_signers (user_id, status);

-- Placed boxes on an uploaded PDF. Stored as page-relative fractions (0-1) so
-- they survive any render scale.
create table document_fields (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  template_id uuid references document_templates(id) on delete cascade,
  page_number integer not null default 1,
  x numeric(8,6) not null,
  y numeric(8,6) not null,
  width numeric(8,6) not null,
  height numeric(8,6) not null,
  field_type text not null check (field_type in ('signature', 'initials', 'date', 'text', 'checkbox')),
  assigned_role_key text not null default 'patient',
  is_required boolean not null default true,
  label text not null default '',
  prefilled_value text,
  value text,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  check (document_id is not null or template_id is not null)
);
create index document_fields_doc_idx on document_fields (document_id, page_number, sort);
create index document_fields_template_idx on document_fields (template_id, page_number, sort);

-- Per-document values. The snapshot is rendered from these, not from the live
-- patient record, so a field renamed or corrected later never rewrites history.
create table document_field_values (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  field_key text not null,
  label text not null default '',
  label_ar text,
  value text not null default '',
  is_override boolean not null default false,
  is_one_off boolean not null default false,
  sort integer not null default 0,
  unique (document_id, field_key)
);
create index document_field_values_doc_idx on document_field_values (document_id, sort);

------------------------------------------------------------------------------
-- Audit trail. Append only, enforced by trigger — this is the record that makes
-- a signature defensible, so nothing in the application may rewrite it.
------------------------------------------------------------------------------
create table document_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  signer_id uuid references document_signers(id) on delete set null,
  event_type text not null check (event_type in (
    'created', 'sent', 'link_opened', 'otp_sent', 'otp_verified', 'viewed',
    'field_completed', 'signed', 'declined', 'reminder_sent', 'completed',
    'downloaded', 'voided', 'expired', 'revoked', 'resent', 'hash_mismatch',
    'locked', 'unlocked', 'superseded'
  )),
  actor_user_id uuid references users(id) on delete set null,
  actor_kind text not null default 'system' check (actor_kind in ('staff', 'signer', 'system', 'patient')),
  ip_address text,
  user_agent text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index document_events_doc_idx on document_events (document_id, created_at);

create or replace function document_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'document_events is append-only (attempted %)', tg_op
    using errcode = 'restrict_violation';
end $$;

create trigger document_events_no_update
  before update or delete on document_events
  for each row execute function document_events_append_only();

------------------------------------------------------------------------------
-- Signing links
------------------------------------------------------------------------------
create table signing_tokens (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  signer_id uuid not null references document_signers(id) on delete cascade,
  -- SHA-256 of the token. The token itself only ever exists in the WhatsApp
  -- message and the patient's address bar.
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index signing_tokens_signer_idx on signing_tokens (signer_id, created_at desc);

-- Resume support: where a signer stopped, including a half-drawn signature.
create table signing_sessions (
  signer_id uuid primary key references document_signers(id) on delete cascade,
  clinic_id uuid not null references clinics(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  last_step integer not null default 1,
  scrolled_to_end boolean not null default false,
  consent_confirmed boolean not null default false,
  partial_signature jsonb,
  field_answers jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

------------------------------------------------------------------------------
-- Agency-level starter library, copied into each new clinic.
------------------------------------------------------------------------------
create table document_template_library (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  name_ar text not null default '',
  category text not null default 'consent',
  body text not null default '',
  body_ar text not null default '',
  signer_config jsonb not null default '{}',
  fields_schema jsonb not null default '[]',
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

------------------------------------------------------------------------------
-- Staff signatures and the kiosk PIN
------------------------------------------------------------------------------
alter table users add column if not exists signature_svg_path text;
alter table users add column if not exists signature_png_path text;
-- Unlocks the in-clinic signing view after the tablet has been handed over.
-- Optional: with no PIN set, exiting falls back to re-entering the password.
alter table users add column if not exists kiosk_pin_hash text;

------------------------------------------------------------------------------
-- Per-clinic signing settings
------------------------------------------------------------------------------
-- Off by default and deliberately unadvertised: the link is single-use and only
-- ever lands in the patient's own WhatsApp thread, which is what establishes
-- identity. The code path stays available for a clinic that asks for it.
alter table clinics add column if not exists esign_require_code boolean not null default false;
alter table clinics add column if not exists esign_link_days integer not null default 7
  check (esign_link_days between 1 and 90);
alter table clinics add column if not exists esign_reminder_hours integer not null default 24;

------------------------------------------------------------------------------
-- The automation engine gains a step that sends a document.
------------------------------------------------------------------------------
alter table automation_steps drop constraint if exists automation_steps_step_type_check;
alter table automation_steps add constraint automation_steps_step_type_check
  check (step_type in ('send_whatsapp', 'wait', 'condition', 'add_tag', 'remove_tag',
                       'create_task', 'notify_staff', 'goto_automation', 'stop', 'send_document'));

-- Automation runs can now be keyed to a document.
alter table automation_runs add column if not exists document_id uuid references documents(id) on delete cascade;
drop index if exists automation_runs_dedupe;
create unique index automation_runs_dedupe
  on automation_runs (automation_id, patient_id, appointment_id, invoice_id, document_id)
  where status in ('running', 'waiting');

------------------------------------------------------------------------------
-- Tenant isolation, touch triggers, realtime
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'patient_field_definitions', 'signer_roles', 'document_templates',
    'document_template_versions', 'service_documents', 'documents',
    'document_signers', 'document_fields', 'document_field_values',
    'document_events', 'signing_tokens', 'signing_sessions'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
end $$;

-- The agency library is readable by every clinic (they copy from it) and
-- writable only by the agency.
alter table document_template_library enable row level security;
create policy doc_library_read on document_template_library for select to clinicos_app using (true);
create policy doc_library_write on document_template_library for all to clinicos_app
  using (app_is_admin()) with check (app_is_admin());

do $$
declare t text;
begin
  foreach t in array array[
    'patient_field_definitions', 'signer_roles', 'document_templates',
    'documents', 'document_signers', 'signing_sessions', 'document_template_library'
  ] loop
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()',
      t || '_touch', t);
  end loop;
end $$;

-- Status moves while staff are watching the list, so both tables emit.
create trigger documents_emit after insert or update or delete on documents
  for each row execute function emit_change();
create trigger document_signers_emit after insert or update or delete on document_signers
  for each row execute function emit_change();

------------------------------------------------------------------------------
-- Seed: field definitions and signer roles for every existing clinic.
------------------------------------------------------------------------------

-- The starting set. Patient-scoped system fields map to real columns on
-- `patients`; context fields resolve from the document's clinic, doctor,
-- service and appointment at merge time.
create or replace function seed_esign_defaults(p_clinic uuid) returns void language plpgsql as $$
begin
  insert into patient_field_definitions
    (clinic_id, scope, key, label, label_ar, field_type, is_required, is_system,
     show_in_profile, source_column, source_path, display_order)
  values
    (p_clinic, 'patient', 'patient.full_name',   'Full name',     'الاسم الكامل',    'text',  true,  true, true, 'full_name', null, 10),
    (p_clinic, 'patient', 'patient.phone',       'Phone',         'رقم الهاتف',      'phone', true,  true, true, 'phone_e164', null, 20),
    (p_clinic, 'patient', 'patient.national_id', 'National ID',   'الرقم الوطني',    'text',  false, true, true, null, null, 30),
    (p_clinic, 'patient', 'patient.birth_date',  'Date of birth', 'تاريخ الميلاد',   'date',  false, true, true, 'birth_date', null, 40),
    (p_clinic, 'patient', 'patient.gender',      'Gender',        'الجنس',           'select',false, true, true, 'gender', null, 50),
    (p_clinic, 'patient', 'patient.address',     'Address',       'العنوان',         'text',  false, true, true, null, null, 60),
    (p_clinic, 'context', 'clinic.name',         'Clinic name',   'اسم العيادة',     'text',  false, true, false, null, 'clinic.name', 70),
    (p_clinic, 'context', 'clinic.address',      'Clinic address','عنوان العيادة',   'text',  false, true, false, null, 'clinic.address', 80),
    (p_clinic, 'context', 'clinic.phone',        'Clinic phone',  'هاتف العيادة',    'phone', false, true, false, null, 'clinic.phone', 90),
    (p_clinic, 'context', 'doctor.name',         'Doctor name',   'اسم الطبيب',      'text',  false, true, false, null, 'doctor.name', 100),
    (p_clinic, 'context', 'service.name',        'Service',       'الخدمة',          'text',  false, true, false, null, 'service.name', 110),
    (p_clinic, 'context', 'service.price',       'Service price', 'سعر الخدمة',      'text',  false, true, false, null, 'service.price', 120),
    (p_clinic, 'context', 'appointment.date',    'Appointment date','تاريخ الموعد',  'date',  false, true, false, null, 'appointment.date', 130),
    (p_clinic, 'context', 'today',               'Today''s date', 'تاريخ اليوم',     'date',  false, true, false, null, 'today', 140)
  on conflict (clinic_id, key) do nothing;

  -- Gender is a choice list everywhere it appears.
  update patient_field_definitions
     set options = '["male","female"]'::jsonb
   where clinic_id = p_clinic and key = 'patient.gender';

  -- Anything the clinic already added as a custom patient field becomes a
  -- definition too, so the two never disagree.
  insert into patient_field_definitions
    (clinic_id, scope, key, label, label_ar, field_type, options, storage_key, display_order)
  select
    d.clinic_id, 'patient', 'patient.' || d.key, d.label, d.label_ar,
    case d.field_type
      when 'select' then 'select'
      when 'boolean' then 'checkbox'
      when 'number' then 'number'
      when 'date' then 'date'
      else 'text'
    end,
    d.options, d.key, 200 + d.sort
  from custom_field_defs d
  where d.clinic_id = p_clinic
  on conflict (clinic_id, key) do nothing;

  insert into signer_roles (clinic_id, key, label, label_ar, is_staff, is_system, display_order)
  values
    (p_clinic, 'patient',              'Patient',               'المريض',            false, true, 10),
    (p_clinic, 'guardian',             'Guardian',              'ولي الأمر',         false, true, 20),
    (p_clinic, 'doctor',               'Doctor',                'الطبيب',            true,  true, 30),
    (p_clinic, 'clinic_owner',         'Clinic owner',          'مالك العيادة',      true,  true, 40),
    (p_clinic, 'clinic_representative','Clinic representative', 'ممثل العيادة',      true,  true, 50),
    (p_clinic, 'witness',              'Witness',               'شاهد',              false, true, 60)
  on conflict (clinic_id, key) do nothing;
end $$;

do $$
declare c record;
begin
  for c in select id from clinics loop
    perform seed_esign_defaults(c.id);
  end loop;
end $$;
