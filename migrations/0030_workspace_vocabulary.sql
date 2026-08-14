-- One workspace that speaks a different language about the same objects.
--
-- Clinicti runs its own business inside Clinicti. Its customers are clinics,
-- not patients; the thing it asks them to sign is a service agreement, not a
-- consent form. Every other clinic on the platform means exactly what the
-- product already says, and must keep meaning it.
--
-- So this is a vocabulary, not a rename. The tables, columns, routes and code
-- keep saying `patients` — because that is what they are for every tenant but
-- one, and a schema that changed shape per tenant would be a different product
-- with the same bugs twice. Only the words on screen move.
--
-- Deliberately an enum-ish check rather than a free-form map of overrides. A
-- per-clinic dictionary would need an editor, a validation story and a
-- translation for every future string; a named vocabulary needs one more branch
-- in one file, and a clinic either speaks it or does not.

alter table clinics
  add column if not exists vocabulary text not null default 'medical'
    check (vocabulary in ('medical', 'agency'));

-- The default is what every existing clinic gets, and what `create clinic` will
-- keep giving new ones: nothing about onboarding changes.
comment on column clinics.vocabulary is
  'Screen wording only. medical = patients/consent (default, all clinics). agency = clinics/contracts (Clinicti''s own workspace).';
