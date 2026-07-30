-- Bulk WhatsApp campaigns, sent as a drip.
--
-- A campaign never sends anything itself. It paces recipients into the same
-- `messages` outbox every other sender uses, so the number-protection rails
-- already in worker/outbound.ts — randomized gaps, the daily cap, the failure
-- pause — apply unchanged. The campaign's own job is only to decide *when* the
-- next recipient is queued.

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  -- Supports the same {{patient.name}} tokens as automations.
  body text not null,
  -- The patient filter this audience was built from. Kept for display: the
  -- recipient list itself is frozen at creation, because a drip runs for hours
  -- and the audience must not shift underneath it.
  filters jsonb not null default '{}',
  -- Seconds between recipients. Floored well above the outbound sender's own
  -- 3-10s jitter so that pacing, not the sender, is what governs a bulk send.
  interval_seconds integer not null default 120
    check (interval_seconds between 30 and 86400),
  status text not null default 'draft'
    check (status in ('draft', 'running', 'done', 'cancelled')),
  created_by uuid references users(id) on delete set null,
  total_count integer not null default 0,
  -- When the next recipient may be queued. Null while not running.
  next_send_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaigns_clinic_idx on campaigns (clinic_id, created_at desc);
create index campaigns_due_idx on campaigns (next_send_at) where status = 'running';

create table campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  patient_id uuid references patients(id) on delete set null,
  phone_e164 text not null,
  full_name text not null default '',
  -- The drip order. Every recipient is inserted in one statement, so they all
  -- share a created_at and it cannot decide who goes first.
  sort integer not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'queued', 'sent', 'failed', 'cancelled')),
  -- The outbox row this recipient became, once queued.
  message_id uuid references messages(id) on delete set null,
  error text,
  queued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One message per number per campaign, even if two patient files share it.
  unique (campaign_id, phone_e164)
);
create index campaign_recipients_next_idx
  on campaign_recipients (campaign_id, sort) where status = 'pending';
create index campaign_recipients_list_idx on campaign_recipients (campaign_id, sort);
create index campaign_recipients_message_idx on campaign_recipients (message_id);

-- A campaign is a distinct kind of sender: staff-authored like a broadcast, but
-- machine-paced like an automation. It needs its own value because the blast
-- guard keys off sender_kind — see worker/outbound.ts.
alter table messages drop constraint if exists messages_sender_kind_check;
alter table messages add constraint messages_sender_kind_check
  check (sender_kind in ('patient', 'staff', 'automation', 'ai', 'system', 'campaign'));

------------------------------------------------------------------------------
-- Tenant isolation, same policy as every other clinic-scoped table.
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['campaigns', 'campaign_recipients'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()',
      t || '_touch', t);
  end loop;
end $$;

-- Progress is watched live while a campaign drips, so both tables emit.
create trigger campaigns_emit after insert or update or delete on campaigns
  for each row execute function emit_change();
create trigger campaign_recipients_emit after insert or update or delete on campaign_recipients
  for each row execute function emit_change();
