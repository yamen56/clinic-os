-- A photo of the person, so staff are recognisable rather than a pair of initials.
--
-- On `users`, not `clinic_members`, and for the same reason the signature lives
-- there: it belongs to the person, not to a job. Someone working at two clinics
-- has one face, and should not have to upload it twice. The per-membership
-- `color` stays where it is — that one genuinely is per-clinic, because it tints
-- their appointments on that clinic's calendar.

alter table users add column if not exists avatar_path text;
