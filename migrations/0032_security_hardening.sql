-- Security hardening: the one table that was outside row-level security.
--
-- Every other table in this database has RLS on and a policy that ties rows to
-- a clinic, a user, or the admin context. `auth_attempts` shipped without one
-- because it holds no tenant data — it is failed sign-ins, keyed by address and
-- by email address, and the reasoning at the time was that there is nothing in
-- it to isolate.
--
-- That reasoning is about confidentiality alone, and it misses the other half.
-- The rows in this table are what stops a password being guessed; a table with
-- no policy is one any SQL reaching the app role can *delete* from, which turns
-- the lockout off rather than reads it. It also breaks the invariant that makes
-- the RLS proof in scripts/test-rls.ts meaningful — "every table is covered" is
-- checkable, "every table except this one, for a reason recorded in a commit
-- message" is not.
--
-- So: same shape as the rest. Only the admin context, which is the only context
-- that ever touches it — lib/auth-throttle runs entirely inside withSystem().

alter table auth_attempts enable row level security;

drop policy if exists auth_attempts_access on auth_attempts;
create policy auth_attempts_access on auth_attempts for all to clinicos_app
  using (app_is_admin())
  with check (app_is_admin());
