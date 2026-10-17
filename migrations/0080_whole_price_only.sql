-- One price for the whole treatment.
--
-- Yamen, 2026-10-17: "delete the pay per visit — the patient can pay on
-- multiple visits from the whole treatment price". 0076 let a treatment be
-- priced per visit ('session') beside its whole price ('item'). This retires
-- the per-visit prices. A treatment is billed once, whole, the day it starts,
-- and the patient pays it off in parts on that one invoice, which invoices
-- always allowed.
--
-- What becomes of what is there:
--
--   1. A treatment charged per visit and not billed yet takes the list's whole
--      price for it. When the list has none, it gets no price: it then waits on
--      the Treatment prices page like any unpriced treatment, and is priced
--      from there. A per-visit amount typed by hand is not a whole price, so it
--      goes too. Each change is a line in the treatment's history.
--   2. A per-visit price is retired, as clearing its box retires it
--      (saveDentalPriceAction's release). One the price list made goes
--      inactive; one of the clinic's own services is only let go. This happens
--      when the treatment has steps, or the list also prices it whole.
--   3. A one-tap treatment (an orthodontic adjustment, a clinic's own) priced
--      only per visit keeps that price, as its whole price. It is charted each
--      visit, so "each visit" and "each time it is charted" were always the
--      same thing.
--   4. A treatment already billed for some of its visits stays billed, and
--      nothing on any invoice is rewritten. They are counted below, for the
--      record.
--
-- The stepped treatments are the keys of PROTOCOLS
-- (src/lib/charts/dental/protocols.ts). Keep this list with it.
--
-- services.price_unit and its 0076 index stay: nothing writes 'session' now.

create temp table _visit_prices on commit drop as
select s.id, s.clinic_id, s.chart_key, s.chart_variant, s.chart_owned,
       s.chart_key = any (array[
         'rct', 'rct_retreat', 'pulpectomy', 'implant', 'implant_crown', 'implant_denture',
         'denture_complete', 'denture_partial', 'crown', 'bridge', 'veneer', 'hollywood_smile',
         'inlay', 'onlay', 'scaling'
       ]) as stepped,
       w.id as whole_id,
       w.price as whole_price,
       -- Any whole price for it at all, in use or not: the index admits one, so
       -- a per-visit price can only become the whole one when there is none.
       exists (select 1 from services x
                where x.clinic_id = s.clinic_id and x.chart_key = s.chart_key
                  and coalesce(x.chart_variant, '') = coalesce(s.chart_variant, '')
                  and x.price_unit = 'item') as has_whole
  from services s
  left join services w
    on w.clinic_id = s.clinic_id and w.chart_key = s.chart_key
   and coalesce(w.chart_variant, '') = coalesce(s.chart_variant, '')
   and w.price_unit = 'item' and w.active
 where s.chart_key is not null and s.price_unit = 'session';

-- Kept as the whole price (3), else retired (2).
alter table _visit_prices add column keep boolean;
update _visit_prices set keep = not stepped and not has_whole;

-- 4. Billed per visit, at least in part: left as it is, and counted.
do $$
declare n int;
begin
  select count(*) into n
    from chart_marks m
    join _visit_prices v on v.id = m.service_id
   where exists (
     select 1 from invoice_item_marks iim
       join invoice_items ii on ii.id = iim.invoice_item_id
       join invoices i on i.id = ii.invoice_id
      where iim.mark_id = m.id and i.status <> 'void' and i.credit_note_of is null);
  raise notice '0080: % treatment(s) already billed per visit, left as billed', n;
end $$;

-- 1. Not billed yet: the whole price from the list, or none to wait for one.
--    A one-tap treatment whose per-visit price stays as its whole price (3)
--    keeps what it has.
create temp table _repriced on commit drop as
select m.id, m.clinic_id, m.fee as was,
       case when v.whole_id is not null then v.whole_price end as fee,
       coalesce(v.whole_id, m.service_id) as service_id
  from chart_marks m
  join _visit_prices v on v.id = m.service_id
 where not v.keep
   and not exists (
     select 1 from invoice_item_marks iim
       join invoice_items ii on ii.id = iim.invoice_item_id
       join invoices i on i.id = ii.invoice_id
      where iim.mark_id = m.id and i.status <> 'void' and i.credit_note_of is null);

update chart_marks m
   set fee = r.fee, service_id = r.service_id, fee_manual = false
  from _repriced r
 where r.id = m.id;

insert into chart_mark_events (clinic_id, mark_id, action, reason)
select clinic_id, id, 'fee',
       case when fee is null then 'per-visit price retired; no whole price on the list yet'
            else 'per-visit price retired; whole price ' || fee end
  from _repriced;

-- 2. Retired: the price list's own go inactive, the clinic's own are let go.
update services s
   set active = case when v.chart_owned then false else s.active end,
       chart_key = null,
       chart_variant = null
  from _visit_prices v
 where v.id = s.id and not v.keep;

-- 3. One-tap, priced only per visit: that price is its whole price now, named
--    without "per visit" (saveDentalPriceAction's PER_VISIT suffix).
update services s
   set price_unit = 'item',
       name = case when v.chart_owned then regexp_replace(s.name, ' · per visit$', '') else s.name end,
       name_ar = case when v.chart_owned then regexp_replace(s.name_ar, ' · لكل زيارة$', '') else s.name_ar end
  from _visit_prices v
 where v.id = s.id and v.keep;
