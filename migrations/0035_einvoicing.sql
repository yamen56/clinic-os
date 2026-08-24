-- JoFotara: filing a clinic's invoices with the Jordanian tax authority.
--
-- Since 1 April 2025 a taxpayer inside the e-invoicing net must issue through
-- JoFotara, the ISTD national platform. A clinic on Clinicti has been raising
-- the invoice here and then re-typing it into the JoFotara portal to get the
-- stamp - double entry on every sale, and two copies that drift.
--
-- Each clinic is its own taxpayer with its own ISTD registration, so every
-- credential here is per clinic. Nothing is shared and nothing is the agency's.

------------------------------------------------------------------------------
-- 1. The clinic's ISTD identity and device credentials
------------------------------------------------------------------------------
/*
  A table of its own rather than columns on `clinics`, for one specific reason:
  several server components select `cl.*` and hand the row to a client
  component as props. A secret key on `clinics` would eventually ride along into
  a browser payload without anybody deciding it should. Keeping it in a table
  nothing selects casually makes that mistake impossible rather than unlikely.

  Follows the `whatsapp_auth_state` precedent - tenant-isolated by RLS, read by
  the worker under withSystem, never returned to the browser. Like that table it
  is stored in plain text: this codebase has no encryption helper, and inventing
  one here would put the key management problem somewhere nobody would find it.
  The bar is the same one the WhatsApp credentials already meet.
*/
create table if not exists clinic_einvoice_settings (
  clinic_id uuid primary key references clinics(id) on delete cascade,
  enabled boolean not null default false,

  /*
    Which of ISTD's three invoice shapes this clinic issues.

    'income'  - an income-tax taxpayer. Charges no sales tax at all and has no
                income-source sequence. This is most small clinics in Jordan:
                the registration threshold for services is JOD 30,000.
    'general' - registered for general sales tax. Tax per line, 16% or 15%.

    The third shape, special sales tax, is not offered: it applies to a short
    list of goods that no clinic sells, and a menu entry nobody should pick is
    a menu entry somebody eventually picks.
  */
  taxpayer_type text not null default 'income' check (taxpayer_type in ('income', 'general')),

  -- Exactly as registered with ISTD. A name that merely resembles it is rejected.
  registered_name text not null default '',
  tax_number text not null default '',
  -- "Activity number" on the portal. Required for general, absent for income.
  income_source_sequence text not null default '',

  -- Issued by creating a "device" on the JoFotara portal.
  client_id text not null default '',
  secret_key text not null default '',

  -- Points at a test device while a clinic is being onboarded.
  environment text not null default 'production' check (environment in ('production', 'sandbox')),

  last_ok_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

------------------------------------------------------------------------------
-- 2. What came back from ISTD, on the invoice
------------------------------------------------------------------------------
alter table invoices
  /*
    'not_required' is the state of every invoice in every clinic that does not
    use this, which is all of them today. It is the default deliberately: the
    submission path has to be something an invoice opts into, not something it
    has to escape from.
  */
  add column if not exists einvoice_status text not null default 'not_required'
    check (einvoice_status in ('not_required', 'pending', 'submitted', 'failed')),
  -- Ours, generated before sending: UBL requires a UUID we choose and ISTD
  -- echoes back, which is what makes a retry idempotent at their end too.
  add column if not exists einvoice_uuid text,
  -- Theirs: the QR payload that must be printed on the invoice.
  add column if not exists einvoice_qr text,
  add column if not exists einvoice_number text,
  -- UN/CEFACT 1001: 388 invoice, 381 credit note.
  add column if not exists einvoice_type text
    check (einvoice_type is null or einvoice_type in ('388', '381')),
  -- ISTD payment method: 012 cash, 022 receivable.
  add column if not exists einvoice_payment_method text
    check (einvoice_payment_method is null or einvoice_payment_method in ('012', '022')),
  add column if not exists einvoice_submitted_at timestamptz,
  add column if not exists einvoice_error text,

  /*
    Corrections. ISTD has no delete - a credit note referencing the original is
    the only way back, so voiding a stamped invoice raises one of these rather
    than flipping a status and hoping.
  */
  add column if not exists credit_note_of uuid references invoices(id) on delete set null,
  add column if not exists void_reason text not null default '',
  add column if not exists voided_at timestamptz;

-- The submission worklist is "everything still owed to ISTD", read by status.
create index if not exists invoices_einvoice_idx on invoices (clinic_id, einvoice_status)
  where einvoice_status in ('pending', 'failed');
create index if not exists invoices_credit_note_idx on invoices (credit_note_of)
  where credit_note_of is not null;

------------------------------------------------------------------------------
-- 3. The submission trail
------------------------------------------------------------------------------
/*
  Per invoice, mirroring `document_events` rather than `audit_log`. The audit log
  has no clinic-facing viewer and is scoped to a person doing something; this is
  a machine talking to a tax authority, and the clinic has to be able to read
  back exactly what was sent and what came back when ISTD asks.
*/
create table if not exists invoice_einvoice_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  kind text not null check (kind in ('queued', 'submitted', 'accepted', 'rejected', 'error')),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists invoice_einvoice_events_idx
  on invoice_einvoice_events (invoice_id, created_at desc);

------------------------------------------------------------------------------
-- 4. Licence: off everywhere, on for the demo
------------------------------------------------------------------------------
/*
  Written explicitly rather than left absent. `resolveFeatures` treats an opt-in
  module's missing key as off, so this is belt-and-braces - but a stored `false`
  is also what makes the agency's module picker show the real answer instead of
  an inferred one.
*/
update clinics set features = coalesce(features, '{}'::jsonb) || '{"einvoicing": false}'::jsonb
 where not (features ? 'einvoicing');

update clinics set features = features || '{"einvoicing": true}'::jsonb where slug = 'demo';

------------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['clinic_einvoice_settings', 'invoice_einvoice_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I for all to clinicos_app using (app_is_admin() or clinic_id = app_clinic_id()) with check (app_is_admin() or clinic_id = app_clinic_id())',
      t);
  end loop;
end $$;

-- Only the settings table has updated_at; the event log is append-only.
drop trigger if exists clinic_einvoice_settings_touch on clinic_einvoice_settings;
create trigger clinic_einvoice_settings_touch before update on clinic_einvoice_settings
  for each row execute function touch_updated_at();
