-- Two prices for a treatment: for the whole of it, and for each visit.
--
-- Yamen, 2026-10-12: "we want to have the option if we want to charge this
-- patient for the visit or for the whole treatment, and each cost can be
-- chosen in the treatment prices". A root canal can cost 90 for the whole
-- treatment and 30 a visit; which one a patient pays is chosen on that
-- patient's treatment.
--
-- Each price stays a service (0074): the whole-treatment price is the service
-- charged 'item', the per-visit price the one charged 'session'. A treatment
-- (or a kind of it) may now have one of each, so the price list's key takes
-- the unit too. A patient's treatment points at the one it is charged by
-- (chart_marks.service_id), which is how billing already tells the two apart.
--
-- Nothing is rewritten: every existing price keeps its unit, and every
-- treatment keeps the price it was quoted.

drop index if exists services_chart_key_idx;
create unique index if not exists services_chart_price_idx
  on services (clinic_id, chart_key, coalesce(chart_variant, ''), price_unit)
  where chart_key is not null;
