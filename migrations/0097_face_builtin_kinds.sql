-- The kinds of the built-in face treatments, ready in every clinic with the face chart.
--
-- Proposed to Yamen on 2026-11-07 ("check this list of extra built-in treatments and
-- kinds"), approved 2026-11-08 ("go ahead"). The new built-in treatments themselves
-- live in code (catalog.ts); kinds are rows (0094), because a clinic prices them,
-- ties them to products, renames them and switches them off as its own.
--
-- Added once per clinic: a kind the clinic later switched off is not brought back.
-- A clinic that already has a kind of the same name keeps its own.

alter table clinics add column if not exists face_kinds_seeded_at timestamptz;

create or replace function face_seed_kinds(p_clinic uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from clinics where id = p_clinic and face_kinds_seeded_at is not null) then return; end if;
  insert into aesthetic_treatment_variants (clinic_id, treatment_key, name, name_ar, sort)
  select p_clinic, k.t, k.n, k.a, k.s
    from (values
      ('aes_toxin', 'Nefertiti lift', 'شد نفرتيتي', 1),
      ('aes_toxin', 'Masseter slimming', 'تنحيف العضلة الماضغة', 2),
      ('aes_toxin', 'Gummy smile', 'الابتسامة اللثوية', 3),
      ('aes_toxin', 'Lip flip', 'ليب فليب', 4),
      ('aes_toxin', 'Micro-botox', 'مايكرو بوتوكس', 5),
      ('aes_filler', 'Hyaluronic acid', 'هيالورونيك أسيد', 1),
      ('aes_filler', 'Radiesse (CaHA)', 'راديس', 2),
      ('aes_filler', 'Sculptra (PLLA)', 'سكلبترا', 3),
      ('aes_peel', 'Glycolic', 'جليكوليك', 1),
      ('aes_peel', 'Salicylic', 'ساليسيليك', 2),
      ('aes_peel', 'TCA', 'TCA', 3),
      ('aes_peel', 'Lactic', 'لاكتيك', 4),
      ('aes_peel', 'Jessner', 'جيسنر', 5),
      ('aes_peel', 'Mandelic', 'ماندليك', 6),
      ('aes_threads', 'PDO smooth', 'PDO ناعمة', 1),
      ('aes_threads', 'PDO cog', 'PDO مسننة', 2),
      ('aes_threads', 'PLLA', 'PLLA', 3),
      ('aes_threads', 'PCL', 'PCL', 4),
      ('aes_laser_hair', 'Alexandrite', 'ألكسندرايت', 1),
      ('aes_laser_hair', 'Diode', 'دايود', 2),
      ('aes_laser_hair', 'Nd:YAG', 'إن دي ياغ', 3),
      ('aes_laser_skin', 'CO2', 'CO2', 1),
      ('aes_laser_skin', 'Erbium', 'إربيوم', 2),
      ('aes_tightening', 'HIFU', 'هايفو', 1),
      ('aes_tightening', 'RF microneedling', 'إبر دقيقة بالترددات الراديوية', 2),
      ('aes_tightening', 'RF', 'ترددات راديوية', 3)
    ) as k(t, n, a, s)
   where not exists (
     select 1 from aesthetic_treatment_variants v
      where v.clinic_id = p_clinic and v.treatment_key = k.t and ar_normalize(v.name) = ar_normalize(k.n)
   );
  update clinics set face_kinds_seeded_at = now() where id = p_clinic;
end $$;

-- A clinic given the face chart later gets them when it is switched on.
create or replace function clinics_face_kinds() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce((new.features ->> 'aesthetic')::boolean, false) and new.face_kinds_seeded_at is null then
    perform face_seed_kinds(new.id);
  end if;
  return null;
end $$;
drop trigger if exists clinics_face_kinds on clinics;
create trigger clinics_face_kinds after insert or update of features on clinics
  for each row execute function clinics_face_kinds();

select face_seed_kinds(id) from clinics where coalesce((features ->> 'aesthetic')::boolean, false);
