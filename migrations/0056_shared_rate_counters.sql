-- Rate limits that survive a second web instance.
--
-- The public limiters in `lib/booking-public.ts` counted into a `Map` in the
-- process that happened to take the request. That is correct on one instance
-- and quietly wrong on two: each replica keeps its own tally, so the effective
-- allowance is the written number times the replica count. For a read endpoint
-- that only means a looser flood floor. For these it means something worse —
-- `start-phone` caps how many WhatsApp one-time codes a single phone number can
-- be sent, and `verify` caps how many guesses somebody gets at a six-digit code
-- before the door shuts. Four replicas turn 3 codes into 12 and 20 guesses into
-- 80, and nothing anywhere would report it.
--
-- So the counters that gate a side effect or a guess move here, where there is
-- one tally no matter how many processes are serving. The cheap in-process
-- floor stays in front of them (see `rateLimit`), because a shared counter
-- costs a round trip and the read endpoints do not need one.
--
-- Fixed windows, like the map it replaces: the bucket key carries its own
-- window index, so a window rotates by being a different row rather than by
-- anything having to expire it on time.

create table if not exists rate_counters (
  -- '<caller key>@<window start ms>'. The window is in the key, so two
  -- consecutive windows are two rows and neither can see the other's count.
  bucket text primary key,
  count int not null default 0,
  -- Only for pruning. Nothing reads it to decide whether a window is live —
  -- that is what the window index in `bucket` is for, and a clock skew between
  -- replicas must never be able to resurrect a spent window.
  expires_at timestamptz not null
);

-- Pruning reads by age alone and would otherwise scan the table.
create index if not exists rate_counters_expiry on rate_counters (expires_at);

-- Same shape as auth_attempts (0032) and the ops tables (0043), and for the
-- integrity reason rather than the confidentiality one: there is no tenant in
-- here to isolate, but a table any SQL reaching the app role could DELETE from
-- is a rate limit an attacker can reset. Every caller goes through
-- `withSystem`, so admin-only costs nothing.
alter table rate_counters enable row level security;
drop policy if exists rate_counters_access on rate_counters;
create policy rate_counters_access on rate_counters for all to clinicos_app
  using (app_is_admin())
  with check (app_is_admin());
