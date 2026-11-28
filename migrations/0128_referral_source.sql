------------------------------------------------------------------------------
-- Where a patient came from
--
-- 2026-11-28. `patients.source` says how a file was made — the desk, the
-- booking link, WhatsApp, the AI — not why the person came. A clinic paying
-- for Instagram ads, or living on one doctor's referrals, could not see which
-- of them brings patients, or patients who pay.
--
-- The desk asks once ("كيف عرفت عنا؟") and picks one of a short list; a
-- friend's or a doctor's name goes in the note. The analytics page counts new
-- patients and what was collected by it.
------------------------------------------------------------------------------

alter table patients add column if not exists referral_source text
  check (referral_source is null or referral_source in
    ('instagram', 'facebook', 'tiktok', 'google', 'friend', 'doctor', 'insurance', 'walk_in', 'other'));
alter table patients add column if not exists referral_note text
  check (referral_note is null or length(referral_note) <= 120);
