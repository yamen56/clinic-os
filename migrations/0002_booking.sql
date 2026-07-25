-- Public booking: WhatsApp OTP verification attempts

create table booking_verifications (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  phone_e164 text not null,
  code text not null,
  payload jsonb not null default '{}',
  attempts integer not null default 0,
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create index booking_verifications_phone_idx on booking_verifications (clinic_id, phone_e164, created_at desc);

alter table booking_verifications enable row level security;
create policy tenant_isolation on booking_verifications for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());
