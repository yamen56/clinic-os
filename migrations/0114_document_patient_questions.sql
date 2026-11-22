-- The patient answers on the signing page (Yamen, 2026-11-22): "we should be
-- able to ask the patient some questions … and instead of the values the
-- receptionist fills, make the patient fill them". His example was a paper
-- intake form: name, ID, age, health questions, tick boxes, a signature.

-- What this document asks, frozen with it. Questions were read from the live
-- template at signing time, so editing a template changed what an already
-- sent document asked — and what its signed PDF says it asked.
alter table documents add column if not exists questions jsonb;

-- The patient details this document needs but the file did not have when it
-- was sent (national ID, date of birth, address…). They used to block sending,
-- so reception typed something — anything — to get past it. Now the patient
-- fills them on the signing page; the frozen text carries a marked blank for
-- each, the answers fill the blanks in the signed copy, and the patient's file
-- gains whatever it was missing (never overwriting what staff entered).
alter table documents add column if not exists patient_fills jsonb not null default '[]'::jsonb;

-- When the patient answers, chosen per template (Yamen, same day): some clinics
-- want the questions before the patient reads, some on the same page as the
-- text, most after it. The document keeps the choice it was sent with.
alter table document_templates add column if not exists questions_at text not null default 'after'
  check (questions_at in ('before', 'with', 'after'));
alter table documents add column if not exists questions_at text
  check (questions_at in ('before', 'with', 'after'));
