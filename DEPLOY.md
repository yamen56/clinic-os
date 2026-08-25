# Deploying Clinicti

Everything runs on **Railway**, in one project, as three services.

| Service | What it is | Built from |
|---|---|---|
| `clinic-web` | The Next.js app | `Dockerfile.web` |
| `clinic-os` | The worker — WhatsApp, scheduler, AI, PDFs | `Dockerfile.worker` |
| `Postgres-EU` | The database | Railway's Postgres image |

Files live in **Cloudflare R2** (S3-compatible, private bucket).

**The worker cannot be serverless.** Baileys holds a live WebSocket per clinic;
a function that dies after seconds would drop every session and force a QR
rescan. It also owns the scheduler — reminders, recalls, birthdays — which needs
a clock that keeps running, and it renders PDFs with headless Chromium.

The web service is a container too, so the two differ by job rather than by
runtime: the worker is the one that must never be asleep.

---

## Day-to-day: shipping a change

```bash
npm run typecheck
npm run qa              # needs the local stack up: npm run dev:all
npm run migrate:prod    # only when migrations/ has something new
git push origin main
npm run deploy
```

`npm run deploy` is not optional politeness — **GitHub auto-deploy does not fire
on this project**. It also passes the commit SHA explicitly, which matters more
than it sounds: Railway's deploy mutation rebuilds whatever commit the service
is *pinned* to unless told otherwise, so a push plus a naive redeploy reports
SUCCESS while shipping nothing. See `scripts/deploy.ts`.

```bash
npm run deploy --status   # what is actually live
npm run deploy -- --web   # one service only
```

Migrations run twice, harmlessly: `migrate:prod` applies them from your machine
before the deploy, and the worker container runs them again on boot. Both are
idempotent. Running them first is what stops the new code meeting the old schema
during the rollout.

---

## Setting it up from scratch

### 1. Database

Add a Postgres service to the Railway project. Then, from your machine, with
`DATABASE_SUPER_URL` pointing at it:

```bash
npm run migrate
```

That creates the schema, the `clinicos_app` role and every RLS policy. The app
connects as `clinicos_app` — **never** as `postgres`, which would bypass tenant
isolation entirely.

Seed the shared defaults (automation recipes, AI knowledge structure):

```bash
DATABASE_SUPER_URL="…" npm run seed:recipes
```

Skip `npm run seed` in production — that creates the fictional demo clinic.

### 2. Storage

Create a **private** R2 bucket named `clinic-files` and an S3 API token. Files
are served through the app, which checks clinic membership first; a public
bucket would expose patient documents to anyone holding a URL.

### 3. The two app services

For each: **New service → Deploy from GitHub repo**, then set the Dockerfile
path (`Dockerfile.web` / `Dockerfile.worker`) — or let `railway.web.json` and
`railway.worker.json` do it. Generate a domain for each.

Copy the variables from `.env.production.example`. The split that matters:

- `DATABASE_SUPER_URL` and `ANTHROPIC_API_KEY` are **worker-only**. The web
  service has no business holding superuser credentials.
- `SESSION_SECRET` is **web-only**.
- `APP_URL`, `WORKER_URL` and `INTERNAL_API_SECRET` must be set on **both**, and
  `INTERNAL_API_SECRET` must be byte-identical, or invoice PDFs fail (the web
  app calls the worker to render them) and the WhatsApp QR never appears (same
  reason).

Verify with `npm run doctor`, or just create an invoice and open the WhatsApp
settings page.

### 4. The first real clinic

Sign in at `/admin` and use **New clinic**. Do not use the demo seed for a real
customer — it carries invented patients and appointments.

---

## Known limits

**Realtime.** Live inbox and calendar updates use Server-Sent Events backed by
Postgres `LISTEN`. Each open stream holds a database connection; if you outgrow
the connection limit, move the SSE endpoint onto the worker, which can hold one
`LISTEN` for everyone.

**WhatsApp account risk.** Baileys is an unofficial client and WhatsApp can ban
numbers for automated sending. The rails — randomised 3–10s delays, daily caps,
duplicate suppression, auto-pause on repeated errors — reduce the risk without
removing it. Use a number the clinic can afford to lose, never the owner's
personal one.

**Backups.** `npm run qa:backup` exercises dump and restore, but check the
retention on the Postgres service before real patient data lands. This is
medical data.
