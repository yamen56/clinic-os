-- CLINIC OS · initial schema
-- Runs as superuser; the app connects as `clinicos_app` (no BYPASSRLS) so RLS applies.

create extension if not exists pgcrypto;

------------------------------------------------------------------------------
-- App role (cluster-level, guarded)
------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'clinicos_app') then
    create role clinicos_app login password 'clinicos_app' nosuperuser nobypassrls;
  end if;
end $$;

------------------------------------------------------------------------------
-- Session context helpers. The app sets these per transaction:
--   app.user_id, app.clinic_id, app.role, app.is_admin
------------------------------------------------------------------------------
create or replace function app_user_id() returns uuid language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function app_clinic_id() returns uuid language sql stable as
$$ select nullif(current_setting('app.clinic_id', true), '')::uuid $$;

create or replace function app_role() returns text language sql stable as
$$ select nullif(current_setting('app.role', true), '') $$;

create or replace function app_is_admin() returns boolean language sql stable as
$$ select coalesce(current_setting('app.is_admin', true), '') = 'true' $$;

------------------------------------------------------------------------------
-- Identity & tenancy
------------------------------------------------------------------------------
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  full_name text not null,
  phone_e164 text,
  is_super_admin boolean not null default false,
  locale text not null default 'ar' check (locale in ('ar', 'en')),
  avatar_url text,
  notification_prefs jsonb not null default '{}',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references users(id) on delete cascade,
  impersonated_by uuid references users(id) on delete cascade,
  expires_at timestamptz not null,
  user_agent text,
  ip text,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

create table clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_ar text,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  logo_path text,
  brand_color text not null default '#0f6e5c',
  address text,
  address_ar text,
  phone_e164 text,
  google_maps_url text,
  timezone text not null default 'Asia/Amman',
  default_locale text not null default 'ar' check (default_locale in ('ar', 'en')),
  working_hours jsonb not null default '{"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[],"sat":[["09:00","17:00"]],"sun":[["09:00","17:00"]]}',
  blocked_dates jsonb not null default '[]',
  subscription_status text not null default 'trial' check (subscription_status in ('trial', 'active', 'past_due', 'suspended')),
  plan text not null default 'standard',
  plan_price numeric(10,2) not null default 0,
  currency text not null default 'JOD',
  invoice_prefix text not null default 'INV',
  invoice_counter integer not null default 0,
  invoice_tax_rate numeric(5,2) not null default 0,
  invoice_tax_label text not null default '',
  invoice_footer text not null default '',
  payment_instructions text not null default '',
  message_window_start time not null default '09:00',
  message_window_end time not null default '21:00',
  daily_outbound_cap integer not null default 300,
  ai_paused_minutes integer not null default 30,
  onboarding jsonb not null default '{}',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table clinic_members (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'doctor', 'receptionist')),
  title text,
  specialty text,
  color text not null default '#0f6e5c',
  permissions jsonb not null default '{}',
  working_hours jsonb,
  reminder_minutes integer not null default 30,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, user_id)
);
create index clinic_members_user_idx on clinic_members (user_id);

------------------------------------------------------------------------------
-- Patients
------------------------------------------------------------------------------
create table patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  full_name text not null,
  phone_e164 text,
  secondary_phone_e164 text,
  extra_phones text[] not null default '{}',
  whatsapp_name text,
  birth_date date,
  gender text check (gender in ('male', 'female')),
  tags text[] not null default '{}',
  source text not null default 'staff' check (source in ('staff', 'booking_link', 'whatsapp', 'ai_agent', 'import')),
  status text not null default 'active' check (status in ('lead', 'active', 'archived')),
  notes_summary text not null default '',
  custom_fields jsonb not null default '{}',
  merged_into uuid references patients(id),
  last_visit_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index patients_phone_key on patients (clinic_id, phone_e164)
  where phone_e164 is not null and merged_into is null;
create index patients_clinic_idx on patients (clinic_id, created_at desc);
create index patients_tags_idx on patients using gin (tags);

