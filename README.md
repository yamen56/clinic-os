# Clinic OS

A multi-tenant clinic management platform, operated by an agency (Makan Scaling) that onboards clinics as tenants. Each clinic gets an isolated workspace: patients, WhatsApp conversations, calendar, invoices, automations, and an AI receptionist. The agency gets a separate admin panel over all of them.

Arabic-first (RTL) with an English toggle, built for Jordan and the Gulf.

---

## Quick start

```bash
cp .env.example .env   # only if .env is missing
npm install            # also fetches the Chromium used for invoice PDFs
npm run dev:all        # database + web app + worker in one terminal
```

`dev:all` applies pending migrations on boot and seeds the demo clinic when the database is empty, so this is the only command needed from a fresh clone.

Check readiness at any time:

```bash
npm run doctor         # every line is either fine, or the exact command that fixes it
```

Then open **http://localhost:3000** and sign in:

| Role | Email | Password |
|---|---|---|
| Agency admin | `admin@makan.agency` | `admin1234` |
| Clinic owner | `rima@clinic.jo` | `clinic1234` |
| Doctor | `dr.omar@clinic.jo` | `clinic1234` |
| Receptionist | `reception@clinic.jo` | `clinic1234` |

Demo clinic workspace: `/c/rima-dental` · public booking page: `/book/rima-dental`

### Running the pieces separately

```bash
npm run db       # embedded PostgreSQL + migrations (keep running)
npm run dev      # Next.js app on :3000
npm run worker   # WhatsApp, automations, AI, notifications on :4020
npm run seed     # reset the demo clinic with fresh Arabic data
```

The worker is a **long-running process** and cannot run on serverless — it holds one WhatsApp session per clinic.

---

## Architecture

| Piece | What it does |
|---|---|
| `src/app` | Next.js (App Router) — clinic workspace, agency admin, public booking, public invoices |
| `worker/` | Long-running Node process: Baileys WhatsApp sessions, outbound sender, job runner, automation engine, scheduler, AI receptionist, push delivery |
| `migrations/` | Plain SQL, applied in order, tracked in `_migrations` |
| `scripts/` | Dev database, seeds, and the per-phase QA suites |

**Tenant isolation** is enforced in PostgreSQL with Row Level Security on every table keyed by `clinic_id`. The app connects as `clinicos_app` (no `BYPASSRLS`) and sets `app.clinic_id` per transaction, so a query can only ever see one clinic's rows. `npm run test:rls` proves it across all 29 clinic-scoped tables.

**Realtime** uses PostgreSQL `LISTEN/NOTIFY` triggers fanned out to browsers over one SSE endpoint per clinic. Dropped connections resubscribe silently and refetch.

**Jobs and automations** live in a `jobs` table claimed with `FOR UPDATE SKIP LOCKED`, so multiple worker instances never double-process. Automation runs are idempotent: one active run per (automation, patient, appointment, invoice), and a replayed trigger never re-sends the same message.

---

## Environment variables

Copy `.env.example` to `.env`. Everything except the two marked optional has a working local default.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | App connection, as the RLS-bound `clinicos_app` role. |
| `DATABASE_SUPER_URL` | Superuser connection used only by migrations and seeds. |
| `PG_PORT` | Port for the embedded PostgreSQL instance (default `5544`). |
| `APP_URL` | Public base URL. Used in WhatsApp message links and invoice PDFs. |
| `WORKER_URL` | Where the web app reaches the worker's internal API (default `http://localhost:4020`). |
| `INTERNAL_API_SECRET` | Shared secret between the web app and the worker. **Change in production.** |
| `SESSION_SECRET` | Reserved for future signed-cookie use. **Change in production.** |
| `STORAGE_DIR` | Where uploaded files, WhatsApp media, and invoice PDFs are written. |
| `ANTHROPIC_API_KEY` | *Optional.* Enables the AI receptionist. Without it the agent stays off and escalates to staff. |
| `ANTHROPIC_MODEL` | Fallback model when a clinic hasn't picked one (per-clinic setting wins). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web push credentials. Generate with `npx web-push generate-vapid-keys`. |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Same public key, exposed to the browser to subscribe. Must match `VAPID_PUBLIC_KEY`. |

---

## Connecting WhatsApp

1. Start the worker (`npm run worker`).
2. In a clinic workspace go to **Settings → WhatsApp** and press **Connect WhatsApp**.
3. Scan the QR with the phone that owns the clinic's number (WhatsApp → Linked devices).

The session is persisted per clinic in `whatsapp_auth_state`, so restarts reconnect without a new QR. A crash in one clinic's session never affects another.

**Number protection** is always on: 3–10 second randomized gaps between sends, a configurable daily cap, a guard against blasting identical automation text to many numbers, and automatic pausing plus an owner alert after repeated send failures.

---

## Testing

```bash
npm run typecheck    # app + worker
npm run test:phone   # phone normalization (JO / SA / AE, Arabic-Indic digits)
npm run test:rls     # tenant isolation across every clinic-scoped table
npm run qa           # all ten browser QA suites in order
```

The QA suites drive a real browser against the running app and assert against the database. They need `npm run dev:all` running first. Individual suites: `npx tsx scripts/qa-phase3.ts`, etc.

Two things are exercised against local doubles rather than live third parties, because both need credentials this environment doesn't have:

- **The AI receptionist** runs against `scripts/mock-anthropic.ts`, which speaks the Messages API. The agent's real code path — tool calls, availability lookup, booking, escalation, DB writes — is fully exercised; only Anthropic's model is stubbed. Set `ANTHROPIC_API_KEY` to run it for real.
- **Web push delivery** is verified against a local TLS endpoint (encryption, delivery, and pruning of revoked subscriptions all run for real). Browsers in headless mode can't reach a live push service, so `pushManager.subscribe()` itself is only exercised up to the permission grant.

---

## Deploying

- **Web app** — any Node host that runs Next.js. Needs `DATABASE_URL`, `APP_URL`, `INTERNAL_API_SECRET`, `WORKER_URL`, and the VAPID keys.
- **Worker** — a persistent host (Railway, Fly.io, a VPS). Never serverless. Needs the same `DATABASE_URL` and `INTERNAL_API_SECRET`, plus `ANTHROPIC_API_KEY` if the AI agent is used.
- **Database** — the schema is plain PostgreSQL. To move to a hosted Postgres or Supabase, point `DATABASE_URL` at it and run `npm run migrate`; the RLS policies come along with the migrations.
- **Storage** — `src/lib/storage.ts` is the only module that touches disk. Swap it for S3 or Supabase Storage without changing callers.
- **Booking subdomain** — `book.domain.com/{slug}` maps to `/book/{slug}` with a rewrite.

See `DECISIONS.md` for the reasoning behind each substitution made during the build.
