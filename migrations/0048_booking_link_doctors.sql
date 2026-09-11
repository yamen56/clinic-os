------------------------------------------------------------------------------
-- A booking link can name several doctors
--
-- `doctor_member_id` was one doctor or nobody: either the link was "Dr Omar's
-- page" or it offered the whole clinic. There was no way to say what a clinic
-- with three dentists and two paediatricians actually wanted — a link for the
-- dental pair, another for the children's pair.
--
-- It becomes a set, shaped exactly like `service_ids` beside it: an empty array
-- means "every doctor", which is what a null used to mean, and the public page
-- offers whoever is in it.
--
-- One doctor in the array behaves the way one doctor in the column always did:
-- the step collapses and the booking is theirs. So a link written before today
-- is unchanged, which is the point of backfilling rather than reading both.
------------------------------------------------------------------------------

alter table booking_links
  add column if not exists doctor_member_ids uuid[] not null default '{}';

-- Every link that named a doctor keeps naming them.
update booking_links
   set doctor_member_ids = array[doctor_member_id]
 where doctor_member_id is not null
   and cardinality(doctor_member_ids) = 0;

comment on column booking_links.doctor_member_ids is
  'The doctors this link offers. Empty means every active doctor — the same
   thing a null doctor_member_id used to mean. One entry locks the link to that
   doctor and hides the choice, as the single column did.';

/*
  `doctor_member_id` is left in place rather than dropped.

  The same reason 0037 kept `patient_notes.kind`: this runs against a live
  database, the web and worker containers roll one after the other, and for the
  length of that rollout the old code is still reading the single column. The
  save path writes both — the array, and the column set to the one doctor when
  there is exactly one, null otherwise — so an old container serving a link
  during the deploy sees what it expects. It can go in a later migration once
  nothing has read it for a release.
*/
