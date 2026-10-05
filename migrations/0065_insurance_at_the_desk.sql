/*
  Insurance, made the desk's job instead of the receptionist's arithmetic.

  1. A coverage rule per company: the share it pays, and optionally the most it
     pays on one invoice. With a rule, an insured patient's invoice fills in the
     insurer's share by itself (src/lib/insurance.ts); without one nothing changes
     and the amount waits for somebody to type it, as it always has. Both null
     on every existing company.

  2. The insurance card is a kind of patient file, so a photo of its front and
     back sits on the file next to the policy number it proves.
*/
alter table insurers
  add column if not exists coverage_percent numeric(5,2)
    check (coverage_percent is null or (coverage_percent >= 0 and coverage_percent <= 100)),
  add column if not exists coverage_cap numeric(12,2)
    check (coverage_cap is null or coverage_cap >= 0);

alter table patient_files drop constraint if exists patient_files_kind_check;
alter table patient_files add constraint patient_files_kind_check
  check (kind in ('xray', 'lab', 'consent', 'photo', 'insurance_card', 'other'));
