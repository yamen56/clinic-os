# DECISIONS.md

Decisions made autonomously during the build, with one line of reasoning each.

## Infrastructure substitutions

The brief specified Supabase and BullMQ/Redis. Neither was installable here — the machine has no Docker, no Supabase CLI, and no Redis. Each substitution below keeps the capability the brief actually depends on and stays portable.

1. **Embedded PostgreSQL instead of hosted Supabase** — runs real PostgreSQL 18 in-process via `embedded-postgres`, so tenant isolation is genuine Row Level Security and realtime is genuine `LISTEN/NOTIFY`. The schema is plain SQL; pointing `DATABASE_URL` at Supabase and running `npm run migrate` moves the whole thing over, RLS policies included.
2. **Custom session auth instead of Supabase Auth** — bcrypt password hashes plus SHA-256-hashed session tokens in Postgres, delivered as httpOnly cookies. Same security properties for this deployment shape, no external dependency.
3. **Local-disk storage adapter instead of Supabase Storage** — files live under `./storage/{clinicId}/…` behind authenticated API routes. `src/lib/storage.ts` is the only module that touches disk, so swapping to S3 or Supabase Storage is contained to one file.
4. **SSE over Postgres LISTEN/NOTIFY instead of Supabase Realtime** — database triggers emit `app_events`; one SSE endpoint per clinic fans them out. Reconnects are silent and refetch on resubscribe.
5. **Postgres `jobs` table instead of BullMQ/Redis** — the brief explicitly permits this ("a jobs table if you want fewer moving parts"). Claiming uses `FOR UPDATE SKIP LOCKED` so multiple workers never double-process; `dedupe_key` gives idempotency.
6. **PDF generation via headless Chromium instead of react-pdf** — the invoice *is* a real page (`/inv/{token}`), rendered to PDF by Playwright's Chromium. This was the only approach that gave correct Arabic shaping and RTL table layout without hand-managing font subsets.

## Security and tenancy

7. **One database role (`clinicos_app`, no BYPASSRLS) with an `app.is_admin` escape hatch** — the worker and the auth layer legitimately span clinics. They run in an audited system context; every clinic-scoped request sets `app.clinic_id`, which RLS enforces. `npm run test:rls` asserts isolation on all 29 clinic-scoped tables plus cross-tenant insert and update attempts.
8. **Impersonation issues a separate session carrying `impersonated_by`** — support access is visibly banner-flagged in the workspace, every action is attributable, and exiting destroys that session rather than just navigating away.

## Product

9. **Path-based public booking (`/book/{slug}`) rather than a subdomain** — no DNS control in local dev; the route maps 1:1 to `book.domain.com/{slug}` behind a production rewrite.
10. **Platform accent in the staff workspace, clinic branding on patient-facing surfaces** — the booking page and invoice PDFs carry the clinic's logo and colour; the staff UI stays visually consistent so agency support isn't relearning a new skin per clinic.
11. **Ambiguous `05…` local numbers resolve to Saudi (+966) unless the clinic's country is UAE** — SA and AE share the local mobile shape; SA is the larger Gulf market, and the clinic's own country breaks the tie.
12. **Doctors don't see Conversations, Invoices, Automations, or Settings** — matches the role spec. Receptionists see everything except automations and AI unless the owner grants it via a per-member permission flag.
13. **Arabic UI renders Latin digits (`ar-JO-u-nu-latn`)** — standard in Jordanian and Gulf medical software; keeps phone numbers, prices, and times unambiguous.
14. **WhatsApp offline doesn't block online booking** — if the clinic's WhatsApp is down, the booking page skips phone verification, books anyway, and flags the appointment as unverified rather than losing the patient.
15. **The AI receptionist defaults to after-hours only** — staff cover the day; the agent covers nights and weekends. It's the safest default for a clinic switching it on for the first time, and it's one dropdown to change.
16. **AI answers strictly from the clinic's knowledge base plus live calendar** — no general knowledge, no invented prices. Anything it wasn't taught becomes a staff handoff. Every AI message is labelled in the inbox for auditing.
17. **AI runs at `effort: "low"`** — a receptionist turn is short and scoped (answer from a fixed knowledge base, check availability, book), and WhatsApp replies are latency-sensitive. The model is per-clinic configurable if a clinic wants more.
18. **Automation idempotency is scoped to (automation, patient, appointment, invoice)** — not to the run. A replayed trigger creates a new run, so run-scoped deduplication would have let the same reminder go out twice; this scope survives both retries and replays.
19. **Critical alerts fall back to WhatsApp when push fails** — WhatsApp disconnection, repeated send errors, and AI escalations reach staff on their own number if no push subscription is live, since those are exactly the failures that make the app itself untrustworthy.

## Build and tooling

20. **TypeScript pinned to 5.x** — npm resolved `typescript@7` (native preview), which Next 15's tooling doesn't support yet.
21. **Baileys pinned to 6.7.21** — 7.0.0-rc13 pulls `whatsapp-rust-bridge`, whose package exports break Node's resolver on this platform.
22. **PostgreSQL cluster initialised with `--encoding=UTF8 --locale=C`** — Windows `initdb` defaults to WIN1252, which cannot store Arabic at all. This was caught by the first end-to-end test rather than in review.
23. **The AI receptionist is QA'd against a local Messages API double** — no `ANTHROPIC_API_KEY` is available in this environment. The double exercises the agent's real code path end to end (tool calls, availability lookup, booking through the identity rule, escalation, usage accounting); only Anthropic's model is stubbed. Set the key to run it live.
24. **Web push is QA'd against a local TLS endpoint** — encryption, delivery, and pruning of revoked subscriptions are all verified for real. Headless browsers can't reach a live push service, so `pushManager.subscribe()` itself is only exercised as far as the permission grant.
