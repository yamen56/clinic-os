# DECISIONS.md

Decisions made autonomously during the build, with one-line reasoning each.

## Architecture

1. **Embedded PostgreSQL instead of hosted Supabase** — the build machine has no Docker and no Supabase CLI, so the stack runs real PostgreSQL 18 via `embedded-postgres` (no system install), keeping genuine RLS-based tenant isolation and LISTEN/NOTIFY realtime while staying runnable end-to-end locally; the schema is plain Postgres and portable to Supabase later.
2. **Custom session auth instead of Supabase Auth** — no Supabase services available; bcrypt + hashed session tokens in Postgres with httpOnly cookies is equivalent for this deployment shape.
3. **Local-disk storage adapter instead of Supabase Storage** — files live under `./storage/{clinicId}/...` behind an authenticated API route; the adapter is one module so swapping to S3/Supabase later is contained.
4. **SSE + Postgres LISTEN/NOTIFY instead of Supabase Realtime** — DB triggers emit `app_events` notifications; one SSE endpoint per client filters by clinic. Reconnection is silent with automatic refetch.
5. **Postgres jobs table instead of BullMQ/Redis** — the brief explicitly allows "a jobs table if you want fewer moving parts"; no Redis on this machine. Idempotency via unique `dedupe_key` and `FOR UPDATE SKIP LOCKED` claiming.
6. **Single RLS DB role (`clinicos_app`) with `app.is_admin` context for system paths** — the worker and auth layer need cross-clinic access; they run in an audited system context while all clinic-scoped requests set `app.clinic_id`, which RLS enforces. Tests prove isolation.
7. **Path-based public booking (`/book/{slug}`) instead of a subdomain** — no DNS control in local dev; the route structure maps 1:1 to `book.domain.com/{slug}` behind a rewrite in production.

## Product

8. **Platform accent stays in the workspace chrome; clinic branding is applied to the public booking page and invoice PDFs** — keeps the staff UI coherent across clinics while the patient-facing surfaces are fully clinic-branded.
9. **Ambiguous `05…` local numbers default to Saudi (+966) unless the clinic's country is UAE** — SA and AE share the local mobile shape; the clinic's own phone country decides, with SA as the larger Gulf market default.
10. **Doctors don't see Conversations/Invoices/Automations/Settings in nav** — matches the role spec (own calendar, own patients, files, reminders); receptionists see everything except automations/AI unless the owner grants it via per-member permission flags.
11. **Arabic numerals rendered as Latin digits (`ar-JO-u-nu-latn`)** — standard practice in Jordanian/Gulf medical software; phone numbers and prices stay unambiguous.
12. **Owner password set at clinic creation by the agency, existing users are attached by email** — matches the agency-onboards-clinics flow (no self-signup).
13. **TypeScript pinned to 5.x** — npm resolved `typescript@7` (native preview) which Next 15 tooling doesn't support yet.
