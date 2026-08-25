------------------------------------------------------------------------------
-- Booking intake: the questions a clinic asks, and the page it asks them on
--
-- Until now a booking link collected exactly two things — a name and a phone
-- number — and every clinic got the same page. Both were platform decisions
-- standing in for clinic ones: a dermatology clinic needs to know what the
-- patient is coming for, an insurance-heavy clinic needs the policy number, and
-- a clinic with a waiting list needs to know whether this is a first visit.
--
-- Answers live on the appointment, not only on the patient, because "what did
-- this person tell us when they booked this visit" is a fact about the visit.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- The link's own voice
------------------------------------------------------------------------------
alter table booking_links
  -- What the page says above the first step, in the clinic's own words.
  add column if not exists headline text,
  add column if not exists headline_ar text,
  add column if not exists intro text,
  add column if not exists intro_ar text,
  -- Shown on the confirmation screen: parking, what to bring, when to arrive.
  add column if not exists success_note text,
  add column if not exists success_note_ar text,
  -- A price on a public page is a commitment. Clinics that quote per case
  -- switch it off rather than publish a number they will have to argue about.
  add column if not exists show_prices boolean not null default true,
  -- Without this the patient can dodge the choice with "first available", which
  -- is wrong for a clinic where the doctor is the reason the patient came.
  add column if not exists allow_any_doctor boolean not null default true,
  -- A tick-box the patient must accept before booking, in the clinic's words.
  add column if not exists consent_text text,
  add column if not exists consent_text_ar text,
  add column if not exists require_consent boolean not null default false;

------------------------------------------------------------------------------
-- The questions
------------------------------------------------------------------------------
create table if not exists booking_questions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  -- null = asked on every one of the clinic's links. A clinic that runs a
  -- separate link per branch or per campaign scopes a question to just that one.
  booking_link_id uuid references booking_links(id) on delete cascade,
  label text not null,
  label_ar text,
  -- The small grey line under the field. Where a clinic explains *why* it is
  -- asking, which is the difference between an answered question and a bounce.
  help text,
  help_ar text,
  field_type text not null default 'text'
    check (field_type in ('text', 'longtext', 'number', 'date', 'select', 'multiselect', 'checkbox', 'phone', 'email')),
  options jsonb not null default '[]',
  options_ar jsonb not null default '[]',
  required boolean not null default false,
  -- Only asked when one of these services was picked; empty = always asked.
  -- "Which tooth?" has no meaning on a whitening consultation.
  service_ids uuid[] not null default '{}',
  /*
    Where the answer lands on the patient file, as a `patient_field_definitions`
    key — the same rows that drive the profile form and the document merge
    variables. Null keeps the answer on the appointment alone, which is right for
    anything that is true of one visit rather than of the person.
  */
  patient_field_key text,
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists booking_questions_clinic_idx
  on booking_questions (clinic_id, display_order);

/*
  The answers, frozen.

  A snapshot of label and value rather than a foreign key to the question: the
  clinic will reword its questions, and an appointment from three months ago
  must keep showing the question the patient actually answered. Shape is
  [{ id, key, label, labelAr, type, value }].
*/
alter table appointments
  add column if not exists intake_answers jsonb not null default '[]';

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
alter table booking_questions enable row level security;
drop policy if exists tenant_isolation on booking_questions;
create policy tenant_isolation on booking_questions for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());

drop trigger if exists booking_questions_touch on booking_questions;
create trigger booking_questions_touch before update on booking_questions
  for each row execute function touch_updated_at();
