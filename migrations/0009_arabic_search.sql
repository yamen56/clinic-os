-- Arabic-insensitive patient search.
--
-- Patient search compared names literally, so it only matched when staff typed
-- a name exactly as it was saved. Arabic does not work that way: hamza is
-- routinely dropped (أحمد / احمد), taa marbuta and haa are interchanged in
-- casual writing (سارة / ساره), alif maqsura and yaa are mixed (يحيى / يحيي),
-- and names arriving from WhatsApp profiles carry diacritics that nobody types
-- when searching. Every one of those lookups failed, on the primary screen of
-- an Arabic-first product.
--
-- Normalising both sides to a common skeleton fixes it for good.

create extension if not exists pg_trgm;

create or replace function ar_normalize(t text) returns text
  language sql immutable strict parallel safe as $$
  select lower(
    translate(
      -- Strip tatweel (ـ) and the combining marks: fatha..sukun, plus dagger alif.
      regexp_replace(coalesce(t, ''), '[ـً-ْٰ]', '', 'g'),
      -- Collapse the interchangeable letter forms onto one representative each.
      'أإآٱةىؤئ',
      'ااااهيوي'
    )
  )
$$;

-- Trigram index so the normalised infix search stays indexed rather than
-- scanning every patient in the clinic.
create index if not exists patients_name_norm_trgm_idx
  on patients using gin (ar_normalize(full_name) gin_trgm_ops);
