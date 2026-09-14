-- 0051: "clinic owner" becomes "clinic admin".
--
-- A words-only change, and the only part of it that needs a migration is the
-- part that is not words in the app: `signer_roles.label` is a per-clinic row,
-- seeded once per workspace, and `lib/esign/print-data.ts` joins it live into
-- what a consent form prints. Renaming the dictionary alone would leave every
-- clinic already on the platform still saying "Clinic owner" on paper.
--
-- What is deliberately NOT renamed:
--   * the key 'clinic_owner' -- a stable identifier, referenced from
--     lib/esign/constants.ts and by every document_fields.assigned_role_key
--     already placed on a template. Renaming it would orphan them.
--   * clinic_members.is_owner -- the column is about owning the workspace,
--     which is still what it means.
--
-- Documents already signed keep the wording in their archived PDF, which is
-- written once and never regenerated; their on-screen record will show the new
-- label, because it is joined rather than frozen. That divergence is accepted
-- rather than overlooked -- see DECISIONS.md.

-- Existing clinics, and only where the row still carries the text we seeded.
-- A clinic that renamed this signer role for itself keeps its own word: they
-- changed it on purpose and it is their document.
update signer_roles set label = 'Clinic admin'
  where key = 'clinic_owner' and label = 'Clinic owner';

update signer_roles set label_ar = 'مدير العيادة'
  where key = 'clinic_owner' and label_ar = 'مالك العيادة';

-- And new ones. Copied verbatim from 0010 with the two labels changed and
-- nothing else touched -- there is exactly one definition of this function in
-- the repo, and re-emitting it by hand is how the note categories or the field
-- definitions would quietly revert.
create or replace function seed_esign_defaults(p_clinic uuid) returns void language plpgsql as $$
begin
  insert into patient_field_definitions
    (clinic_id, scope, key, label, label_ar, field_type, is_required, is_system,
     show_in_profile, source_column, source_path, display_order)
  values
    (p_clinic, 'patient', 'patient.full_name',   'Full name',     'الاسم الكامل',    'text',  true,  true, true, 'full_name', null, 10),
    (p_clinic, 'patient', 'patient.phone',       'Phone',         'رقم الهاتف',      'phone', true,  true, true, 'phone_e164', null, 20),
    (p_clinic, 'patient', 'patient.national_id', 'National ID',   'الرقم الوطني',    'text',  false, true, true, null, null, 30),
    (p_clinic, 'patient', 'patient.birth_date',  'Date of birth', 'تاريخ الميلاد',   'date',  false, true, true, 'birth_date', null, 40),
    (p_clinic, 'patient', 'patient.gender',      'Gender',        'الجنس',           'select',false, true, true, 'gender', null, 50),
    (p_clinic, 'patient', 'patient.address',     'Address',       'العنوان',         'text',  false, true, true, null, null, 60),
    (p_clinic, 'context', 'clinic.name',         'Clinic name',   'اسم العيادة',     'text',  false, true, false, null, 'clinic.name', 70),
    (p_clinic, 'context', 'clinic.address',      'Clinic address','عنوان العيادة',   'text',  false, true, false, null, 'clinic.address', 80),
    (p_clinic, 'context', 'clinic.phone',        'Clinic phone',  'هاتف العيادة',    'phone', false, true, false, null, 'clinic.phone', 90),
    (p_clinic, 'context', 'doctor.name',         'Doctor name',   'اسم الطبيب',      'text',  false, true, false, null, 'doctor.name', 100),
    (p_clinic, 'context', 'service.name',        'Service',       'الخدمة',          'text',  false, true, false, null, 'service.name', 110),
    (p_clinic, 'context', 'service.price',       'Service price', 'سعر الخدمة',      'text',  false, true, false, null, 'service.price', 120),
    (p_clinic, 'context', 'appointment.date',    'Appointment date','تاريخ الموعد',  'date',  false, true, false, null, 'appointment.date', 130),
    (p_clinic, 'context', 'today',               'Today''s date', 'تاريخ اليوم',     'date',  false, true, false, null, 'today', 140)
  on conflict (clinic_id, key) do nothing;

  -- Gender is a choice list everywhere it appears.
  update patient_field_definitions
     set options = '["male","female"]'::jsonb
   where clinic_id = p_clinic and key = 'patient.gender';

  -- Anything the clinic already added as a custom patient field becomes a
  -- definition too, so the two never disagree.
  insert into patient_field_definitions
    (clinic_id, scope, key, label, label_ar, field_type, options, storage_key, display_order)
  select
    d.clinic_id, 'patient', 'patient.' || d.key, d.label, d.label_ar,
    case d.field_type
      when 'select' then 'select'
      when 'boolean' then 'checkbox'
      when 'number' then 'number'
      when 'date' then 'date'
      else 'text'
    end,
    d.options, d.key, 200 + d.sort
  from custom_field_defs d
  where d.clinic_id = p_clinic
  on conflict (clinic_id, key) do nothing;

  insert into signer_roles (clinic_id, key, label, label_ar, is_staff, is_system, display_order)
  values
    (p_clinic, 'patient',              'Patient',               'المريض',            false, true, 10),
    (p_clinic, 'guardian',             'Guardian',              'ولي الأمر',         false, true, 20),
    (p_clinic, 'doctor',               'Doctor',                'الطبيب',            true,  true, 30),
    (p_clinic, 'clinic_owner',         'Clinic admin',          'مدير العيادة',      true,  true, 40),
    (p_clinic, 'clinic_representative','Clinic representative', 'ممثل العيادة',      true,  true, 50),
    (p_clinic, 'witness',              'Witness',               'شاهد',              false, true, 60)
  on conflict (clinic_id, key) do nothing;
end $$;
