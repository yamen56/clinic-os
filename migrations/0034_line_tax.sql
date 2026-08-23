-- Tax and discount belong to the line, not the invoice.
--
-- Clinicti has always applied one rate to the whole invoice: `invoice_tax_rate`
-- on the clinic, multiplied against `subtotal - discount`. That is wrong for the
-- ordinary case in a real clinic. A visit that includes an exempt medical
-- consultation and a taxable cosmetic procedure is one visit and should be one
-- invoice, and today the only ways to bill it are to get the tax wrong or to
-- split it in two and hand the patient two pieces of paper.
--
-- It is also the shape JoFotara requires: per-line tax, per-line category, and
-- discounts expressed per line rather than once at the bottom.

alter table invoice_items
  add column if not exists discount_amount numeric(12,2) not null default 0
    check (discount_amount >= 0),
  -- UBL 2.1 tax category codes, which is what the XML has to carry:
  --   S = standard rated, Z = zero rated, E = exempt, O = outside the scope of tax.
  -- A clinic that is not registered for sales tax issues everything as 'O'.
  add column if not exists tax_category text not null default 'S'
    check (tax_category in ('S', 'Z', 'E', 'O')),
  add column if not exists tax_rate numeric(5,2) not null default 0
    check (tax_rate >= 0 and tax_rate <= 100),
  add column if not exists tax_amount numeric(12,2) not null default 0;

/*
  The issue date, as its own column.

  `created_at` has been doubling as the invoice date since the beginning. That is
  a timestamp in UTC, and the date a tax authority cares about is the calendar
  date in the clinic's own timezone — which for an invoice raised at 01:30 in
  Amman is the day before. Backfilled accordingly rather than by a bare cast.
*/
alter table invoices add column if not exists issue_date date;

update invoices i
   set issue_date = ((i.created_at at time zone cl.timezone))::date
  from clinics cl
 where cl.id = i.clinic_id and i.issue_date is null;

------------------------------------------------------------------------------
-- Backfill: every existing invoice must still foot
------------------------------------------------------------------------------
/*
  The header discount and rate are spread across the lines in proportion to each
  line's amount, and the rounding remainder is handed to the last line so the
  parts sum exactly to the whole. Distributing without that correction leaves
  invoices a fils out, which is precisely the discrepancy ISTD rejects on.

  The header columns are deliberately NOT recomputed. Payments have already been
  taken against those totals, and moving a stored `total` by a cent could flip a
  settled invoice back to partially_paid. The lines are made to agree with the
  header, never the other way round.
*/
with shares as (
  select
    ii.id,
    ii.invoice_id,
    i.discount_amount as inv_discount,
    i.tax_rate        as inv_rate,
    row_number() over (partition by ii.invoice_id order by ii.sort, ii.id) as rn,
    count(*)     over (partition by ii.invoice_id)                         as n,
    case when i.subtotal > 0
         then round(i.discount_amount * ii.amount / i.subtotal, 2)
         else 0
    end as raw_discount
  from invoice_items ii
  join invoices i on i.id = ii.invoice_id
),
spread as (
  select s.*, sum(s.raw_discount) over (partition by s.invoice_id) as summed
  from shares s
)
update invoice_items ii
   set discount_amount = greatest(
         0,
         sp.raw_discount + case when sp.rn = sp.n then sp.inv_discount - sp.summed else 0 end
       ),
       tax_rate = sp.inv_rate,
       tax_category = case when sp.inv_rate > 0 then 'S' else 'O' end
  from spread sp
 where sp.id = ii.id;

update invoice_items
   set tax_amount = round((amount - discount_amount) * tax_rate / 100, 2)
 where tax_rate > 0;

-- Same remainder correction for tax: the lines are nudged to sum to the header.
with t as (
  select
    ii.id,
    ii.invoice_id,
    i.tax_amount as inv_tax,
    row_number() over (partition by ii.invoice_id order by ii.sort, ii.id) as rn,
    count(*)     over (partition by ii.invoice_id)                         as n,
    sum(ii.tax_amount) over (partition by ii.invoice_id)                   as summed
  from invoice_items ii
  join invoices i on i.id = ii.invoice_id
  where i.tax_rate > 0
)
update invoice_items ii
   set tax_amount = greatest(0, ii.tax_amount + (t.inv_tax - t.summed))
  from t
 where t.id = ii.id and t.rn = t.n and t.inv_tax <> t.summed;
