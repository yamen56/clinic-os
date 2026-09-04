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

## Email and its DNS

Transactional mail — staff invitations and password resets — goes out through
Resend. Two things matter and both are DNS, not code.

**The sending domain must be verified in Resend.** Resend rejects any send whose
From domain is not verified on the account, with a 403 at send time. By then
`forgot/actions.ts` has already returned `{ sent: true }` (it must not reveal
whether an address exists), so a wrong `EMAIL_FROM` is completely invisible in
the product — nobody finds out until a locked-out owner says the reset never
arrived. `npm run doctor` checks the From domain against Resend's verified list
for exactly this reason; keep it passing.

Current state, verified against the live account:

| | |
|---|---|
| `EMAIL_FROM` | `Clinicti <system@clinicti.app>` |
| Verified in Resend | `clinicti.app` only |
| SPF | `send.clinicti.app` → `v=spf1 include:amazonses.com ~all` |
| DKIM | `resend._domainkey.clinicti.app` |
| DMARC | `v=DMARC1; p=none; rua=mailto:…` |
| MX | none — `system@clinicti.app` cannot receive, hence `EMAIL_REPLY_TO` |

### Tightening DMARC

`p=none` publishes the policy but asks receivers to do nothing, so a spoofed
Clinicti email is still delivered. Moving to enforcement is the single biggest
deliverability improvement available, and it is a prerequisite for any inbox
logo. Do it in that order, and only after reading a week of `rua` reports to
confirm nothing legitimate is failing alignment:

```
_dmarc.clinicti.app   TXT   "v=DMARC1; p=quarantine; pct=100; rua=mailto:…; fo=1"
```

Go to `p=reject` once quarantine has run clean for a few weeks. Do not skip
straight to `reject` — anything sending as clinicti.app that you have forgotten
about will start bouncing silently.

### The logo beside the sender (BIMI)

The logo already in the message body is `src/emails/render.ts` → `logoUrl()`,
which serves `/assets/mark-light.png`. That is just an `<img>` and needs
nothing.

The logo shown *next to the sender in the inbox list*, before the message is
opened, is a different mechanism: **BIMI**. It needs, in order:

1. DMARC at `p=quarantine` or `p=reject` — see above. `p=none` is not enough.
2. The mark as **SVG Tiny P/S** (`baseProfile="tiny-ps"`, square, a `<title>`,
   no script, no external references, and no embedded raster). `mark-light.png`
   is already the right *design* — white mark centred on a solid navy square —
   but BIMI will not take a PNG, and `src/components/brand-mark.tsx` is explicit
   that the mark is never redrawn in SVG. **The vector has to come from the
   original logo source**, not from tracing the PNG.
3. A record: `default._bimi.clinicti.app TXT "v=BIMI1; l=https://app.clinicti.app/assets/mark.svg; a="`
4. For **Gmail and Apple Mail**, a certificate in the `a=` field — a VMC, which
   requires a *registered trademark* for the mark and runs roughly $1,000–1,500
   a year from DigiCert or Entrust. A CMC is the cheaper non-trademark variant
   but is honoured by fewer clients.

Steps 1–3 cost nothing and get the logo into Yahoo, Fastmail and Zoho. Gmail and
Apple will keep showing initials until step 4 is paid for, so treat the
certificate as a branding purchase to make when there is a trademark and the
volume to justify it — not as a prerequisite for shipping.

---

## Known limits

**Realtime.** Live inbox and calendar updates use Server-Sent Events backed by
Postgres `LISTEN`. One connection per web process, not per stream:
`src/lib/realtime-server.ts` holds a single `LISTEN` and fans out through an
EventEmitter capped at 500 listeners, so the ceiling is ~500 concurrent open
tabs per replica, not a database limit. Streams end and re-open every 60s
(`maxDuration`), which costs one auth query per tab per minute.

**Where it stops scaling.** Measured 2026-08-27, in the order the limits bite:

