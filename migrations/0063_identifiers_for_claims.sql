/*
  The identifiers an insurance claim is made of.

  Hakeem Claim — the national hub for insurance approvals and claims — and the
  insurers behind it identify a visit by who the patient is, who treated them,
  where, and what was done. Clinicti held the first only as free text and the
  rest not at all. None of this changes what a clinic sees until it fills the
  fields in; every column is optional and starts empty.
*/

------------------------------------------------------------------------------
-- 1. The patient's national number, made searchable
------------------------------------------------------------------------------
/*
  The value stays where it has always lived, `custom_fields.national_id`, behind
  the clinic's own `patient.national_id` field definition: the profile, e-sign
  merge fields, booking intake and the patient export all read it there, and
  moving it would have meant moving all of them. This column is derived from it
  — ten digits, either numeral set, spaces and dashes dropped — so it can be
  indexed, searched exactly and compared across files. Anything that is not a
  Jordanian national number (a passport, a residence card) stays in the custom
  field and leaves this null. Mirrors `nationalIdOf` in src/lib/patients.ts.
*/
alter table patients add column if not exists national_id text generated always as (
  case
    when regexp_replace(
           translate(coalesce(custom_fields->>'national_id', ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
           '[[:space:]-]', '', 'g') ~ '^[0-9]{10}$'
    then regexp_replace(
           translate(custom_fields->>'national_id', '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
           '[[:space:]-]', '', 'g')
  end
) stored;

/*
  Not unique. Two files carrying one number are one person filed twice, and the
  answer to that is the merge screen, not a constraint that would refuse the
  migration on whichever clinic already has such a pair. The patient route
  refuses a new duplicate and names the other file instead.
*/
create index if not exists patients_national_id_idx on patients (clinic_id, national_id)
  where national_id is not null;

------------------------------------------------------------------------------
-- 2. Who treated them: the doctor's licence, copied onto each prescription
------------------------------------------------------------------------------
alter table clinic_members
  add column if not exists license_no text,   -- رقم مزاولة المهنة
  add column if not exists syndicate_no text; -- رقم العضوية في النقابة

-- Copied when written, like `doctor_name`: a renewal must not rewrite history.
alter table prescriptions
  add column if not exists doctor_license_no text,
  add column if not exists doctor_syndicate_no text;

------------------------------------------------------------------------------
-- 3. Where: the facility's Ministry of Health licence
------------------------------------------------------------------------------
alter table clinics add column if not exists moh_license_no text;

------------------------------------------------------------------------------
-- 4. What was done: the code an insurer knows a service by
------------------------------------------------------------------------------
/*
  Free text: a CPT code or a line of the doctors' syndicate fee schedule, and
  which of those Hakeem Claim wants is the question still open with them. On
  the service as the clinic's standing answer, and copied onto each invoice
  line when it is raised, so recoding a service never rewrites a past claim.
*/
alter table services add column if not exists fee_code text;
alter table invoice_items add column if not exists fee_code text;
