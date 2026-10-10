-- 0071: machines for every kind of clinic, not only dentists'.
--
-- 0068–0070 grew around the dental chart: x-rays and photos, "Take x-ray" on a
-- tooth. A cardiology clinic's ECG, a gynaecologist's ultrasound, an eye
-- clinic's OCT and fundus camera, a lab's analyzer all send results the same
-- way — what was missing was a name for what they send, and a way to ask a
-- particular machine for the next one from the patient's file.

-- What a file is, so the patient's Files can be read by kind.
alter table patient_files drop constraint if exists patient_files_kind_check;
alter table patient_files add constraint patient_files_kind_check
  check (kind in ('xray', 'photo', 'ecg', 'ultrasound', 'scan', 'report', 'lab', 'consent', 'insurance_card', 'other'));
alter table imaging_inbox drop constraint if exists imaging_inbox_kind_check;
alter table imaging_inbox add constraint imaging_inbox_kind_check
  check (kind in ('xray', 'photo', 'ecg', 'ultrasound', 'scan', 'report', 'lab', 'other'));

-- What kind of machine it is.
alter table clinic_devices drop constraint if exists clinic_devices_kind_check;
alter table clinic_devices add constraint clinic_devices_kind_check
  check (kind in ('xray', 'opg', 'cbct', 'camera', 'scanner', 'ultrasound', 'ecg', 'endoscope', 'eye', 'monitor', 'lab', 'other'));

-- "Request from device": the next result from this machine (or any, when
-- null) goes to this patient. `file` is any result — a PDF report, a DICOM
-- study — where `xray` and `photo` stay pictures only, as the dental chart asks.
alter table imaging_requests drop constraint if exists imaging_requests_kind_check;
alter table imaging_requests add constraint imaging_requests_kind_check check (kind in ('xray', 'photo', 'file'));
alter table imaging_requests add column if not exists device_id uuid references clinic_devices(id) on delete set null;
alter table imaging_requests add column if not exists note text not null default '' check (char_length(note) <= 80);
