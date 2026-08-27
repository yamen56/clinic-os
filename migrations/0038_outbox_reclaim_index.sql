-- The scan that ran every 1.5 seconds against a table that only grows.
--
-- `reclaimStranded()` in worker/outbound.ts puts back messages left in
-- 'sending' by a worker that died mid-send. It is correct and it is cheap to
-- describe, but it had no index to use, so every outbound tick did this:
--
--   Seq Scan on messages (actual time=6.608 rows=0)
--   Rows Removed by Filter: 40212
--
-- Measured on 40k messages. The filter matches almost nothing almost always —
-- that is the point of it — so the whole cost is reading every row to find out.
-- And it is not scoped to a clinic, so the cost is the platform's entire
-- message history, forever. At a hundred clinics with a year of ordinary
-- traffic that is around eleven million rows: roughly 1.8 seconds of scanning
-- every 1.5 seconds, which is one core pinned doing nothing, while evicting
-- shared_buffers on every pass and taking every other query's cache with it.
--
-- A partial index costs nothing to maintain, because the set it indexes is
-- normally empty: a row enters it for the few seconds it is being sent and
-- leaves again. The scan becomes an index scan over those few rows.
--
-- Not CONCURRENTLY: the migration runner wraps each file in a transaction, and
-- this table is small on every database that exists today. If it ever has to be
-- rebuilt on a large one, do that by hand outside a transaction.
create index if not exists messages_stranded_idx
  on messages (updated_at)
  where status = 'sending';
