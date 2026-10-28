------------------------------------------------------------------------------
-- The face chart: aesthetic work recorded on the patient's face
--
-- Yamen, 2026-10-28: "something like the dental charts, but for the aesthetic
-- clinic ... the doctor clicks on that certain area, chooses what treatment he
-- did, and it is linked to the reception, so the receptionist can see what
-- invoices he should bill". The body waits ("only add the face, in a later
-- time we will add the body").
--
-- It is the same chart engine, not a second one. 0068 gave chart_marks a
-- `chart` column for exactly this; an aesthetic treatment is a chart mark of
-- chart 'aesthetic', so everything built on marks works for it unchanged: the
-- entry's history and its two-minute undo, the visit it was done at, its price
-- from the one price list, and billing through invoice_item_marks — the
-- desk's Ready to bill and the invoice builder already read any mark.
--
-- What an aesthetic mark adds:
--
--   site      'face' (and 'body', when it comes) rather than a tooth.
--   areas     the parts of the face it was done on, each with the units given
--             there when the treatment is dosed by units (toxin):
--               [{"zone": "forehead", "units": 10}, {"zone": "glabella", "units": 20}]
--   quantity  what its price counts: areas, units, syringes, threads or
--             sessions, by the treatment (lib/charts/face/catalog.ts). The
--             mark's fee is the whole price, list price × quantity.
--
-- The module is the clinic's `aesthetic` feature, opt-in like the dental
-- chart: this migration switches it on for nobody. The agency turns it on, one
-- clinic at a time.
------------------------------------------------------------------------------

alter table chart_marks drop constraint if exists chart_marks_chart_check;
alter table chart_marks add constraint chart_marks_chart_check check (chart in ('dental', 'aesthetic'));

alter table chart_marks drop constraint if exists chart_marks_site_check;
alter table chart_marks add constraint chart_marks_site_check check (
  (chart = 'dental' and site ~ '^([1-8][1-8]|Q[1-4]|upper|lower|mouth)$')
  or (chart = 'aesthetic' and site in ('face', 'body'))
);

alter table chart_marks
  add column if not exists areas jsonb not null default '[]'::jsonb,
  add column if not exists quantity numeric(10, 2) check (quantity is null or quantity > 0);
alter table chart_marks drop constraint if exists chart_marks_areas_check;
alter table chart_marks add constraint chart_marks_areas_check check (jsonb_typeof(areas) = 'array');

comment on column chart_marks.areas is
  'Aesthetic work: the parts of the face it was done on, [{"zone": "...", "units": n?}]. Empty on dental marks.';
comment on column chart_marks.quantity is
  'Aesthetic work: what its price counts (areas, units, syringes, threads, sessions). The fee is the whole price.';

-- A patient's face chart is read on its own, beside the dental chart of a
-- medical centre that keeps both.
create index if not exists chart_marks_chart_patient_idx on chart_marks (clinic_id, patient_id, chart, created_at);
