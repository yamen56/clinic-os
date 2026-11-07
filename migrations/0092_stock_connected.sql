-- Stock can be taken apart: deleted from, and read back as a history.
--
-- Yamen, 2026-11-07: "in the supply we want to add more capabilities like delete
-- and make everything more connected to each other". Nothing here changes a
-- table's shape. A product or company that has been used is archived rather than
-- deleted (`active` already says so), because a chart entry and a doctor's share
-- both reach back to it; one that has not is really deleted, by the app.
--
-- Three reads that are new: a delivery's history (batch), the delivery behind an
-- expense, and a product's movements newest first.

create index if not exists stock_moves_batch_idx on stock_moves (batch_id) where batch_id is not null;
create index if not exists stock_batches_expense_idx on stock_batches (expense_id) where expense_id is not null;
create index if not exists stock_moves_ledger_idx on stock_moves (clinic_id, product_id, at desc);

-- Units stranded by a void.
--
-- A treatment recorded with nothing on hand takes its units from the no-batch
-- line, and the next delivery settles that line out of its batch. Voiding the
-- treatment afterwards put the units back on the no-batch line, where no
-- treatment can reach them, and left the delivery short by the same amount: the
-- page said they were on hand and the chart said they were not.
--
-- returnStock now hands them to the delivery that settled them. This does the
-- same for what is already stranded, newest delivery first. A second run finds
-- nothing left over and does nothing.
do $$
declare
  stranded record;
  settled record;
  owing numeric;
  take numeric;
begin
  for stranded in
    select clinic_id, product_id, sum(qty) as surplus
      from stock_moves
     where batch_id is null
     group by clinic_id, product_id
    having sum(qty) > 0
  loop
    owing := stranded.surplus;
    for settled in
      select batch_id, -sum(qty) as amount, max(unit_cost) as unit_cost
        from stock_moves
       where product_id = stranded.product_id and batch_id is not null
         and kind = 'adjust' and reason in ('used before it was received', 'voided after it was settled')
       group by batch_id
       order by max(at) desc
    loop
      exit when owing <= 0;
      take := least(owing, settled.amount);
      if take > 0 then
        insert into stock_moves (clinic_id, product_id, batch_id, kind, qty, unit_cost, reason)
        values
          (stranded.clinic_id, stranded.product_id, settled.batch_id, 'adjust', take, settled.unit_cost, 'voided after it was settled'),
          (stranded.clinic_id, stranded.product_id, null, 'adjust', -take, 0, 'voided after it was settled');
        owing := owing - take;
      end if;
    end loop;
  end loop;
end $$;
