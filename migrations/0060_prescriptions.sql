------------------------------------------------------------------------------
-- Prescriptions: written in the patient file, sent to the patient on WhatsApp
-- as a PDF with the medicines listed in the caption, printed on letterhead.
--
-- Three tables, because a prescription is three different kinds of thing:
--
--  * `prescriptions` is a clinical record. It is written once and never
--    edited or deleted — a wrong one is corrected by writing the right one,
--    the same rule a note follows. The medicines live inside it as jsonb
--    because they are only ever read together and never change afterwards.
--  * `medications` is the clinic's own list, and it learns: every medicine
--    written is remembered with how it was last prescribed, so the second time
--    a doctor writes it the dose, frequency and duration fill themselves in.
--  * `prescription_templates` are the sets a doctor writes over and over
--    ("sore throat — adult", "after an extraction"), applied in one tap.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- The record
------------------------------------------------------------------------------
create table if not exists prescriptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  /*
    The prescribing doctor, which is not always who typed it: an assistant may
    write it for the doctor. Both are kept, and the doctor's name is copied as
    it stood — a doctor who later leaves the clinic takes their membership row
    with them, and the prescription must still say who prescribed it.
  */
  doctor_member_id uuid references clinic_members(id) on delete set null,
  doctor_name text not null,
  author_id uuid references users(id) on delete set null,
  number integer not null,
  -- The writer picks the language on each one; the PDF and the WhatsApp
  -- caption both follow it.
  locale text not null default 'ar' check (locale in ('ar', 'en')),
  diagnosis text not null default '',
  items jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
  -- Whether the doctor's saved signature was on the PDF when it was made.
  signed boolean not null default false,
  pdf_path text,
  -- The most recent WhatsApp send, so the file can show delivered / read.
  message_id uuid references messages(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (clinic_id, number)
);
create index if not exists prescriptions_patient_idx
  on prescriptions (clinic_id, patient_id, created_at desc);

alter table clinics
  add column if not exists prescription_counter integer not null default 0;

------------------------------------------------------------------------------
-- The clinic's medicine list
------------------------------------------------------------------------------
create table if not exists medications (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  -- How it was prescribed last time, offered as the starting point next time.
  dose text not null default '',
  frequency text not null default '',
  duration text not null default '',
  instructions text not null default '',
  use_count integer not null default 0,
  last_used_at timestamptz,
  -- Hidden rather than deleted: a misspelling nobody wants suggested again.
  -- Prescriptions already written carry their own copy of the name.
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists medications_name_uniq
  on medications (clinic_id, lower(btrim(name)));

------------------------------------------------------------------------------
-- Templates
------------------------------------------------------------------------------
create table if not exists prescription_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  diagnosis text not null default '',
  items jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
  locale text not null default 'ar' check (locale in ('ar', 'en')),
  use_count integer not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists prescription_templates_clinic_idx
  on prescription_templates (clinic_id, use_count desc);

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['prescriptions', 'medications', 'prescription_templates'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
end $$;

drop trigger if exists medications_touch on medications;
create trigger medications_touch before update on medications
  for each row execute function touch_updated_at();
drop trigger if exists prescription_templates_touch on prescription_templates;
create trigger prescription_templates_touch before update on prescription_templates
  for each row execute function touch_updated_at();