create table custom_field_defs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  key text not null,
  label text not null,
  label_ar text,
  field_type text not null default 'text' check (field_type in ('text', 'number', 'date', 'select', 'boolean')),
  options jsonb not null default '[]',
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (clinic_id, key)
);

create table patient_notes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  appointment_id uuid,
  kind text not null default 'clinical' check (kind in ('clinical', 'admin')),
  body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index patient_notes_patient_idx on patient_notes (patient_id, created_at desc);

create table patient_files (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  uploaded_by uuid references users(id) on delete set null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  storage_path text not null,
  kind text not null default 'other' check (kind in ('xray', 'lab', 'consent', 'photo', 'other')),
  created_at timestamptz not null default now()
);
create index patient_files_patient_idx on patient_files (patient_id, created_at desc);

------------------------------------------------------------------------------
-- Services & appointments
------------------------------------------------------------------------------
create table services (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  name_ar text,
  description text,
  duration_min integer not null default 30 check (duration_min > 0),
  price numeric(10,2) not null default 0,
  color text not null default '#0f6e5c',
  bookable_online boolean not null default true,
  buffer_after_min integer not null default 0,
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index services_clinic_idx on services (clinic_id, sort);

create table service_doctors (
  service_id uuid not null references services(id) on delete cascade,
  member_id uuid not null references clinic_members(id) on delete cascade,
  clinic_id uuid not null references clinics(id) on delete cascade,
  primary key (service_id, member_id)
);

create table appointments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  doctor_member_id uuid references clinic_members(id) on delete set null,
  service_id uuid references services(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('pending_approval', 'scheduled', 'confirmed', 'completed', 'no_show', 'cancelled')),
  source text not null default 'staff' check (source in ('staff', 'booking_link', 'ai_agent')),
  notes text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index appointments_clinic_time_idx on appointments (clinic_id, starts_at);
create index appointments_doctor_time_idx on appointments (doctor_member_id, starts_at);
create index appointments_patient_idx on appointments (patient_id, starts_at desc);

alter table patient_notes
  add constraint patient_notes_appointment_fk
  foreign key (appointment_id) references appointments(id) on delete set null;

create table booking_links (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  slug text not null unique,
  name text not null default 'Default',
  doctor_member_id uuid references clinic_members(id) on delete cascade,
  service_ids uuid[] not null default '{}',
  min_notice_min integer not null default 120,
  max_days_ahead integer not null default 30,
  slot_granularity_min integer not null default 30,
  approval_mode text not null default 'instant' check (approval_mode in ('instant', 'approval')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

------------------------------------------------------------------------------
-- Conversations & messages (WhatsApp)
------------------------------------------------------------------------------
create table conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid references patients(id) on delete set null,
  phone_e164 text not null,
  wa_jid text,
  status text not null default 'open' check (status in ('open', 'closed')),
  assigned_to uuid references users(id) on delete set null,
  ai_enabled boolean not null default true,
  ai_paused_until timestamptz,
  unread_count integer not null default 0,
  flagged boolean not null default false,
  flag_reason text,
  last_message_at timestamptz,
  last_message_preview text,
  last_message_direction text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, phone_e164)
);
create index conversations_clinic_idx on conversations (clinic_id, last_message_at desc nulls last);

create table messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  sender_kind text not null default 'patient' check (sender_kind in ('patient', 'staff', 'automation', 'ai', 'system')),
  sender_user_id uuid references users(id) on delete set null,
  wa_message_id text,
  msg_type text not null default 'text' check (msg_type in ('text', 'image', 'audio', 'document', 'video', 'sticker', 'location', 'unknown')),
  body text not null default '',
  media_path text,
  media_mime text,
  media_name text,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
  error text,
  automation_run_id uuid,
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index messages_conversation_idx on messages (conversation_id, created_at);
create index messages_outbox_idx on messages (status, scheduled_at) where status = 'queued';
create unique index messages_wa_id_key on messages (clinic_id, wa_message_id) where wa_message_id is not null;

create table quick_replies (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  title text not null,
  body text not null,
  sort integer not null default 0
);

create table whatsapp_sessions (
  clinic_id uuid primary key references clinics(id) on delete cascade,
  status text not null default 'disconnected' check (status in ('disconnected', 'connecting', 'qr', 'connected', 'logged_out')),
  qr text,
  phone_number text,
  display_name text,
  connected_at timestamptz,
  last_seen_at timestamptz,
  error text,
  desired boolean not null default false,
  outbound_today integer not null default 0,
  outbound_date date,
  paused_until timestamptz,
  consecutive_errors integer not null default 0,
  updated_at timestamptz not null default now()
);

create table whatsapp_auth_state (
  clinic_id uuid not null references clinics(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (clinic_id, key)
);

------------------------------------------------------------------------------
-- Invoices & payments
------------------------------------------------------------------------------
create table invoices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  appointment_id uuid references appointments(id) on delete set null,
  seq integer not null,
  number text not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'partially_paid', 'paid', 'void')),
  currency text not null default 'JOD',
  subtotal numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  tax_rate numeric(5,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  notes text not null default '',
  public_token text not null unique default encode(gen_random_bytes(16), 'hex'),
  pdf_path text,
  sent_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, seq)
);
create index invoices_patient_idx on invoices (patient_id, created_at desc);
create index invoices_clinic_idx on invoices (clinic_id, created_at desc);

