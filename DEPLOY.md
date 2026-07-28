# Deploying Clinic OS

Three services. They are separate because they have genuinely different needs —
this is not an arrangement you can collapse into one Vercel project.

| Service | Host | Why there |
|---|---|---|
| Web app | Vercel | Next.js, serverless, scales to zero |
| Worker | Railway | Holds a live WhatsApp socket per clinic — **must stay awake** |
| Postgres + files | Supabase | Managed, backed up, S3-compatible storage |

**The worker cannot run on Vercel.** Baileys keeps a persistent WebSocket to
WhatsApp; a serverless function dies after seconds and would drop every session,
forcing a QR rescan. It also owns the scheduler (reminders, recalls, birthdays),
which needs a clock that keeps running.

---

## 1. Supabase — database and storage

1. Create a project. Save the database password it shows you; it is not shown again.
2. **Storage → New bucket** → name it `clinic-files`, keep it **private**. Files are
   served through the app, which checks clinic membership first. A public bucket
   would expose patient documents to anyone with a URL.
3. **Project Settings → Storage → S3 access keys** → create one. Note the key,
   secret, and the S3 endpoint.
4. **Project Settings → Database → Connection string (URI)** → note it.

Then run the migrations from your machine, once:

```bash
DATABASE_SUPER_URL="postgresql://postgres:YOUR_DB_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres" \
APP_DB_PASSWORD="a-long-random-password" \
npm run migrate
```

This creates the schema, the `clinicos_app` role, and every RLS policy. The app
connects as `clinicos_app` — never as `postgres`, which would bypass tenant
isolation entirely.

Seed the agency defaults (automation recipes, AI knowledge structure):

```bash
DATABASE_SUPER_URL="…same as above…" npm run seed:recipes
```

Skip `npm run seed` in production — that creates the fictional demo clinic.

## 2. GitHub

```bash
git remote add origin https://github.com/YOUR_USER/clinic-os.git
git push -u origin main
```

`.env` is gitignored. Never commit it — it holds the session secret and database
password.

## 3. Railway — the worker

1. **New Project → Deploy from GitHub repo** → pick this repo.
2. **Settings → Build** → set Dockerfile path to `Dockerfile.worker`.
3. **Settings → Networking** → Generate Domain. Note the URL.
4. **Variables** → add everything from `.env.production.example` except
   `SESSION_SECRET` (web-only). The worker needs `DATABASE_SUPER_URL` because it
   applies migrations on boot.

The container runs migrations then starts the worker. Both are idempotent, so
redeploys are safe.

## 4. Vercel — the web app

1. **Add New → Project** → import the repo. Framework is detected automatically.
2. **Environment Variables** → add everything from `.env.production.example`
   **except** `DATABASE_SUPER_URL` and `ANTHROPIC_API_KEY` (worker-only). Vercel
   should never hold superuser database credentials.
3. Deploy, then set `APP_URL` to the real deployment URL and redeploy.

## 5. Close the loop

`APP_URL` and `WORKER_URL` must be set correctly **on both** services, and
`INTERNAL_API_SECRET` must be byte-identical, or:

- invoice PDFs fail (Vercel calls the worker to render them)
- the WhatsApp QR never appears (Vercel calls the worker to start a session)

Verify with `npm run doctor` pointed at production, or just create an invoice and
open the WhatsApp settings page.

## 6. Create the first real clinic

Sign in at `/admin` with the agency account, then **New clinic**. Do not use the
demo seed for a real customer — it carries invented patients and appointments.

---

## Known limits

**Realtime on Vercel.** Live inbox and calendar updates use Server-Sent Events
backed by Postgres `LISTEN`. Serverless caps stream duration, so the connection
recycles about once a minute; the client reconnects and resyncs silently, but it
is not a permanently open socket. Each open stream also holds a database
connection — if you outgrow Supabase's connection limit, move the SSE endpoint
onto the worker, which can hold one `LISTEN` for everyone.

**WhatsApp account risk.** Baileys is an unofficial client. WhatsApp can ban
numbers for automated sending. The safety rails (randomised 3–10s delays, daily
caps, duplicate suppression, auto-pause on repeated errors) reduce the risk but
do not remove it. Use a number the clinic can afford to lose, and never the
owner's personal number.

**Backups.** Supabase's free tier keeps limited backups. Before real patient data
lands, check the retention on your plan — this is medical data.