| Limit | Roughly | Why |
|---|---|---|
| WhatsApp sessions | 60–100 clinics | One Baileys socket per clinic, all in a single worker process (`resumeDesiredSessions`). Unmeasured — estimate only. |
| Slow-lane jobs | ~14,000/day | One AI reply, filing or PDF at a time. `WORKER_SLOW_LANES` raises it. |
| Postgres connections | ~7 web replicas | `max_connections` 100, pool `PG_POOL_MAX` 12 per process. Add PgBouncer past that. |
| Per-clinic data | ~30 MB | A busy multi-year practice: 5k patients, 25k appointments, 40k messages. Every screen's query is under 2ms at that size (`npm run bench`). |

`shared_buffers` is 128 MB and the whole database is far smaller, so raising it
is premature. The trigger to watch is the cache hit ratio — currently 100%:

```sql
select round(100.0*sum(blks_hit)/nullif(sum(blks_hit)+sum(blks_read),0),2) from pg_stat_database;
```

Below ~99% means the working set has outgrown the cache; raise `shared_buffers`
and the instance's RAM then, not before.

**WhatsApp account risk.** Baileys is an unofficial client and WhatsApp can ban
numbers for automated sending. The rails — randomised 3–10s delays, daily caps,
duplicate suppression, auto-pause on repeated errors — reduce the risk without
removing it. Use a number the clinic can afford to lose, never the owner's
personal one.

## Backups

The database is Railway Postgres, so recovery is ours to arrange. A volume
snapshot survives a dead disk; it does not survive a bad migration, a mistaken
delete, or a bug that quietly corrupts a column, because those replicate into a
snapshot as faithfully as anything else. The nightly **logical** backup is the
only thing that does.

The worker dumps every table at a quiet hour and writes a gzipped archive to
object storage under `_system/backups/`. Retention is **14 nightly archives plus
the first archive of each month for a year**. Nothing in the product downloads
them: each file is every patient record in every clinic, and a button on an
admin page would put the whole database one compromised session away from
walking out. Retrieval is deliberate, and it happens with the commands below.

### Is it working?

Two questions, and they fail differently.

- **/admin/monitoring** shows a *Last backup* tile. Red past 36 hours.
- The same page lists the recent archives with their sizes. An archive that
  suddenly weighs a fraction of the one before it is a dump that stopped
  halfway, and no age check would notice.
- The worker's `/health` reports `backupReady` — whether the backup engine
  actually loads *in that process*. This exists because it was once `false` for
  five weeks: `pg-copy-streams` was a devDependency and the worker image
  installs with `npm ci --omit=dev`, so the job threw on every tick and logged
  one line. `qa-backup.ts` now fails if anything the worker imports at runtime
  is a devDependency. **Do not relax that check.**

### The commands

All of them read `.env.production.local`, so no password reaches a shell
history or a process list.

```bash
npm run backup:list      # every archive, newest first, with size and age
npm run backup:verify    # newest archive → throwaway local database → report → drop
```

`backup:verify` needs a local Postgres running (`npm run db`). It is the drill
worth doing on a schedule: an untested backup is a belief, not a safeguard, and
the day you find out which is always the worst available day. A good run ends
`VERIFIED — this archive restores cleanly.` and prints row counts, an Arabic
name, and zero broken keys.

To check one specific archive rather than the newest:

```bash
npx tsx scripts/restore.ts --verify --archive clinicos-2026-09-04T19-11-31.sql.gz
```

### Putting one back

Destructive: every table in the target is emptied and rewritten, and anything
written since the archive was taken is gone.

```bash
npx tsx scripts/restore.ts --into-production \
  --archive clinicos-2026-09-04T19-11-31.sql.gz \
  --confirm railway
```

`--confirm` must be the target database's own name, typed out, or the command
refuses. There is no defaulting to "the newest" here — which archive goes back
is the whole decision, so it has to be named.

Restore the **schema from the migrations**, never from the archive: the script
migrates the target first, so a restored database is built exactly the way
production was rather than inheriting whatever the dump happened to carry.

### The gap that is left

The archives sit in the same bucket as the patient files they protect, and
uploaded files exist **only** there — the database backup stores paths, not
bytes. Object storage survives hardware failure; it does not survive a deleted
bucket or a leaked key. Enabling object versioning on the bucket, and putting
the archives somewhere separate, is the remaining work and it lives in the
Cloudflare account rather than in this repository.
