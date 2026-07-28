-- Staff invitations and password resets.
--
-- Invited users exist before they have a password, so password_hash becomes
-- nullable. A null hash means "cannot sign in yet" — verifyPassword refuses it,
-- so an invited-but-unaccepted account is not a login bypass.

alter table users alter column password_hash drop not null;
alter table users add column if not exists email_verified_at timestamptz;

-- Existing accounts were created with a known password, so treat them as verified.
update users set email_verified_at = created_at where email_verified_at is null;

create table if not exists auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- Which clinic the invite is for; null for password resets.
  clinic_id uuid references clinics(id) on delete cascade,
  purpose text not null check (purpose in ('invite', 'reset')),
  -- Only the hash is stored. A database leak cannot be replayed into account
  -- takeover, the same reason password_hash is never stored in the clear.
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists auth_tokens_user_idx on auth_tokens (user_id, purpose, created_at desc);
create index if not exists auth_tokens_expiry_idx on auth_tokens (expires_at) where used_at is null;

alter table auth_tokens enable row level security;

-- Reachable only from the trusted system context (token lookup happens for a
-- signed-out visitor, so there is no clinic context to scope by).
create policy auth_tokens_system on auth_tokens for all to clinicos_app
  using (app_is_admin()) with check (app_is_admin());
