-- Brute force protection for the two doors that had none.
--
-- Public booking and signing have been rate limited since they shipped; sign-in
-- and password-reset never were. A password could be guessed at whatever rate
-- the network allowed, against every account at once, and nothing recorded that
-- it was happening.
--
-- In a table rather than in memory, unlike `rateLimit()` in booking-public.ts.
-- That one is fine for its job: a fixed window per caller on an endpoint where
-- losing the count costs nothing. Auth is different. An in-memory counter is
-- cleared by every deploy and every restart, and is not shared if the service
-- ever runs more than one replica — so the lockout that matters most is the one
-- most easily lost. Failures are rare enough that a row each is cheap.

create table if not exists auth_attempts (
  id bigserial primary key,
  -- 'login' | 'reset'. Separate scopes so a reset flood cannot lock out sign-in.
  scope text not null,
  -- 'ip:1.2.3.4' or 'email:someone@clinic.com'. Both are counted: the address
  -- catches one attacker working through many accounts, the email catches many
  -- addresses working on one account.
  key text not null,
  created_at timestamptz not null default now()
);

create index if not exists auth_attempts_lookup
  on auth_attempts (scope, key, created_at desc);
-- Pruning reads by age alone, and would otherwise scan the table.
create index if not exists auth_attempts_age on auth_attempts (created_at);