create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  service_id uuid references services(id) on delete set null,
  description text not null,
  qty numeric(10,2) not null default 1,
  unit_price numeric(12,2) not null default 0,
  amount numeric(12,2) not null default 0,
  sort integer not null default 0
);
create index invoice_items_invoice_idx on invoice_items (invoice_id, sort);

create table payments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  method text not null check (method in ('cash', 'cliq', 'card', 'transfer')),
  reference text not null default '',
  paid_at timestamptz not null default now(),
  recorded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index payments_clinic_idx on payments (clinic_id, paid_at desc);
create index payments_invoice_idx on payments (invoice_id);

------------------------------------------------------------------------------
-- Automations
------------------------------------------------------------------------------
create table automations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  description text not null default '',
  trigger_type text not null,
  trigger_config jsonb not null default '{}',
  active boolean not null default false,
  recipe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index automations_clinic_idx on automations (clinic_id);
create index automations_trigger_idx on automations (trigger_type) where active;

create table automation_steps (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  automation_id uuid not null references automations(id) on delete cascade,
  parent_step_id uuid references automation_steps(id) on delete cascade,
  branch text check (branch in ('yes', 'no')),
  sort integer not null default 0,
  step_type text not null check (step_type in ('send_whatsapp', 'wait', 'condition', 'add_tag', 'remove_tag', 'create_task', 'notify_staff', 'goto_automation', 'stop')),
  config jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index automation_steps_automation_idx on automation_steps (automation_id, sort);

create table automation_runs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  automation_id uuid not null references automations(id) on delete cascade,
  patient_id uuid references patients(id) on delete cascade,
  appointment_id uuid references appointments(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  current_step_id uuid references automation_steps(id) on delete set null,
  wake_at timestamptz,
  context jsonb not null default '{}',
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index automation_runs_automation_idx on automation_runs (automation_id, started_at desc);
create index automation_runs_wake_idx on automation_runs (wake_at) where status = 'waiting';
create unique index automation_runs_dedupe on automation_runs (automation_id, patient_id, appointment_id, invoice_id)
  where status in ('running', 'waiting');

create table automation_run_logs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  run_id uuid not null references automation_runs(id) on delete cascade,
  step_id uuid references automation_steps(id) on delete set null,
  status text not null check (status in ('ok', 'skipped', 'failed', 'waiting')),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index automation_run_logs_run_idx on automation_run_logs (run_id, created_at);

alter table messages
  add constraint messages_automation_run_fk
  foreign key (automation_run_id) references automation_runs(id) on delete set null;

create table tasks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  title text not null,
  body text not null default '',
  patient_id uuid references patients(id) on delete cascade,
  assigned_to uuid references users(id) on delete set null,
  due_at timestamptz,
  done boolean not null default false,
  created_by text not null default 'staff',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_clinic_idx on tasks (clinic_id, done, due_at);

------------------------------------------------------------------------------
-- AI agent
------------------------------------------------------------------------------
create table ai_agents (
  clinic_id uuid primary key references clinics(id) on delete cascade,
  enabled boolean not null default false,
  agent_name text not null default '',
  instructions text not null default '',
  language_mode text not null default 'match' check (language_mode in ('match', 'ar', 'en')),
  hours_mode text not null default 'after_hours' check (hours_mode in ('always', 'after_hours', 'custom')),
  custom_hours jsonb not null default '{}',
  escalation_notes text not null default '',
  max_daily_messages integer not null default 200,
  model text not null default 'claude-sonnet-5',
  updated_at timestamptz not null default now()
);

create table ai_knowledge_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  category text not null default 'faq' check (category in ('services_prices', 'doctors', 'hours', 'location', 'insurance', 'preparation', 'faq', 'other')),
  title text not null,
  content text not null default '',
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_knowledge_clinic_idx on ai_knowledge_items (clinic_id, category, sort);

create table ai_conversation_state (
  conversation_id uuid primary key references conversations(id) on delete cascade,
  clinic_id uuid not null references clinics(id) on delete cascade,
  state jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table ai_usage (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  day date not null,
  messages_out integer not null default 0,
  bookings integer not null default 0,
  escalations integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  unique (clinic_id, day)
);

------------------------------------------------------------------------------
-- Notifications, jobs, audit
------------------------------------------------------------------------------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  url text,
  read_at timestamptz,
  push_sent boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,
  user_agent text,
  created_at timestamptz not null default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}',
  run_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  last_error text,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_due_idx on jobs (run_at) where status = 'pending';

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  impersonated_by uuid references users(id) on delete set null,
  action text not null,
  entity text not null default '',
  entity_id text not null default '',
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_clinic_idx on audit_log (clinic_id, created_at desc);

create table announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

------------------------------------------------------------------------------
-- Agency-level default recipes (copied into new clinics)
------------------------------------------------------------------------------
create table recipe_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  name_ar text not null default '',
  description text not null default '',
  trigger_type text not null,
  trigger_config jsonb not null default '{}',
  steps jsonb not null default '[]',
  sort integer not null default 0,
  active boolean not null default true
);

create table knowledge_templates (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  title text not null,
  content text not null default '',
  sort integer not null default 0
);

------------------------------------------------------------------------------
-- updated_at maintenance
------------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  for t in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'updated_at'
  loop
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()',
      t || '_touch', t);
  end loop;
