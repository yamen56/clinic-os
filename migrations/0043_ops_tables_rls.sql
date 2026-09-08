-- The two operations tables, brought inside row-level security.
--
-- 0042 put `ops_alerts` and `ops_state` outside it, and cited `auth_attempts`
-- as the precedent: neither carries a clinic_id, so there is no tenant to
-- isolate. That reasoning was right about confidentiality and is the same
-- reasoning 0029 used — which 0032 then revised, for a reason that applies
-- here too and was not carried across.
--
-- The gap is integrity, not secrecy. A table with no policy is a table any SQL
-- reaching the app role can DELETE from, and what these two hold is the
-- knowledge that something is broken: `ops_alerts` is why somebody finds out
-- the backups have stopped or the worker is failing its jobs, and `ops_state`
-- holds the heartbeat that proves the alerting itself is still alive. Emptying
-- them does not leak anything. It just makes the platform go quiet, which is
-- precisely the state the alerting exists to prevent.
--
-- `ops_alerts.key` also carries clinic ids inside strings like
-- 'whatsapp_down:<clinic id>', so "no tenant data" was already not quite true.
--
-- Every access in src/lib/ops-alert.ts goes through `withSystem` — all fourteen
-- of them — so an admin-only policy costs nothing. Same shape as 0032.
--
-- `_migrations` is deliberately left alone: it is read by the backup and by
-- `scripts/doctor.ts`, it holds nothing worth protecting, and enabling RLS on
-- it would risk those paths for no gain.

alter table ops_alerts enable row level security;
drop policy if exists ops_alerts_access on ops_alerts;
create policy ops_alerts_access on ops_alerts for all to clinicos_app
  using (app_is_admin())
  with check (app_is_admin());

alter table ops_state enable row level security;
drop policy if exists ops_state_access on ops_state;
create policy ops_state_access on ops_state for all to clinicos_app
  using (app_is_admin())
  with check (app_is_admin());
