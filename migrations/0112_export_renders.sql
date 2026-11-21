-- 0112: a table waiting to be printed as a PDF export (2026-11-21).
--
-- Every export button now asks Excel, CSV or PDF. A PDF is drawn by Chromium in
-- the worker from a page of this app, and that page has no session: it cannot
-- re-run the export's query under the member's access (their own invoices,
-- today's only, the claims they work). So the route builds the table under the
-- member's real access, parks it here for the few seconds the render takes,
-- and the print page (/table-print/[id], behind a signed five-minute key) only
-- draws it. The route deletes the row when the PDF is back; anything a failed
-- render left behind is swept on the next export.

create table if not exists export_renders (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists export_renders_created_idx on export_renders (created_at);

alter table export_renders enable row level security;
drop policy if exists tenant_isolation on export_renders;
create policy tenant_isolation on export_renders for all to clinicos_app
  using (app_is_admin() or clinic_id = app_clinic_id())
  with check (app_is_admin() or clinic_id = app_clinic_id());

grant select, insert, update, delete on export_renders to clinicos_app;