end $$;

------------------------------------------------------------------------------
-- Realtime change events -> pg_notify('app_events', ...)
------------------------------------------------------------------------------
create or replace function emit_change() returns trigger language plpgsql as $$
declare rec record;
begin
  rec := coalesce(new, old);
  perform pg_notify('app_events', json_build_object(
    't', tg_table_name,
    'op', lower(tg_op),
    'id', rec.id,
    'clinic_id', rec.clinic_id
  )::text);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['conversations', 'messages', 'appointments', 'patients', 'invoices', 'tasks', 'automation_runs'] loop
    execute format('create trigger %I after insert or update or delete on %I for each row execute function emit_change()',
      t || '_emit', t);
  end loop;
end $$;

-- whatsapp_sessions and notifications have different pk/columns
create or replace function emit_wa_change() returns trigger language plpgsql as $$
begin
  perform pg_notify('app_events', json_build_object(
    't', 'whatsapp_sessions', 'op', lower(tg_op),
    'id', coalesce(new.clinic_id, old.clinic_id),
    'clinic_id', coalesce(new.clinic_id, old.clinic_id)
  )::text);
  return null;
end $$;
create trigger whatsapp_sessions_emit after insert or update or delete on whatsapp_sessions
  for each row execute function emit_wa_change();

create or replace function emit_notification() returns trigger language plpgsql as $$
begin
  perform pg_notify('app_events', json_build_object(
    't', 'notifications', 'op', lower(tg_op),
    'id', new.id, 'clinic_id', new.clinic_id, 'user_id', new.user_id
  )::text);
  return null;
