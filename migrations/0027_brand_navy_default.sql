-- The tag default follows the brand.
--
-- `clinic_tags.color` defaulted to the old slate blue, so every tag created
-- without a colour picked would keep wearing the previous brand long after the
-- rest of the product stopped. Only the default moves: a colour a clinic chose
-- is theirs, including any that happen to be the old value.

alter table clinic_tags alter column color set default '#0b1220';

/*
  Tags that never had a colour chosen. These are the rows the old default
  created, and they are indistinguishable from a deliberate choice by value
  alone — so this is bounded to tags the catalogue adopted automatically from
  `patients.tags` in 0018, which were all created in that one backfill and have
  never been updated since.
*/
update clinic_tags
   set color = '#0b1220'
 where color = '#6989a6'
   and updated_at = created_at;