end $$;
create trigger notifications_emit after insert on notifications
  for each row execute function emit_notification();

------------------------------------------------------------------------------
-- Row Level Security
------------------------------------------------------------------------------

-- Clinic-scoped tables: same policy pattern everywhere.
do $$
declare t text;
begin
  foreach t in array array[
    'patients', 'custom_field_defs', 'patient_notes', 'patient_files',
    'services', 'service_doctors', 'appointments', 'booking_links',
    'conversations', 'messages', 'quick_replies',
    'whatsapp_sessions', 'whatsapp_auth_state',
    'invoices', 'invoice_items', 'payments',
    'automations', 'automation_steps', 'automation_runs', 'automation_run_logs',
    'tasks', 'ai_agents', 'ai_knowledge_items', 'ai_conversation_state', 'ai_usage'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
end $$;

-- clinics: members see their own clinic; admin sees all
alter table clinics enable row level security;
create policy clinics_access on clinics for all to clinicos_app
  using (app_is_admin() or id = app_clinic_id())
  with check (app_is_admin() or id = app_clinic_id());

-- clinic_members: rows of my clinic, or my own memberships (for clinic switching)
alter table clinic_members enable row level security;
create policy members_access on clinic_members for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id() or user_id = app_user_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());

-- users: self, admin, or colleagues in my active clinic
alter table users enable row level security;
create policy users_access on users for all to clinicos_app
  using (
    app_is_admin() or id = app_user_id()
    or exists (select 1 from clinic_members cm where cm.user_id = users.id and cm.clinic_id = app_clinic_id())
  )
  with check (app_is_admin() or id = app_user_id());

-- sessions: only mine (auth layer runs in admin context)
alter table sessions enable row level security;
create policy sessions_access on sessions for all to clinicos_app
  using (app_is_admin() or user_id = app_user_id())
  with check (app_is_admin() or user_id = app_user_id());

-- notifications: mine only
alter table notifications enable row level security;
create policy notifications_access on notifications for all to clinicos_app
  using (app_is_admin() or user_id = app_user_id())
  with check (app_is_admin() or user_id = app_user_id());

alter table push_subscriptions enable row level security;
create policy push_access on push_subscriptions for all to clinicos_app
  using (app_is_admin() or user_id = app_user_id())
  with check (app_is_admin() or user_id = app_user_id());

-- jobs: worker/admin only
alter table jobs enable row level security;
create policy jobs_access on jobs for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());

-- audit log: clinic staff can read their clinic's log; writes from any context land with clinic_id
alter table audit_log enable row level security;
create policy audit_access on audit_log for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id() or clinic_id is null);

-- announcements: everyone authenticated can read; only admin writes
alter table announcements enable row level security;
create policy announcements_read on announcements for select to clinicos_app using (true);
create policy announcements_write on announcements for insert to clinicos_app with check (app_is_admin());
create policy announcements_update on announcements for update to clinicos_app using (app_is_admin());
create policy announcements_delete on announcements for delete to clinicos_app using (app_is_admin());

-- agency templates: admin writes, all read (needed when enabling recipes in clinic UI)
alter table recipe_templates enable row level security;
create policy recipes_read on recipe_templates for select to clinicos_app using (true);
create policy recipes_write on recipe_templates for all to clinicos_app using (app_is_admin()) with check (app_is_admin());

alter table knowledge_templates enable row level security;
create policy ktemplates_read on knowledge_templates for select to clinicos_app using (true);
create policy ktemplates_write on knowledge_templates for all to clinicos_app using (app_is_admin()) with check (app_is_admin());
