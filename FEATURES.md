# Clinicti (CLINIC OS) — Complete Feature Reference

> Knowledge file. Describes **what the product does**, feature by feature, with the exact
> enum values, defaults, limits and file locations behind each one. Written to be handed to
> an assistant as context. Everything here is drawn from the codebase, not from a spec.
>
> Verified against the tree on 2026-08-12.

---

## Contents

1. What the product is · 2. Actors and access model · 3. Authentication & identity · 4. Patients · 5. Bringing an existing clinic's records in · 6. Calendar & appointments · 7. Waitlist · 8. Services · 9. Public online booking · 10. WhatsApp inbox & messaging · 11. Campaigns (bulk WhatsApp, drip-paced) · 12. Document signing (ESIGN module) · 13. Automations · 14. AI receptionist · 15. Invoices & payments · 16. Insurance & claims · 17. Dashboard · 18. Notifications & PWA · 19. Realtime · 20. Agency admin panel (/admin) · 21. Settings inventory (per clinic) · 22. Files, storage & backups · 23. Jobs, scheduler and the worker · 24. Internationalisation · 25. Phone handling (src/lib/phone.ts) · 26. Data model reference · 27. Route map · 28. Commands · 29. Environment variables · 30. Brand & attribution · 31. Design decisions worth knowing

---

## 1. What the product is

A **multi-tenant clinic management platform** operated by an agency (Makan Scaling) that
onboards clinics as tenants. Each clinic gets an isolated workspace containing patients,
a WhatsApp inbox, a calendar, invoices, e-signature documents, marketing campaigns,
automations and an AI receptionist. The agency gets a separate admin panel spanning all
tenants.

- **Arabic-first (RTL)** with an English toggle. Built for **Jordan and the Gulf**.
- Arabic UI renders **Latin digits** (`ar-JO-u-nu-latn`) — standard in Jordanian/Gulf
  medical software, keeps phone numbers, prices and times unambiguous.
- Default timezone `Asia/Amman`, default currency `JOD`, default locale `ar`.
- Package name `clinic-os`, described as "Clinicti — multi-tenant clinic management platform".

### Deployment shape

| Piece | Runtime | Notes |
|---|---|---|
| Web app | Next.js 15 App Router (React 19), Railway | `src/app` |
| Worker | Long-running Node process, Railway | `worker/` — **never serverless** |
| Database | PostgreSQL (Railway-hosted or self-hosted); whatever fronts it must support `LISTEN/NOTIFY` | plain SQL migrations |
| Storage | Local disk in dev, S3-compatible in production | `src/lib/storage.ts` |

The worker holds **one live WhatsApp socket per clinic**, owns the scheduler, runs the AI
agent, and renders PDFs with headless Chromium — none of which fit a serverless function.

Stack notes: raw `pg` (no ORM, no query-cache library), `luxon` for time,
`zod` for validation, `bcryptjs` + SHA-256 session tokens for auth, `@whiskeysockets/baileys`
6.7.21 for WhatsApp, `playwright` Chromium for PDF, `pdf-lib` as a PDF compositor,
`pdfjs-dist` for PDF rendering in the browser, `mammoth` for .docx import,
`@anthropic-ai/sdk` for the AI agent, `web-push` for notifications, Tailwind 4.

---

## 2. Actors and access model

### Account types

| Actor | How they get in | Scope |
|---|---|---|
| **Agency super admin** | `users.is_super_admin = true` | Every clinic, via `/admin` |
| **Clinic member** | `clinic_members` row | One clinic workspace `/c/{slug}` |
| **Patient** | No account | Public booking, invoice view, signing links |

### Job title vs. access — two separate columns

`clinic_members.role` is the **job**, `clinic_members.permissions` is the **access set**,
and `clinic_members.is_owner` is a flag. (Migration `0014_access.sql` split these; before it,
one column carried both, which made "let this doctor see the inbox" unrepresentable.)

- `role`: `doctor` | `receptionist` | `other`
  - **Only a doctor is bookable** and can have per-member working hours. `other` is the
    escape hatch for a nurse, accountant or manager.
- `is_owner`: grants full access permanently; owners are who the worker notifies for
  anything needing "the person in charge".

### Capabilities (`src/lib/permissions.ts`)

```
conversations · calendar · patients · documents · documents.manage · documents.void
invoices · campaigns · automations · settings · settings.clinic · settings.staff
```

Two access levels:

- **`full`** — everything, *including capabilities that do not exist yet*. Deliberate: an
  owner who granted full access shouldn't revisit every member each release.
- **`custom`** — only what is ticked, stored as `{level:'custom', caps:{…}}`.

Rules enforced in the resolver, not just the UI:

- The clinic owner is **always** full, whatever is stored — a clinic cannot lock itself out.
- **Dependent capabilities** are cleared when their section is off (`documents.void`
  requires `documents`; `settings.clinic`/`settings.staff` require `settings`). A
  hand-edited row therefore *denies* rather than grants.
- A delegated staff manager (`settings.staff`) **cannot edit an owner or themselves**.
- Unknown keys ignored, missing keys false — a malformed row denies.

Role defaults when switching a member to custom:

| Job | Default capabilities |
|---|---|
| doctor | calendar, patients, documents |
| receptionist | conversations, calendar, patients, documents, documents.manage, invoices, settings |
| other | calendar, patients |

The sidebar nav **is** the capability set rendered — nothing reads a job title. The
dashboard tiles follow the same gates (a member without `invoices` doesn't read the week's
revenue off the front page).

### Tenant isolation

Enforced in **PostgreSQL Row Level Security** on every clinic-scoped table:

- The app connects as `clinicos_app` — `nosuperuser`, `nobypassrls`.
- Per transaction the app sets `app.user_id`, `app.clinic_id`, `app.role`, `app.is_admin`.
- Policy on every clinic table: `app_is_admin() or clinic_id = app_clinic_id()`, both
  `USING` and `WITH CHECK`.
- Special policies: `users` (self, admin, or colleagues in the active clinic), `sessions`
  and `notifications` and `push_subscriptions` (own rows only), `announcements` /
  `recipe_templates` / `knowledge_templates` / `document_template_library` (read by all,
  write by admin), `auth_tokens` (system context only), `worker_status` (read by all,
  write by admin).
- `npm run test:rls` asserts isolation across all clinic-scoped tables plus cross-tenant
  insert and update attempts.

### Impersonation (agency support mode)

- The admin presses **Open workspace** on a clinic; a **separate session** is issued
  carrying `sessions.impersonated_by`.
- The workspace shows a persistent banner: *"Support mode — you're viewing this clinic as
  the agency. Actions are logged."*
- Every action is attributable; exiting **destroys that session** rather than just navigating away.

### Subscription gating

`clinics.subscription_status`: `trial` | `active` | `past_due` | `suspended`.
A suspended clinic sends members to `/suspended` ("Your clinic's subscription is paused…
Your data is safe."), and the AI agent refuses to answer for suspended clinics.

---

## 3. Authentication & identity

- **Passwords**: bcrypt hashes. `password_hash` is nullable — an invited user exists before
  they have a password, and `verifyPassword` refuses a null hash, so an unaccepted invite
  is not a login bypass.
- **Sessions**: SHA-256-hashed tokens in `sessions`, delivered as httpOnly cookies, with
  `user_agent` and `ip` recorded.
- **Staff invitations**: owner adds a member → email with a link to set their own password.
  Staff never handle each other's credentials. Tokens live in `auth_tokens`
  (`purpose = 'invite'`), **expire after 7 days**, single use, hash-only storage.
  If email isn't configured the UI shows the raw invite link to send manually.
- **Password reset**: `/forgot` → emailed link, `auth_tokens` `purpose = 'reset'`,
  **expires in one hour**, single use. Expired-link page offers "Request a new link".
  Password minimum **8 characters**.
- **Email templates**: Arabic and English HTML for invitation and password reset
  (`src/emails/templates/`), rendered by `src/emails/render.ts`.
- **Kiosk PIN**: `users.kiosk_pin_hash`, 4–8 digits, optional. Unlocks the in-clinic signing
  view after a tablet has been handed to a patient; falls back to the password if unset.
- **Saved staff signature**: `users.signature_svg_path` / `signature_png_path` — drawn once,
  reused for every countersignature. Stored on `users`, not `clinic_members`, so someone
  working at two clinics uploads it once.
- **Staff photo**: `users.avatar_path`. JPG/PNG/WebP, **5 MB max**. Same reasoning — belongs
  to the person, not the job. (The per-membership `color` stays per-clinic; it tints their
  appointments on that clinic's calendar.)

---

## 4. Patients

### Record

`patients` holds: `full_name`, `phone_e164`, `secondary_phone_e164`, `extra_phones[]`,
`whatsapp_name`, `birth_date`, `gender` (`male`|`female`), `tags[]`, `notes_summary`,
`custom_fields` (jsonb), `merged_into`, `last_visit_at`.

- **Source**: `staff` | `booking_link` | `whatsapp` | `ai_agent` | `import`
- **Status**: `lead` | `active` | `archived`
- **Phone is identity**: a partial unique index on `(clinic_id, phone_e164)` for
  non-merged rows. Creating a patient with an existing number opens their file instead.

### Screens (tabs on the patient file)

Overview · Notes · Appointments · Files · Documents · Invoices · Conversation

- **Overview**: details, additional (custom) fields, summary notes, upcoming appointment,
  balance due, recent activity.
- **Notes** (`patient_notes`): author recorded, optionally tied to an appointment,
  **autosaved as you type**. A note is a clinical record, which shapes all of it:
  - **There is no delete.** No action, no button. A note is corrected, never removed.
  - **Every version is kept** (`patient_note_versions`). The autosave route and every
    action write through `saveNoteVersion`, so editing a note down to nothing loses
    no more than editing one word — the original stays readable from the note. An
    unchanged save files nothing, or focus-and-blur would fill the history with
    duplicates. The note records `edited_at` / `edited_by` and says "edited" on screen.
  - **Categories are the clinic's** (`note_categories`), seeded with Clinical and
    Administrative — renameable, recolourable, never deletable, since existing notes
    point at them. New ones are made from the patient file itself. They filter the
    list, and moving a note between them is recorded like any other change.
  - **A note can belong to a visit.** `appointment_id` has been on the table since
    0001 and nothing wrote to it. Both ends do now: the composer on the patient file
    offers the patient's own appointments, and the calendar's appointment panel reads
    and writes the notes for that visit through
    `/api/c/{slug}/appointments/{id}/notes`. The patient the note belongs to is taken
    from the appointment, never from the caller, and filing against another patient's
    visit is refused. Deleting an appointment unfiles its notes rather than destroying
    them (`on delete set null`). Filing is recorded in the audit log rather than as a
    new version — it changes where a note sits, not what it says.
  - **A note can be spoken.** `POST /api/c/{slug}/notes/voice` takes a browser
    recording (10 MB cap, audio types only), files it as a note with an optional typed
    body, and playback is served by `/notes/{id}/audio` — path read from the note,
    never from the caller, behind the `patients` capability like every other file.
- **Files** (`patient_files`): upload with kind `xray` | `lab` | `consent` | `photo` |
  `other`. **25 MB limit**. Served through authenticated API routes, never public URLs.
- **Merge records**: moves all notes, appointments, invoices and conversations from a
  duplicate into the surviving record and keeps both phone numbers. Refuses self-merge.
- **Archive / restore**.
- Quick actions: WhatsApp, Call, Book appointment, Create invoice.

### Search — Arabic normalisation (migration `0009`)

Literal comparison broke on the primary screen of an Arabic-first product. A
`ar_normalize(text)` SQL function collapses the interchangeable forms and strips diacritics:

- hamza forms `أ إ آ ٱ` → `ا` (أحمد / احمد)
- `ة` → `ه` (سارة / ساره)
- `ى` → `ي` (يحيى / يحيي)
- `ؤ` → `و`, `ئ` → `ي`
- strips tatweel `ـ` and all combining marks (fatha…sukun, dagger alif)
- lowercases

Backed by a **pg_trgm GIN index** on `ar_normalize(full_name)` so infix search stays indexed.
**Always compare names through `ar_normalize`, never raw `ilike`.**

### Filters

All tags · all sources · last-visit windows (no visit in 30 / 90 / 180 days).

### Custom patient fields

Superseded by `patient_field_definitions` (see §12) — one list drives the patient form,
the merge-variable picker and the document preview.

---

## 5. Bringing an existing clinic's records in

*"The blocker on switching systems is never the software, it is the five years of patients
already written down somewhere else."*

A clinic arrives with a spreadsheet exported from whatever they used before. `/c/{slug}/patients/import`
turns that into patients, and — critically — can turn it back.

### The flow

1. **Upload** a delimited file (CSV/TSV, any of `,` `;` `	` — the delimiter is detected
   from the header line, not assumed).
2. **Map columns.** Headers are guessed and pre-selected; every guess is overridable.
   Target fields: `full_name` · `phone` · `secondary_phone` · `birth_date` · `gender` ·
   `notes` · `tags` · `insurance_no` · `ignore`.
3. **Preview.** Every row is shown with the action it will take — `create`, `match`
   (an existing patient with that number) or `skip` — plus the reason. Nothing is written yet.
4. **Commit.** Counts are recorded on an `import_batches` row: `row_count`,
   `created_count`, `matched_count`, `skipped_count`, plus the mapping itself so a repeat
   import of the same export does not start from guesses again.
5. **Undo**, if it was wrong.

### Encoding

Excel on an Arabic Windows machine saves "CSV" in **windows-1256**, not UTF-8 — the single
most likely file to arrive and the one that turns every name into mojibake if read as UTF-8.
Detection is BOM first, then a strict UTF-8 attempt, then the fallback.

### Date and gender parsing

Dates accept `YYYY-MM-DD` and `D/M/YYYY` / `D.M.YY` forms; gender is read from Arabic and
English spellings. A value that cannot be read is left empty rather than guessed.

### Undo is bounded on purpose

Undo removes **only** patients that batch created **and** that nothing has happened to since —
no appointment, no invoice, no conversation, no document. Anyone who has since become part of
the clinic's real records is kept and reported back as `kept`. Removing them to tidy up a bad
import would destroy work. Patients carry `import_batch_id` and `source = 'import'`.

---

## 6. Calendar & appointments

### Appointment record

`appointments`: patient, `doctor_member_id`, `service_id`, `starts_at`/`ends_at`
(`ends_at > starts_at` enforced), notes, `created_by`.

- **Status**: `pending_approval` | `scheduled` | `confirmed` | `completed` | `no_show` | `cancelled`
- **Source**: `staff` | `booking_link` | `ai_agent`

### Views and controls

- Day / Week / Month views.
- Filter by doctor and by service; **colour by service or by doctor**.
- Create/edit panel with patient search-or-create (by name or phone), service, doctor
  (or "Any doctor"), start, duration.
- **Conflict detection**: "This time overlaps another appointment for this doctor."
- **Outside working hours** warning.

### Working hours

- `clinics.working_hours` — weekly jsonb, per-day arrays of `[from, to]` ranges
  (multiple ranges per day supported). Default Sun–Thu + Sat 09:00–17:00, Friday closed.
- `clinics.blocked_dates` — holidays / full closures.
- `clinic_members.working_hours` — optional per-doctor override; otherwise clinic hours apply.

### Booking race safety

`lockClinicSchedule(clinicId)` takes a per-clinic advisory lock **before** any availability
check that leads to an insert. Used by the public booking finalizer and the AI agent's
`book_appointment` tool. Without it, two simultaneous bookings can both pass the free/busy
scan.

---

## 7. Waitlist

*"A cancellation is a slot the clinic already sold. The waitlist is how it gets sold twice."*

`waitlist_entries`: patient, optional doctor, optional service, an optional date window
(`earliest_date` / `latest_date`, null on either side meaning no bound), a note, and a status.

- **Status**: `waiting` | `offered` | `booked` | `cancelled` | `expired`.
- **One live entry per patient per doctor** (unique index over `waiting`/`offered`). Adding
  somebody twice is a mistake, not a preference — it would double every offer they receive.

### When a slot frees

`offerFreedSlot()` in `worker/waitlist.ts` runs when an appointment is cancelled and matches
waiting entries against the freed slot's doctor, service and date window, oldest first.

| Rail | Default | Env |
|---|---|---|
| How many people are offered one slot | 5 | `WAITLIST_FANOUT` |
| Cooldown before the same person is offered again | 180 min | `WAITLIST_COOLDOWN_MIN` |

Fan-out is deliberate: the first person to reply takes it. The cooldown is what stops one
patient being pestered about every slot that opens in the same hour — `last_offered_at` and
`offers_sent` are tracked per entry.

### The rest of the lifecycle

- `requeueStaleOffers()` returns an `offered` entry to `waiting` once its cooldown lapses
  with no booking, so the slot keeps circulating.
- `expirePastWaitlist()` retires entries whose `latest_date` has passed.
- `closeWaitlistOnBooking()` sets `booked`, records `booked_appointment_id`, notifies staff
  (`kind: waitlist_booked`) and raises the `waitlist_booked` automation trigger — so reception
  can see the waitlist actually working rather than trusting that it is.

---

## 8. Services

`services`: name + `name_ar`, description, `duration_min` (>0), `price`, `color`,
`bookable_online`, `buffer_after_min`, `active`, `sort`.

- `service_doctors` maps which doctors perform which service. If a service has no mapping,
  every active doctor is a candidate.
- Services can require consent forms (`service_documents`, see §12).

---

## 9. Public online booking

Public page at `/book/{slug}` (production: `book.domain.com/{slug}` via rewrite).
Configured per **booking link** (`booking_links`), and a clinic can have several.

### Booking link settings

| Setting | Default |
|---|---|
| `min_notice_min` | 120 |
| `max_days_ahead` | 30 |
| `slot_granularity_min` | 30 |
| `approval_mode` | `instant` (or `approval`) |
| `doctor_member_id` | null = any doctor |
| `service_ids[]` | empty = all bookable services |
| `headline` / `headline_ar` | null — the clinic's own line above step 1 |
| `intro` / `intro_ar` | null — paragraph under the headline |
| `success_note` / `success_note_ar` | null — parking, what to bring, when to arrive |
| `show_prices` | `true` — off for clinics that quote per case |
| `allow_any_doctor` | `true` — off forces the patient to choose a doctor |
| `require_consent` + `consent_text` / `consent_text_ar` | `false` — a tick-box in the clinic's words |

### Wizard

1. Choose a service
2. Choose a doctor (or "First available doctor", unless `allow_any_doctor` is off)
3. Pick a time
4. **Your details, on one step** — name, WhatsApp number, the clinic's own
   questions (those that apply to the chosen service) and the consent tick-box.
   Questions used to be a step of their own; that added a tap and a progress
   segment to say nothing new, since "your name" and "what brings you in" are
   the same errand. The step gates on the details *and* the required answers.
5. **WhatsApp OTP**: a 6-digit code is sent to the number, verified against
   `booking_verifications` (attempt counting, expiry, auto-resend on expiry, and a
   patient-driven **resend** with a 45-second cooldown at `/resend`)
6. Confirmed — or "Request received" when the link is in approval mode. The
   confirmation screen offers an **`.ics` download** built in the browser and a
   call button for the clinic.

Availability is shown, not discovered: `GET /api/public/book/{slug}/days` returns a
slot count per day for the whole window in one request, so closed and full days are
greyed out, the wizard opens on the first day that has something, and an empty day
offers "next available". Times are grouped morning / afternoon / evening.

### Booking questions (`booking_questions`)

What a clinic asks beyond name and phone. Per clinic, optionally scoped to one
booking link and/or to specific services.

| Column | Meaning |
|---|---|
| `booking_link_id` | null = asked on every link |
| `field_type` | `text` · `longtext` · `number` · `date` · `select` · `multiselect` · `checkbox` · `phone` · `email` |
| `options` / `options_ar` | choice lists; the Arabic column is display-only, the stored value is always the `options` entry |
| `required` | blocks the booking until answered (a required `checkbox` must be ticked) |
| `service_ids[]` | empty = asked on every service |
| `patient_field_key` | a `patient_field_definitions` key — the answer also lands on the patient file |
| `active` | switch off to stop asking without losing past answers |

**Answers are frozen onto the appointment** (`appointments.intake_answers`, an array
of `{id, label, labelAr, type, value}`). A snapshot rather than a foreign key, so
rewording or deleting a question never changes what an old appointment shows. The
answers appear read-only in the appointment panel and inside the staff notification.

**A mapped answer only fills a blank.** `applyAnswersToPatient` writes through the
field definition — `source_column` for `birth_date` / `gender` /
`secondary_phone_e164`, otherwise `patients.custom_fields[storage_key]` — and every
write is a `coalesce`. Booking is not the authority on the patient record: a returning
patient's birth date, already checked against an ID card, is never overwritten by
whatever was typed on a phone in a waiting room. Name and phone are not writable
at all (phone is the identity rule).

**Validation is server-side, against the clinic's own rows.** The form is public, so a
required question the browser chose not to render is still required at `/start`, and a
`select` still only accepts an option the clinic wrote.

### Availability engine (`src/lib/slots.ts`)

`clinic hours ∩ doctor hours − blocked dates − existing appointments − service buffers`,
respecting min notice, max days ahead and slot granularity. Candidate doctor resolution is:
explicit request → link restriction → doctors assigned to the service → any active doctor →
a single unassigned column of clinic hours if the clinic has no doctors. Busy checks count
`pending_approval`, `scheduled` and `confirmed`.

### WhatsApp-offline fallback (deliberate)

If the clinic's WhatsApp is down, the booking page **skips phone verification, books anyway**,
and flags the appointment note as *"Booked while WhatsApp was offline — number not verified."*
Losing the patient is worse than an unverified number.

### On booking

- Patient created or matched by the phone identity rule (source `booking_link`).
- Confirmation message queued to WhatsApp in the patient's language, with service, doctor,
  date/time and clinic address.
- Staff notified (`booking` notification kind).
- Triggers emitted: `booking_submitted`, `appointment_created`, and `patient_created` for
  a new patient.

Branding: the booking page carries the **clinic's** logo and brand colour; the staff
workspace keeps the platform accent so agency support isn't relearning a skin per clinic.

---

## 10. WhatsApp inbox & messaging

### Connection

- Settings → WhatsApp → **Connect WhatsApp** → scan QR with the clinic's phone
  (WhatsApp → Linked devices).
- `whatsapp_sessions` per clinic: status `disconnected` | `connecting` | `qr` | `connected` |
  `logged_out`, plus phone number, display name, connect/last-seen times, error, `desired` flag.
- `whatsapp_auth_state` persists credentials per clinic, so restarts reconnect **without a
  new QR**. A crash in one clinic's session never affects another.

### Inbox

- Thread list with filters: **All · Unassigned · Mine · AI handled · Needs attention (flagged)**.
- Unread counts per conversation, roll up to the sidebar and dashboard.
- Per-thread: assign to me, close/reopen, open patient file, link a patient, **AI replies
  on/off** and AI-paused state.
- Message composer with **attachments** (photo, document) and **quick replies**
  (`quick_replies`, savable from any message).
- Every message is labelled by sender: `patient` | `staff` | `automation` | `ai` | `system` |
  `campaign` — so an AI reply is always auditable in the thread.
- Message types: `text` | `image` | `audio` | `document` | `video` | `sticker` | `location` |
  `unknown`. Inbound media is downloaded and served through an authenticated route.
- Message status: `queued` | `sending` | `sent` | `delivered` | `read` | `failed` | `cancelled`.

### Number-protection rails (`worker/outbound.ts`) — always on

1. **Randomized 3–10 second gap** between sends, per clinic.
2. **Daily cap** (`clinics.daily_outbound_cap`, default 300). Overflow is *deferred to
   tomorrow's window*, not dropped.
3. **Sending window** (`message_window_start`/`_end`, default 09:00–21:00 clinic-local).
   Automated messages outside it queue for the next window.
4. **Blast guard**: if identical `automation` text has gone to more than 8 distinct
   conversations in 10 minutes, the clinic's sending is **paused 30 minutes** and the
   message re-queued. Campaigns are exempt on purpose — one message to many numbers is the
   whole feature, and their pacing is upstream.
5. **Retries**: a failed send retries up to 3 attempts with a 90s × attempt backoff, then
   goes `failed`.
6. **Failure pause + owner alert**: at 5 consecutive errors the clinic's queue pauses 15
   minutes and every owner gets a `whatsapp_errors` notification.

Claiming uses `FOR UPDATE SKIP LOCKED`, so multiple worker instances never double-send.

---

## 11. Campaigns (bulk WhatsApp, drip-paced)

*"Send one WhatsApp message to a group of patients, paced so the number stays safe."*

- Audience built from patient filters (tags, source, last-visit windows); the **recipient
  list is frozen at creation** — a drip runs for hours and the audience must not shift underneath it.
- One message body, supporting the same merge tokens as automations
  (`{{patient.first_name}}`, `{{patient.name}}`, `{{clinic.name}}`, `{{clinic.phone}}`).
- **Pacing**: `interval_seconds`, constrained **30 – 86 400**, default **120**. The UI shows
  "Will message N patients", how many lack a phone and will be skipped, and an estimated
  total duration.
- **Status**: `draft` | `running` | `done` | `cancelled`.
- **Recipient status**: `pending` | `queued` | `sent` | `failed` | `cancelled`.
- One message per number per campaign, even if two patient files share it.
- Live progress (sent / failed / remaining / time left) over realtime.
- **Stop** withdraws anything queued but unsent; cannot be resumed.
- Delete is blocked while running; already-sent messages stay in the conversations.

### The pacing contract (`worker/campaigns.ts`)

A campaign **sends nothing itself** — once per interval it moves exactly one recipient into
the ordinary outbox, and the standard rails take over. Crucially, the pump *also* stops on
every condition that stops the sender: WhatsApp paused, outside the messaging window, daily
cap reached. Queueing a hundred recipients while paused would look like pacing and behave
like a blast the moment the pause lifted. If WhatsApp disconnects, the campaign **resumes
on its own** when it reconnects.

---

## 12. Document signing (ESIGN module)

The largest module. Consent forms and agreements, sent for signature, signed remotely or on
a clinic device, with a defensible audit trail.

### The freezing principle

Once a document is **sent** (or in-person signing begins), its rendered content, its hash,
and every merged value **stop tracking their sources**. Editing a template, renaming a
field or correcting a patient record afterwards must never change what somebody put their
name to. This is why `documents.content_snapshot` and `document_field_values` exist
alongside the live template and live patient row.

**The frozen snapshot, not the PDF, is the authoritative record.** Chromium shapes Arabic
correctly, and that is exactly why the glyphs it embeds are presentation forms in visual
order — the text layer of any browser-printed Arabic PDF is lossy and can't be reliably
extracted or searched. The SHA-256 covers `content_snapshot`; the PDF is the human-readable
artifact and carries title, id and fingerprint as PDF metadata so a large archive stays
searchable.

### Templates

`document_templates` — per clinic, fully owned and rewritable.

- Name + `name_ar`; **category**: `consent` | `treatment_plan` | `financial` | `privacy` | `other`.
- **Language**: `ar` | `en` | `both` — one template serves an Arabic and an English patient.
- **Source**: `template` (rich text with `{{merge.tokens}}`) or `upload` (an untouched PDF).
- **Signer config**: `{ mode: 'sequential'|'parallel', signers: [{ role_key, required, order }] }`.
- **`fields_schema`**: extra questions asked of the signer at signing time and printed on
  the certificate.
- **Versioning**: saving **publishes a new version** into `document_template_versions`
  rather than mutating one. Documents already sent read their own frozen snapshot, so the
  version exists for the record — a completed document can always be traced to the exact
  wording it came from.
- Rich text editor uses `execCommand`; everything it emits passes a **server-side allowlist
  sanitiser** before storage, so the browser's output is never trusted.

### Starter library

`document_template_library` — platform-level, Arabic + English ready-made forms (general
treatment consent and others), **copied into each new clinic at creation** and never
referenced again, so a clinic owns and can rewrite every word. The library is edited at
`/admin/defaults`, alongside the other content every new clinic is seeded with.

### Uploaded PDFs + field placement

- Upload your own PDF (**15 MB max**). It is **never re-typeset**.
- **Place boxes** by dragging on the page: `signature` | `initials` | `date` | `text` |
  `checkbox`, each assigned to a signer role, optionally required, labelled, or pre-filled.
- Coordinates are stored as **page-relative fractions (0–1)**, so a box placed on a phone
  lands in the same spot at A4 and survives any zoom or render scale.
- At finalisation, transparent per-page overlays are rendered by the same browser (so Arabic
  values shape correctly) and composited onto the untouched original with `pdf-lib`, then the
  certificate is appended. The worker exposes `POST /render-overlays` for this.

### Import from Word or PDF

- **.docx** (via `mammoth`): structured XML, so headings, lists and emphasis survive and the
  result is genuinely editable.
- **.pdf**: text only. A PDF stores positioned glyphs with no notion of a paragraph, and for
  Arabic the extraction can come back **reversed or with letters disconnected**.
- **15 MB max**, `.doc` rejected (must be saved as `.docx` first).
- Both are **previewed before acceptance** — nothing is written until you press "Use this
  text" — and warnings name exactly what was lost: `docx_partial`, `images_dropped`,
  `pdf_layout_lost`, `pdf_arabic`, `pdf_no_text`.

### Merge fields (`patient_field_definitions`)

One table is the single source of truth for what a patient record holds **and** what merge
variables a template can use. `key` is the merge token exactly as it appears between braces.

- **Scope `patient`** — mapped to a real column on `patients` (`source_column`) or stored in
  `patients.custom_fields` (`storage_key`).
- **Scope `context`** — resolved at merge time from the clinic, doctor, service, appointment
  or today's date (`source_path`).
- **Types**: `text` | `number` | `date` | `phone` | `email` | `select` | `checkbox` | `longtext`.
- Per field: required, hidden, show-in-profile, display order, options list.
- **System fields can be renamed, reordered and hidden, but never deleted** — the platform
  reads them by key (phone is the identity rule; birth date decides whether a guardian must sign).

Seeded set: `patient.full_name`, `patient.phone`, `patient.national_id`,
`patient.birth_date`, `patient.gender`, `patient.address`, `clinic.name`, `clinic.address`,
`clinic.phone`, `doctor.name`, `service.name`, `service.price`, `appointment.date`, `today`.

**Sending is blocked when a merge field is empty.** A blank on a signed form isn't something
to fix afterwards, so the UI names each empty field and links straight to where it's filled
in (patient file / clinic settings / service settings / the appointment) — or lets you set it
**for this document only** as an override or a one-off field.

A document raised from a patient's file **adopts their next appointment**, because otherwise
doctor, service and price merge empty and sending is blocked, which reads as a bug rather
than missing data. The resolved appointment is recorded on the document so merged values
keep a traceable source.

### Signers

`document_signers` — role key, signing order, required flag, display name, phone, or a
`user_id` for staff.

- **Built-in roles** (`signer_roles`, per clinic, extendable): `patient`, `guardian`,
  `doctor`, `clinic_owner`, `clinic_representative`, `witness`. Custom roles can be added;
  built-ins can't be deleted.
- `is_staff` roles sign **inside the workspace** with their saved signature in two taps;
  everyone else gets a link or the clinic device.
- **Signing order**: `sequential` (each signer asked only once the one before is done —
  nobody is told about their turn before it is their turn) or `parallel` (everyone asked
  immediately).
- **Guardian auto-rule**: a patient under 18 requires a guardian signer, with a
  "relationship to patient" field (mother, father, legal guardian…).
- Signer status: `pending` | `viewed` | `signed` | `declined`.
- Captured per signer: signature SVG + PNG, typed name, consent confirmation, IP address,
  user agent, OTP verification time, in-person flag, witness, and answers to the extra questions.

### Delivery and signing journeys

**Remote link** — `/sign/{token}`:

- Single-use, hash-only storage (`signing_tokens`, SHA-256; the token exists only in the
  WhatsApp message and the patient's address bar), with attempt counting and revocation.
- Expiry configurable per clinic: **`esign_link_days` default 7, range 1–90**.
- 3-step journey: **Read → Confirm → Sign**. Must scroll to the end to continue; must tick
  the binding-signature consent box; then draw a signature with a finger **or** type their
  name (with a live preview).
- **Optional WhatsApp OTP** (`esign_require_code`, **off by default** and deliberately
  unadvertised — the link is single-use and only ever lands in the patient's own WhatsApp
  thread, which is what establishes identity).
- **Resume**: `signing_sessions` stores the last step, scroll state, consent, a
  half-drawn signature and field answers, so a dropped connection picks up where it left off.
- **Offline-aware**: "Your signature is safe. It goes through the moment you're back online."
- **Decline** with an optional reason — the clinic is told straight away.
- Every dead end is a real page with a way forward: expired (with **"request a new link"**),
  already used, revoked, voided, not found, too many attempts.
- **Signing screens take their language from the document, not the visitor** — otherwise a
  first-time visitor with no language cookie gets Arabic buttons on an English consent form.

**In-clinic kiosk** — `/sign-device/{slug}/{docId}/{signerId}`:

- Staff press "Sign on this device" and hand over a tablet already showing the document.
  There is **no hand-over gate screen** — containment arms immediately; the instruction is a
  strip staff read over the patient's shoulder. Measured at **4 staff taps and 3 patient taps**.
- Nothing else on the device is reachable during signing.
- Exit requires the staff **PIN** (4–8 digits) or, if none is set, the password.
- **Document lock**: `documents.locked_by` / `locked_at` prevents a second staff member
  opening the same document while a tablet is in a patient's hands.

**In-workspace countersign** — staff read the document and apply their saved signature.

**Send all pending**: everything a patient still owes as **one** WhatsApp message with a
numbered list. Each document keeps its **own single-use link** — a combined session would
let one signature cover several agreements. Only the *message* is combined
(`suppressDelivery` exists precisely so a patient with two forms gets one message, not three).

### Document lifecycle

**Status**: `draft` | `sent` | `partially_signed` | `completed` | `declined` | `expired` | `voided`.

- **Reminders**: first at `esign_reminder_hours` (default **24**), a second at **3×** that.
  Silent if the patient has since signed.
- **Expiry sweep** (worker, every minute): expired documents flip status, revoke their
  tokens, log the event, notify staff, and emit the `document_expired` automation trigger.
- **Void**: requires a reason. The document stays in the record and stays downloadable,
  **marked void on every page**. Cannot be undone. Gated by the `documents.void` capability.
- **Replace / supersede**: a completed document is immutable; a replacement points back at
  it via `supersedes_document_id` and the original stays exactly as it is.
- **Revoke link** without voting the whole document.
- On completion the worker generates the final PDF and **sends the signed copy to the
  patient's own WhatsApp thread** automatically.

### Uploaded signed copies (paper path)

Clinics do print, sign and scan. `documents.final_pdf_source` is `generated` or `uploaded`,
and an uploaded copy is **never dressed up as a captured signature**:

- Staff attach the scan (**25 MB max, PDF only**), tick who signed on paper, add a note.
- The signers ticked are recorded as having signed on paper; the audit trail names who
  attached it; a banner at the top of the detail screen says plainly: *"It was uploaded by
  staff, not signed here — so there is no captured signature, IP address, verification code
  or content hash behind it. Keep the paper original."*
- Necessary because the completed badge, timestamps and download button look identical either way.

### Audit trail & integrity

`document_events` is **append-only, enforced by trigger**:

- `UPDATE` is refused always.
- `DELETE` is refused **unless the parent document is already gone** — which is only true
  inside a cascade (PostgreSQL removes the referenced row first). A targeted
  `delete from document_events` still fails. This lets a patient or clinic be deleted while
  keeping the guarantee that matters: *while a document exists, its history cannot be edited
  or trimmed.*
- Event types are a **check constraint**, so logging a new kind of event is a schema change
  by design: `created`, `sent`, `link_opened`, `otp_sent`, `otp_verified`, `viewed`,
  `field_completed`, `signed`, `declined`, `reminder_sent`, `completed`, `downloaded`,
  `voided`, `expired`, `revoked`, `resent`, `hash_mismatch`, `locked`, `unlocked`,
  `superseded`, `final_uploaded`, `imported`.
- Each event records actor (`staff` | `signer` | `system` | `patient`), IP, user agent, metadata.

**Integrity check**: the content is hashed at freeze time. If the content no longer matches
its fingerprint, **signing is blocked** and the clinic owner is notified
(`document_integrity` / `hash_mismatch`).

### Service-required consent forms

`service_documents` attaches templates to a service with an `auto_send` flag. When an
appointment for that service is **confirmed**, the required forms are raised and sent
automatically — a direct hook rather than an automation recipe, because *which* form is
needed depends on the booked service and one recipe could only ever name one template.
Never raised twice for the same appointment. If a send is blocked (e.g. missing patient
details), staff are notified rather than it failing silently.

---

## 13. Automations

*"Messages that go out on their own, so nobody has to remember."*

### Triggers

| Trigger | Fires on |
|---|---|
| `appointment_created` | Appointment is booked |
| `appointment_status_changed` | Status changes (optionally filtered to one status) |
| `before_appointment` | X hours before (config `hours`, default 24) |
| `after_last_visit` | X days after last visit (config `days`, default 180) |
| `patient_created` | New patient added |
| `tag_added` / `tag_removed` | Tag change (optionally filtered to one tag) |
| `birthday` | Patient's birthday |
| `invoice_sent` | Invoice is sent |
| `invoice_unpaid` | Invoice stays unpaid X days (config `days`, default 3) |
| `inbound_message` | Message contains a keyword |
| `booking_submitted` | Someone books online |
| `document_sent` / `document_viewed` / `document_signed` / `document_completed` / `document_declined` / `document_expired` | Document lifecycle |
| `document_unsigned` | Document stays unsigned X days (config `days`, default 3) |
| `waitlist_booked` | A waitlist offer turned into a booking |

### Steps

`send_whatsapp` · `wait` · `condition` (if/else with yes/no branches) · `add_tag` ·
`remove_tag` · `create_task` · `notify_staff` · `goto_automation` · `send_document` · `stop`

- **Wait** supports both "wait N minutes" and "…then wait until HH:MM" (clinic-local, rolls
  to the next day if already past).
- **Conditions**: `has_tag` · `appointment_status` · `replied` (did the patient reply since
  the run started) · `invoice_paid`.
- **notify_staff** targets roles, defaulting to owner + receptionist.
- **send_document** creates and sends a template; the document's creator is recorded as the
  clinic owner, because a document must always name a real person and an automation isn't one.
- Steps form a tree (`parent_step_id` + `branch`), walked with sibling-then-parent-sibling
  ordering, with a 100-step guard per advance.

### Merge variables

`{{patient.first_name}}`, `{{patient.name}}`, `{{appointment.time}}`, `{{clinic.name}}`,
`{{clinic.phone}}`, `{{doctor.name}}`, `{{invoice.link}}` and the patient field definitions.

### Runs, idempotency and history

- `automation_runs` status: `running` | `waiting` | `completed` | `failed` | `cancelled`.
- **One active run per `(automation, patient, appointment, invoice, document)`**, enforced
  by a partial unique index with `NULLS NOT DISTINCT` — NULLs must not defeat the guarantee.
- Idempotency is scoped to the *context*, not the run: a replayed trigger creates a new run,
  so run-scoped deduplication would have let the same reminder go out twice.
- **A send is additionally deduplicated by body**: the same automation never sends the same
  text twice for the same patient/appointment/invoice, across both retries and replays.
- `automation_run_logs` records every step with `ok` | `skipped` | `failed` | `waiting` and
  a detail payload — the History tab shows exactly what happened and why a step was skipped.
- Automated sends land inside the clinic's **sending window**; overnight traffic queues.
- Deactivating an automation cancels its in-flight runs.
- **Test run**: runs the flow against a patient you pick, sending real messages.

### Shipped recipes ("starting points")

Copied into every new clinic, editable, each a normal automation afterwards:

| Key | What it does | Default |
|---|---|---|
| `confirm_on_booking` | Confirmation as soon as an appointment is created | off |
| `reminder_24h` | Reminds a day ahead, asks them to confirm | off |
| `reminder_2h` | Short nudge on the day | off |
| `no_show_followup` | Reaches out when a patient misses their appointment | off |
| `post_visit_review` | Thanks the patient, asks for a Google review | off |
| `birthday` | Warm birthday message | off |
| `recall_6_months` | Invites them back for a routine check | off |
| `unpaid_invoice` | Follows up on an unpaid invoice | off |
| `document_expired_alert` | Task when a signing link expires unsigned | **on** |
| `document_unsigned_escalate` | After 5 days, hands it to reception to chase by phone | **on** |
| `document_declined_alert` | Notifies staff and opens a task on a decline | **on** |
| `welcome_new_patient` | Greets a new patient, which is also what opens the WhatsApp window so staff can message them first | **on** |

`RECIPES_ON_BY_DEFAULT` (`src/lib/esign/constants.ts`) is the single answer to "which of
these start switched on", read by both the seed script and clinic creation — so a clinic
created today and a clinic created by the seeder get the same defaults.

The two **patient-facing document reminders (24h / 72h) are built in, not recipes** — they
run off the clinic's own "first reminder after" setting so they're hour-accurate and can't be
switched off by accident, and duplicating them as automations would nudge every patient twice.
What ships as recipes is what a flow can do that a fixed reminder cannot: escalate, chase an
expiry, open a task on a decline.

### Specialty packs

A clinic is asked what it practises when it is created (`clinics.specialty`, admin →
**New clinic**, changeable later from the clinic's admin page). It gets the `general`
library **plus** the pack for its own field — the specialty adds, it never replaces.

`general` · `dental` · `dermatology` · `ophthalmology` · `obgyn` · `pediatrics` ·
`orthopedics` · `physiotherapy` · `ent` · `cardiology` · `nutrition` · `psychiatry` ·
`plastic_surgery` · `urology` · `internal_medicine` (`src/lib/specialties.ts`)

37 recipes across the 14 packs (`scripts/specialty-recipes.ts`) — post-extraction aftercare,
laser prep, telling an eye patient they will not be able to drive home, a 40-day postpartum
check, a discreet psychiatry reminder that names no clinic, cast-removal follow-up. They
arrive **off**, like the rest of the library: the specialty decides what is on the shelf,
never what is running. Tag-triggered ones name the tag in Arabic, because that is what
reception types.

Installing is additive and re-runnable — a recipe the clinic already holds a copy of is
skipped, so correcting a wrongly chosen specialty never touches flows they have edited. The
clinic's copies remember their pack in `automations.recipe_specialty`, which is what groups
them under their own heading on the automations page.

### System messages (`clinic_system_messages`)

The eleven messages the platform sends **outside** the automation engine, listed and editable
on the automations page (**System messages** tab). They used to be strings in seven source
files that a clinic could read nowhere and change nowhere.

| Group | Keys | Off-switch |
|---|---|---|
| Booking | `booking_confirmed` · `booking_pending` | yes |
| Booking | `booking_otp` | **no** |
| Waitlist | `waitlist_offer` | yes |
| Documents | `document_reminder` · `document_signed_copy` | yes |
| Documents | `document_sign_request` · `document_bundle` · `signing_otp` | **no** |
| Invoices | `invoice_sent` · `invoice_receipt` | **no** |

- Same `{{variable}}` syntax as the builder. `src/lib/system-messages.ts` holds the
  registry, the defaults in **both** languages, and the variables offered as chips.
- **Language is per send**, not per clinic: the patient's booking locale, the document's
  language. Both bodies are stored.
- **The four that cannot be silenced** are the ones whose flow stops working without them —
  a patient who never gets their code cannot finish booking, an unsent link is a document
  nobody can sign. Editable, never disableable, and the server enforces it too.
- **Overrides are sparse.** A clinic that has not changed a message has no row, so improving
  a default reaches everyone who never wrote their own. Saving wording identical to the
  default stores nothing; saving nothing at all deletes the row.
- A line that held only variables and rendered empty is **dropped** — an unassigned doctor or
  a clinic with no address leaves no blank line mid-message. Deliberate blank lines survive.
- Switching one off skips the whole surrounding step, never queues a blank message: a
  disabled `waitlist_offer` means nothing is offered *and* nobody's place or cooldown is
  spent.

### Tasks

`tasks` — title, body, patient, assignee, due date, done flag, `created_by` (`staff` or
`automation`). Created by the `create_task` step or by hand.

---

## 14. AI receptionist

A per-clinic WhatsApp receptionist powered by the Anthropic Messages API
(`worker/ai/agent.ts`). Default model **`claude-opus-5`**, per-clinic configurable.

### Setup

| Setting | Values / default |
|---|---|
| Enabled | off by default |
| Agent name | how it introduces itself |
| Instructions | tone and personality |
| Greeting | opening line |
| Language mode | `match` (the patient) · `ar` · `en` |
| Hours mode | **`after_hours` (default)** · `always` (24/7) · `custom` |
| Escalation notes | anything beyond the built-in rules |
| `max_daily_messages` | 200 |
| Model | per clinic |

**After-hours-only is the safest first switch-on**: staff cover the day, the agent covers
nights and weekends, and it's one dropdown to change.

### Knowledge base

`ai_knowledge_items`, categorised: `services_prices` · `doctors` · `hours` · `location` ·
`insurance` · `preparation` · `faq` · `other`. Each item has a title, content, active flag
and sort order. New clinics get seeded entries from `knowledge_templates`.

**The agent answers only from these entries plus the clinic's services, doctors, hours and
live calendar.** No general knowledge, no invented prices. Anything it wasn't taught becomes
a handoff.

### Tools

| Tool | Behaviour |
|---|---|
| `check_availability(service_name, date)` | Real open times from the calendar. Returns **at most 6** slots; the agent is told to offer at most 3. Validates the date is not past and within `max_days_ahead`. Lists the clinic's services when the name doesn't match. |
| `book_appointment(service_name, start_iso, patient_name)` | Takes the **schedule lock**, re-verifies the slot is still free ("That time was just taken…"), creates or updates the patient by the phone identity rule, inserts the appointment with `source = 'ai_agent'`, emits `appointment_created`, increments usage, and notifies owners + receptionists. |
| `escalate_to_human(reason, urgent)` | Flags the conversation, disables AI on that thread, notifies staff, increments escalations. Prefixes 🚨 عاجل for emergencies. |

Runs at **`effort: "low"`** — a receptionist turn is short and scoped, and WhatsApp replies
are latency-sensitive. Max 6 tool iterations, 20 messages of history, 2048 max tokens.
Non-text media the agent can't read is *described* in the transcript, not dropped.

### Gates before it answers

`no_agent` · `disabled` · clinic `suspended` · thread AI off · **paused after a human reply**
· clinic open while in after-hours mode · outside custom hours · daily cap reached.
Inbound messages wake the agent with a **4-second delay**.

### Guardrails (stated in-product)

Never gives medical advice, never invents prices, hands off on emergencies, complaints or
anything it wasn't taught. **Every message it sends is labelled `ai` in the inbox.**
A model refusal or an API failure escalates to staff rather than going silent. With no
`ANTHROPIC_API_KEY` the agent stays off and every message is escalated instead of answered.

### Usage & testing

- `ai_usage` per clinic per day: replies sent, appointments booked, escalations, input and
  output tokens. Shown as a 30-day activity view, and rolled up per clinic in agency monitoring.
- **"Try it" panel** in the workspace: send a message as if you were a patient; nothing goes
  to WhatsApp.
- `worker_status` (single row) records whether the worker can actually reach Anthropic, so
  the settings screen reports the **worker's** capability rather than the web app's own
  environment — the two live in different services and previously disagreed in production.

---

## 15. Invoices & payments

### Invoice

`invoices`: per-clinic sequence (`seq` + formatted `number` using `invoice_prefix`, default
`INV`), patient, optional appointment, currency, subtotal, discount, tax rate + amount,
total, amount paid, notes, `public_token`, `pdf_path`.

- **Status**: `draft` | `sent` | `partially_paid` | `paid` | `void`.
- Optional **insurer split** — see the Insurance & claims section. `total` is always the full
  price; the patient's share is `total - insurer_amount`.
- Line items (`invoice_items`) added from a service or as a custom item, with qty, unit
  price, amount, sort.
- `issue_date` is the invoice's own calendar date in the clinic's timezone. `created_at` used
  to double as it, which for an invoice raised at 01:30 in Amman was the day before.
- Clinic-level invoice settings: prefix, counter, `invoice_tax_rate`, `invoice_tax_label`,
  `invoice_footer`, `payment_instructions`. The tax rate is a **default for a new line**, not
  the invoice's rate.

### Tax and discount, per line

Both live on `invoice_items`, not on the invoice: `discount_amount`, `tax_rate`, `tax_amount`
and a **UBL 2.1 tax category** — `S` standard · `Z` zero-rated · `E` exempt · `O` outside the
scope of tax. `O` is not the same statement as `Z`, and a clinic that is not registered for
sales tax needs to be able to say which it means.

The old model applied one rate to `subtotal − discount`. That is wrong for the ordinary
case: a visit with an exempt consultation and a taxable cosmetic procedure is one visit and
should be one invoice, and the only ways to bill it were to get the tax wrong or to hand the
patient two pieces of paper.

- `computeInvoice` ([src/lib/invoices.ts](src/lib/invoices.ts)) folds per line —
  `net = qty × price − discount`, then `tax = net × rate` — and **every header figure is the
  sum of the stored line figures**, never a second calculation over the whole. That is what
  makes an invoice foot once two rates or a rounded discount are involved, and it is what a
  tax authority recomputes.
- Only an `S` line carries a rate; a stray rate on an exempt line is dropped rather than
  charged. A discount is clamped to its own line.
- The editor's live preview calls the same function the server bills with.
- Migration `0034` spread each existing header discount and rate across its lines in
  proportion, handing the rounding remainder to the last line. Headers were deliberately
  **not** recomputed — payments had been taken against those totals, and moving one by a cent
  would flip a settled invoice back to partly paid.
- Money is still `numeric(12,2)`. JOD divides into 1000 fils and ISTD compares at finer
  precision; that is a recorded limitation, mitigated by deriving every reported total from
  the same rounded line values.

### Actions

- **Send on WhatsApp** (blocked with a clear message when the patient has no number or
  WhatsApp is disconnected).
- **Record payment**: amount, method `cash` | `cliq` | `card` | `transfer`, reference,
  paid-at, recorded-by. Overpayment is rejected. Status recalculates to partially paid / paid.
- **Void**: stays in records, no longer counts toward balances.
- **PDF download** and **patient view**.
- **Receipt**: there is no separate receipt entity. A paid invoice re-sent on WhatsApp goes
  out worded as a payment receipt, and `/inv/{token}` stamps **PAID / مدفوعة** — the same
  document, in the state it is now in. Re-sending a paid invoice must not start a chase for
  money already collected, so the unpaid-invoice automation ignores it.
- **Export CSV** of payments.

### Public invoice page

`/inv/{token}` — an unguessable per-invoice token (16 random bytes hex). Carries the
clinic's logo and brand colour, itemised lines, totals, payment instructions and the footer,
plus the Clinicti credit (see the Brand & attribution section).

### PDF generation

The invoice **is** a real page, rendered to PDF by **Playwright Chromium in the worker**
(`POST /render-pdf`). This was the only approach that gave correct Arabic shaping and RTL
table layout without hand-managing font subsets, and headless Chromium doesn't fit in a
serverless function.

### Money views

Invoices list filters (All / Unpaid / Partly paid / Paid) plus Today, This week, This month
and Outstanding totals.

### JoFotara — Jordan's national e-invoicing (`einvoicing` module)

Mandatory for taxpayers inside the net since 1 April 2025. Off unless the agency licenses it
**and** the clinic fills in its registration — the only opt-in module, because a missing
feature key meaning "enabled" is right for something a clinic already pays for and wrong for
something that files their sales with a tax authority (`OPT_IN_FEATURES`,
[src/lib/features.ts](src/lib/features.ts)).

**Registration** (`clinic_einvoice_settings`, one row per clinic, RLS-isolated, read by the
worker under `withSystem`, never returned to the browser): taxpayer type `income` |
`general`, registered name, tax number, income source sequence, Client ID, Secret Key, and a
live/test device switch. A separate table rather than columns on `clinics` because several
server components select `cl.*` and pass the row to a client component. The settings screen
receives `hasSecret`, never the key; saving a blank key means *unchanged*.

**Taxpayer types.** `income` charges no sales tax and has no activity number — most small
Jordanian clinics, the services registration threshold being JOD 30,000. `general` is
per-line 16%/15%. Special sales tax is deliberately not offered: it covers goods no clinic
sells, and a menu entry nobody should pick is one somebody eventually picks.

**The document** ([src/lib/einvoice/ubl.ts](src/lib/einvoice/ubl.ts)) is UBL 2.1 XML, base64
in a JSON body, `POST /core/invoices/` with `Client-Id` and `Secret-Key` headers. `388`
invoice / `381` credit note; sub-type digits encode taxpayer type and cash (`012`/`011`) vs
receivable (`022`/`021`). **Buyer details are not required for a cash invoice**, so reception
never has to ask a patient for a tax number. Generated here because no Node library exists.

> ⚠️ The element set follows the profile published integrators describe. The authoritative
> spec ships with the device credentials inside the taxpayer's own JoFotara portal account.
> Reconcile against it, and against a test device, before a clinic files anything real.

**When it files.** Three triggers, one function, one dedupe key — whichever fires first wins:

1. the first payment is recorded (the primary trigger, and where cash/receivable is decided);
2. the invoice is delivered (WhatsApp send or PDF download);
3. a daily 04:00 sweep for anything non-draft still unfiled after 24 hours, which also
   rescues submissions stranded by a worker restart.

Never in the path of taking money — always a queued job. Sending and downloading **wait for
the stamp**, because an invoice PDF without its QR is the document that is not compliant; a
successful submission clears `pdf_path` so the next render includes the QR.

**Failure.** A 4xx is not retried — it is the invoice, not the weather, and would be rejected
identically four more times. Timeouts, 5xx and 429 get the job runner's backoff; when the
attempts run out the invoice goes `failed`, keeps ISTD's own words, and staff are notified
once (`dedupeKey`). A **Try filing again** button on the invoice clears the dedupe key and
requeues.

**Corrections.** ISTD has no delete. Voiding a *filed* invoice raises a **credit note** —
`381`, `credit_note_of` pointing at the original, lines mirrored, own number, submitted the
same way — and both invoices show the link. Voiding an unfiled one behaves as before. It does
not touch the payment ledger: `payments.amount > 0` forbids a negative row, so refunds remain
a gap this product has.

**On the invoice**: the QR (rendered from `einvoice_qr` at request time), the seller's tax
number, the UUID, and the credit-note reference. **Trail**: `invoice_einvoice_events` records
every queue, acceptance and rejection per invoice — mirroring `document_events` rather than
`audit_log`, which has no clinic-facing viewer.

**Testing**: [scripts/mock-jofotara.ts](scripts/mock-jofotara.ts) stands in via
`JOFOTARA_BASE_URL` and validates the document rather than rubber-stamping it — the real
endpoint is never in a test's reach, because filing an invoice is recorded and irreversible.

---

## 16. Insurance & claims

*"Reception's question at the desk is 'how much does this person pay right now'."*

### Insurers

`insurers` per clinic: `name`, `code` (what reception types into the insurer's own portal —
almost never the same string as the name), `notes`, `active`. Unique on `(clinic_id, name)`.

### On the patient

`insurer_id`, `insurance_no`, `insurance_valid_until` — so the desk can see cover has lapsed
before the visit rather than after the claim.

### On the invoice

`insurer_id` and `insurer_amount` — what the company is expected to cover. `total` stays the
**full** price, so the patient's share is `total - insurer_amount` and never needs storing twice.

- **Claim status**: `none` | `to_submit` | `submitted` | `approved` | `rejected` | `paid`.
  `none` is the common case — most visits are cash.
- `claim_ref`, `claim_submitted_at`, `claim_note` carry the rest.
- The claims worklist is "everything not settled", read straight off a partial index on
  `claim_status <> 'none'`.

---

## 17. Dashboard

**Nav order** (sidebar, and the first four become the phone's bottom bar):
Dashboard · Patients · Calendar · Invoices · Documents · Waitlist · Conversations ·
Campaigns · Automations · AI agent · Settings. The order is the clinic's working day, not
the order the features were built — it decides what a receptionist reaches with one thumb.
Each item is filtered by the member's capabilities.


The one screen everybody can open. Tiles respect the same capabilities as the nav:

- Today's appointments (count + the day's list with time, patient, service, doctor, status)
- Unread conversations (requires `conversations`)
- Revenue this week vs last week, with direction (requires `invoices`)
- No-show rate this month
- Pending items: unpaid invoices, unconfirmed appointments
- Header badges: **WhatsApp connected/disconnected** and **AI on/off**

All counters are one SQL statement, not a query each. (Related perf note: `Promise.all` over
a single `pg` client is a no-op — node-pg serializes per connection. Merge the SQL or open
separate transactions.)

---

## 18. Notifications & PWA

### Sending each notification once

Every insert goes through `src/lib/notify.ts`, which writes with
`on conflict (dedupe_key) where dedupe_key is not null do nothing` against a **partial**
unique index — the predicate has to be repeated in the `ON CONFLICT` clause or Postgres
cannot match the index.

The key is scoped per recipient (`${dedupeKey}:${userId}`). Callers that should fire once
per event pass one (e.g. `waitlist_booked:${appointmentId}`); callers that legitimately
repeat pass none. This replaced a set of per-caller guards that were mis-firing because the
scheduler's 60s tick was narrower than a 90s look-back window.

**Kinds in use**: `booking` · `clinical` · `doctor_reminder` · `document` ·
`document_awaiting_signature` · `document_digest` · `document_expired` ·
`document_integrity` · `document_new_link` · `waitlist_booked` · `whatsapp_disconnected` ·
`whatsapp_errors`.


### In-app notifications

`notifications` per user, with kind, title, body, url, read state. Notification centre with
**Mark all read**. Kinds:

```
booking · ai_escalation · ai_booking · whatsapp_disconnected · whatsapp_errors
automation · doctor_reminder · daily_summary · day_end · unread_digest · cancellation
document_awaiting_signature · document_signed · document_declined · document_completed
document_expired · document_digest · document_integrity · document_new_link
```

### Web push

- VAPID web push (`web-push`), subscriptions in `push_subscriptions`, mirrored **once** per
  notification (`push_sent` flag). Revoked subscriptions are pruned.
- **Critical alerts fall back to WhatsApp** on the staff member's own number when no push
  subscription is live: `whatsapp_disconnected`, `whatsapp_errors`, `ai_escalation` — exactly
  the failures that make the app itself untrustworthy.
- Per-user preferences: before my appointments, my morning schedule, new bookings,
  cancellations, unread message digest, end-of-day summary; plus per-member
  `reminder_minutes` (default 30).

### Doctor and team alerts (`clinic_staff_alerts`)

Rows the clinic edits on its own automations page (**Team alerts** tab), not hardcoded
rules. Every clinic is given these four — by a trigger on `clinics`, so a clinic created
down any path has them, because a clinic missing them does not look broken, its doctors
simply stop being reminded.

| Kind | Default | To whom |
|---|---|---|
| `appointment_reminder` | each recipient's own `reminder_minutes` | the appointment's doctor |
| `day_schedule` | 08:00 | each doctor |
| `unread_digest` | 12:00, only if ≥ 3 unread | owners + receptionists |
| `day_end` | 20:00 — completed, no-shows, revenue | owners |

- `minutes_before = null` means **"whatever each person set for themselves"** — the
  per-member `reminder_minutes` the notifications page writes. A number overrides it
  clinic-wide, which is how a clinic adds a second, earlier nudge without touching anybody's
  preferences.
- A clinic can add rows, change the hour, change the audience, or delete what nobody reads.
  Two rows of the same kind at different hours are two different digests.
- `day_schedule` sends a **doctor** their own list and anyone else the clinic's whole day —
  "how busy are we today" and "what have I got" are the same question about different rows.
- Notification `kind` values are unchanged (`doctor_reminder`, `daily_summary`, `day_end`,
  `unread_digest`) because every user's saved preferences are keyed by them.
- Claims are per alert per clinic-local day (`digest:{kind}:{alertId}:{date}`), so the
  three-minute firing window still cannot send twice. Migration 0033 pre-claimed the day it
  shipped, so nobody was told twice on the changeover.

Not a row, and still fixed: **Sunday 09:00** — documents still waiting for signature (+ how
many expire within 2 days), to owners. Sunday is the start of the working week in Jordan; a
digest landing on a Saturday evening is one nobody reads. Dedupe key is the ISO week.

### PWA

- Installable to the home screen, with an in-app **Install app** button and explicit iOS
  Safari instructions ("tap Share → Add to Home Screen").
- Service worker, offline page with a retry button, safe-area insets for notched phones.
- **Mobile bottom nav**: the first 4 permitted sections, plus a **More** sheet holding the
  rest, notifications and install.
- Desktop: left sidebar with unread badges, impersonation banner, language toggle.

---

## 19. Realtime

PostgreSQL `LISTEN/NOTIFY` triggers (`emit_change`) fan out to browsers over **one SSE
endpoint per clinic** (`/api/c/{slug}/events`, `src/lib/realtime-server.ts` +
`src/lib/use-realtime.ts`).

Tables that emit: `conversations`, `messages`, `appointments`, `patients`, `invoices`,
`tasks`, `automation_runs`, `whatsapp_sessions`, `notifications`, `documents`,
`document_signers`, `campaigns`, `campaign_recipients`.

Dropped connections resubscribe silently and refetch. **Requires the session pooler, not the
transaction pooler.**

Related UI principle: **controls answer the click, not the server** — interactive state is
held locally, because perceived slowness here is almost always missing acknowledgement rather
than a slow query.

---

## 20. Agency admin panel (`/admin`)

| Screen | What it does |
|---|---|
| **Clinics** | Every tenant with health, last activity, subscription status |
| **New clinic** | Name (+Arabic), slug, owner name/email/password, plan, monthly price. Seeds field definitions, signer roles, recipes, knowledge and the document library copy |
| **Clinic detail** | Subscription modal (status / plan / price) and **Open workspace** (impersonation) |
| **Monitoring** | Worker up/down + uptime; jobs pending / failed / running / stale; outbox queued & failed; storage MB; per-clinic WhatsApp status, sent-today vs cap, AI replies, AI tokens, failed runs/messages/WA errors, last activity; the 10 most recent failed jobs with their errors; total AI token spend across all clinics (30 days) |
| **Announcements** | Platform-wide messages to all clinics, dismissible per user |
| **Defaults** | Everything a new clinic is seeded with: the starter document template library, the automation recipes and the AI knowledge templates. Gated per section — `documents` opens the library, `defaults` the rest |

---

## 21. Settings inventory (per clinic)

| Page | Contents |
|---|---|
| **Clinic profile** | Name + Arabic name, slug, logo, brand colour, address (+Arabic), phone, Google Maps URL, timezone, default locale |
| **Staff & access** | Add/invite members, photo, job, title, specialty, calendar colour, reminder minutes, **full vs limited access with per-capability tick boxes**, custom working hours, deactivate/reactivate, resend invitation |
| **Services** | Name (+Arabic), duration, price, colour, buffer after, bookable online, doctors who perform it |
| **Working hours** | Weekly ranges per day, multiple ranges, blocked dates |
| **Booking links** | Name, URL slug, min notice, max days ahead, slot granularity, approval mode, doctor restriction, service restriction, copy link, open page; the page's own headline / intro / after-booking note in both languages, show-prices, allow-any-doctor, required agreement text |
| **Booking questions** | What else the page asks: label (+Arabic), help text, answer type, choices, required, which link, which services, whether the answer also fills a patient field, reorder, switch off without losing past answers |
| **WhatsApp** | Connect/disconnect, QR, number, last activity, **daily message cap**, sent today, number-protection explainer |
| **Invoice settings** | Prefix, tax rate + label, footer, payment instructions, currency |
| **Patient fields** | The merge-variable list: label (+Arabic), key, type, options, required, hidden, show-in-profile, reorder; built-ins renameable but not deletable; "used in N templates" |
| **Document templates** | Create, copy from library, versions, signer setup, extra questions, attached services + auto-send, preview in either language. PDF upload and Word/PDF import were withdrawn — see decision 44 |
| **Signer roles** | Built-in six plus custom roles (key, label +Arabic, signs-in-workspace flag) |
| **Signing** | Link expiry days, require WhatsApp code, first reminder hours |
| **My signature** | Draw once, reuse; device PIN (4–8 digits) |
| **Notifications** | Per-kind preferences and reminder lead time |
| **Language** | Arabic / English toggle |

---

## 22. Files, storage & backups

### Storage (`src/lib/storage.ts`)

One API, two drivers, chosen by whether `S3_BUCKET` is set:

- **Local disk** in development: `./storage/{clinicId}/…`, with traversal guarding.
- **S3-compatible** in production (Cloudflare R2) — path-style addressing.

**Serverless filesystems are ephemeral, so production must set S3 or uploads vanish between
requests.** Everything is served through authenticated API routes; nothing is a public URL.
Deployment-level files (backups) go under `_system/` rather than being filed under a clinic.

Holds: patient files, clinic logos, staff photos, WhatsApp media, invoice PDFs, template
source PDFs, signature SVG/PNG, final signed PDFs.

### Backups (`src/lib/backup.ts`)

- Logical backup of the whole database, **daily at 03:00 UTC**, written to object storage.
- Retention `BACKUP_KEEP`, default **14**.
- **Skipped entirely unless object storage is configured** — a backup written to the failing
  container's own disk would vanish with it.
- Deliberately *not* wrapped in a job row: if the job system is what broke, the backup is
  exactly the thing that still needs to happen.
- `restoreDatabase()`, `listBackups()`, `readBackup()` exist for recovery.

---

## 23. Jobs, scheduler and the worker

### Job runner (`worker/jobs.ts`)

- `jobs` table claimed with **`FOR UPDATE SKIP LOCKED`**, so multiple worker instances never
  double-process. `dedupe_key` (unique) gives idempotency.
- Retries with backoff (`least(attempts,6) × 30s`), `max_attempts` default 5, then `failed`
  with the error recorded.
- **Two lanes**, because a job that waits on somebody else's server used to hold up every
  job behind it. The fast lane ticks every second and drains up to 20; the slow lane takes
  one at a time. Kinds are sorted by prefix, so a new sibling job joins the right lane by
  being named like one:
  - **slow** — `ai:*` (Anthropic), `einvoice:*` (ISTD), `document:*` (Chromium). Seconds each.
  - **fast** — everything else: `trigger:*`, `automation:advance`. Tens of milliseconds.
- `WORKER_SLOW_LANES` (default 1) is how many slow jobs may be in flight. One clears roughly
  14,000/day; raising it multiplies load on third parties and on the single Chromium, so it
  is a number to raise after measuring.
- Kinds: `trigger:*` (domain triggers), `automation:advance`, `ai:respond`,
  `einvoice:submit`, `document:finalize`, `document:advance`, `document:remind`,
  `document:digest`.

### Scheduler (`worker/scheduler.ts`) — every 60 seconds

| Task | Timing |
|---|---|
| Wake sleeping automation runs | when `wake_at` passes |
| `before_appointment` reminders | inside a 90-second window at the configured lead time |
| `after_last_visit` recall | ~10:00 clinic-local, once a day |
| Birthdays | ~09:00 clinic-local |
| `invoice_unpaid` | ~11:00 clinic-local |
| Expired-document sweep | continuous |
| Unsigned-document sweep | ~10:00 clinic-local |
| Weekly pending-documents digest | Sunday 09:00 clinic-local |
| Database backup | 03:00 UTC |

Every enqueue carries a `dedupe_key`, so a restart or a second worker can never double-fire.

### Worker internal HTTP API (default port 4020, `x-internal-secret` header)

`POST /sessions/{clinicId}/connect` · `POST /sessions/{clinicId}/disconnect` ·
`GET /health` (uptime + per-clinic session state) · `POST /render-pdf` ·
`POST /render-overlays` · `POST /simulate-inbound` (QA).

### Other worker loops

- **Outbound sender** — every 1.5s
- **Campaign pump** — every 2s
- **Notification delivery** — every 5s; digests every 60s
- **WhatsApp sessions** — one Baileys socket per clinic, auto-reconnect from
  `whatsapp_auth_state`
- **Status heartbeat** — rewrites `worker_status` (ai_ready, whatsapp_ready, version)

---

## 24. Internationalisation

- Two complete dictionaries: `src/lib/i18n/ar.ts` and `src/lib/i18n/en.ts` (~1,320 lines each),
  typed so a missing key is a compile error.
- Server (`src/lib/i18n/index.ts`) and client (`src/lib/i18n/client.tsx`) providers, plus
  `useI18nSafe` for components that must work both inside and outside the workspace provider.
- Locale from the user, falling back to the clinic default; `dir="rtl"` for Arabic throughout,
  with `rtl:rotate-180` on directional icons.
- Arabic UI uses **Latin numerals** (`ar-JO-u-nu-latn`).
- Patient-facing surfaces (booking, invoices, signing) pick language from the patient or the
  document, not from the staff member's cookie.
- Arabic fonts are fetched and self-hosted (`npm run fonts`).

---

## 25. Phone handling (`src/lib/phone.ts`)

E.164 normalisation is **the single source of patient identity**.

- Supports **JO (+962)**, **SA (+966)**, **AE (+971)**, and accepts any plausible foreign
  E.164 that arrives with a `+`.
- Converts **Arabic-Indic and Persian digits** (`٠-٩`, `۰-۹`) to ASCII.
- Handles `00` prefixes, a retained trunk `0` after the country code, local `07x`, bare
  `7x`, `05x`, bare `5x`, and Jordanian landlines `0[2356]…`.
- **Ambiguous `05…` resolves to Saudi (+966) unless the clinic's country is UAE** — SA and
  AE share the local mobile shape; SA is the larger Gulf market and the clinic's country
  breaks the tie.
- Display grouping `+962 79 074 4070`; helpers for WhatsApp JID conversion both ways.
- `npm run test:phone` covers the matrix.

---

## 26. Data model reference

**Identity & tenancy** — `users`, `sessions`, `auth_tokens`, `clinics`, `clinic_members`,
`announcements`

**Patients** — `patients`, `patient_notes`, `patient_files`, `custom_field_defs` (legacy),
`patient_field_definitions`, `import_batches`

**Scheduling** — `services`, `service_doctors`, `appointments`, `booking_links`,
`booking_verifications`, `booking_questions`, `waitlist_entries`

**Notes** — `patient_notes`, `patient_note_versions`, `note_categories`

**Messaging** — `conversations`, `messages`, `quick_replies`, `whatsapp_sessions`,
`whatsapp_auth_state`, `campaigns`, `campaign_recipients`

**Money** — `invoices`, `invoice_items`, `payments`, `insurers`

**Automation** — `automations`, `automation_steps`, `automation_runs`,
`automation_run_logs`, `tasks`, `recipe_templates`

**AI** — `ai_agents`, `ai_knowledge_items`, `ai_conversation_state`, `ai_usage`,
`knowledge_templates`

**Documents** — `document_templates`, `document_template_versions`,
`document_template_library`, `service_documents`, `documents`, `document_signers`,
`document_fields`, `document_field_values`, `document_events`, `signing_tokens`,
`signing_sessions`, `signer_roles`

**Platform** — `notifications`, `push_subscriptions`, `jobs`, `audit_log`, `worker_status`,
`_migrations`

Every table with `updated_at` gets a `touch_updated_at` trigger automatically.

---

## 27. Route map

### Clinic workspace — `/c/{slug}`

`/` dashboard · `/conversations` · `/calendar` · `/patients` · `/patients/{id}` ·
`/campaigns` · `/campaigns/{id}` · `/invoices` · `/invoices/new` · `/invoices/{id}` ·
`/documents` · `/documents/{id}` · `/waitlist` · `/patients/import` · `/automations` ·
`/automations/{id}` · `/ai` ·
`/notifications` · `/signature` ·
`/settings` (+ `/booking`, `/documents`, `/documents/{id}`, `/fields`, `/hours`,
`/invoicing`, `/services`, `/staff`, `/whatsapp`)

### Agency admin — `/admin`

`/` · `/clinics/new` · `/clinics/{slug}` · `/monitoring` · `/announcements` · `/defaults` ·
`/documents`

### Public / unauthenticated

`/login` · `/forgot` · `/reset/{token}` · `/invite/{token}` · `/suspended` · `/offline` ·
`/book/{bslug}` · `/inv/{token}` · `/sign/{token}` ·
`/sign-device/{slug}/{docId}/{signerId}` · `/doc-print/{id}`

### API (representative)

`/api/health` · `/api/c/{slug}/events` (SSE) · `/api/c/{slug}/…` (patients, appointments,
conversations, documents, invoices, files, staff photos, WhatsApp status, payments export) ·
`/api/public/book/{bslug}/{slots,days,start,verify,resend}` · `/api/public/sign/{token}/{code,decline,pdf,progress,request-link,submit}` ·
`/api/public/clinic-logo/{slug}` · `/api/me/{notifications,push,dismiss-announcement}`

---

## 28. Commands

```bash
npm run dev:all       # database + web + worker in one terminal (migrates & seeds on boot)
npm run db            # embedded PostgreSQL + migrations
npm run dev           # Next.js on :3000
npm run worker        # WhatsApp, automations, AI, notifications on :4020
npm run seed          # reset the demo clinic with fresh Arabic data
npm run seed:recipes  # (re)load agency automation recipes
npm run migrate       # apply pending migrations
npm run doctor        # readiness check; every line is fine, or the command that fixes it
npm run typecheck     # app + worker
npm run test:phone    # phone normalization
npm run test:rls      # tenant isolation across every clinic-scoped table
npm run test:search   # Arabic search normalisation
npm run qa            # all ten browser QA suites in order
npm run qa:clean      # tear down QA fixtures
npm run bench         # performance benchmarks
npm run fonts         # fetch and self-host Arabic fonts
npm run icons         # generate PWA icons
```

### QA suites

Real browser (Playwright) against the running app, asserting against the database:

1. foundation, auth, tenancy · 2. patients · 3. calendar · 4. public booking ·
5. WhatsApp inbox · 6. invoicing · 7. automations · 8. AI receptionist ·
9. PWA & notifications · 10. admin & demo data

Plus focused suites: `qa-access`, `qa-automation-coverage`, `qa-backup`, `qa-booking-race`,
`qa-brand-credit`, `qa-campaigns`, `qa-db-resilience`, `qa-documents`, `qa-esign`,
`qa-esign-browser`, `qa-first-message`, `qa-import-digest`, `qa-mobile`, `qa-mobile-width`,
`qa-einvoicing`, `qa-payments`, `qa-pdf-idle`, `qa-photos`, `qa-waitlist-insurance`.

Run `qa-warm` first. A cold `next dev` compiles routes on first hit, and the resulting
timeouts look exactly like a dozen regressions.

Two things run against local doubles because both need credentials the dev environment lacks:

- **The AI receptionist** runs against `scripts/mock-anthropic.ts`, which speaks the Messages
  API. The agent's real code path — tool calls, availability lookup, booking, escalation, DB
  writes — is fully exercised; only the model is stubbed.
- **Web push** is verified against a local TLS endpoint (encryption, delivery, and pruning of
  revoked subscriptions all run for real). Headless browsers can't reach a live push service,
  so `pushManager.subscribe()` is only exercised as far as the permission grant.

---

## 29. Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | App connection, as the RLS-bound `clinicos_app` role |
| `DATABASE_SUPER_URL` | Superuser connection, migrations and seeds only |
| `PG_PORT` | Embedded PostgreSQL port (dev, default 5544) |
| `APP_URL` | Public base URL — used in WhatsApp links and invoice PDFs |
| `WORKER_URL` | Where the web app reaches the worker (default `http://localhost:4020`) |
| `INTERNAL_API_SECRET` | Shared secret between web and worker |
| `SESSION_SECRET` | Reserved for signed-cookie use |
| `STORAGE_DIR` | Local storage root (dev) |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Object storage (**required in production**) |
| `ANTHROPIC_API_KEY` | Enables the AI receptionist. **Must be set on the worker**, which is where the agent runs |
| `JOFOTARA_BASE_URL` | Overrides the ISTD host. Only for QA, which points it at `scripts/mock-jofotara.ts` — the real endpoint is the default |
| `ANTHROPIC_MODEL` | Fallback model when a clinic hasn't picked one |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web push |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Same public key, exposed to the browser |
| `BACKUP_KEEP` | Backups retained (default 14) |

---

## 30. Brand & attribution

- **Product**: Clinicti / كلينيكتي. **App**: `https://app.clinicti.app`. **Marketing site**:
  `clinicti.app` (the `landing/` directory, not yet deployed).
- Operated by the agency Makan Scaling, which is **not** named on any clinic- or
  patient-facing surface.
- Accent `#0b1220`, which is the same value as `--color-night` — the accent and the dark
  chrome are deliberately one colour. Brand steps 50–400 stay light and cool because they are
  backgrounds carrying brand-700 text.
- A clinic sets its **own** `brand_color` (schema default `#0f6e5c`) and logo; every
  patient-facing surface wears the clinic's colour, not Clinicti's.

### Privacy policy

`https://privacy.clinicti.app` — Arabic by default with an English toggle, written against
Jordan's **Personal Data Protection Law No. 24 of 2023**, contact `privacy@clinicti.app`.
Hosted separately (Netlify), so it stays reachable when the app is not.

Linked from every surface that collects personal data, and the two that only display it:

| Surface | Form |
|---|---|
| Public booking | Footer link **and** a consent line on the details step, under the button that submits the name and phone — not the OTP step, which does not exist when the clinic's WhatsApp is offline |
| Remote signing | Footer link |
| In-clinic signing kiosk | Address printed as **text**, not a link |
| Public invoice (screen) | Footer link |
| Login | Footer link |
| Invitation + password-reset emails | Footer link, both languages |
| Landing page | Footer link |

Deliberately **absent** from the printed surfaces — the invoice PDF and the document sheet.
A URL nobody can click is clutter on a financial record, and the signing certificate already
states in full what was recorded and why.

Note on roles: the **clinic** is the data controller for its patients' records; Clinicti is
the processor. The policy covers Clinicti's own handling, and does not replace whatever
notice a clinic owes its own patients.

### The credit

`src/components/powered-by.tsx` — the mark, the product name and a link to
`https://clinicti.app`, at 11px grey. It appears on every surface that leaves the clinic:
public booking pages, the public invoice (and therefore the invoice PDF, which is that page
printed), the document sheet, and the signing certificate. Printed surfaces also spell the
domain out, because a link annotation survives into a PDF but paper has no cursor.

**Exception**: the in-clinic signing kiosk renders the credit as plain text, not a link. The
tablet is in a patient's hands mid-signature and a browser is one tap from the rest of the
internet, so the signing chrome offers no link out. It is a link only when the signing session
is `remote` — the patient's own phone.

---

## 31. Design decisions worth knowing

Condensed from `DECISIONS.md`; each of these explains why something is the way it is.

**Infrastructure**

- Plain SQL migrations and genuine RLS/`LISTEN NOTIFY`, so the database is portable.
- Custom session auth (bcrypt + SHA-256 tokens, httpOnly cookies) rather than a hosted auth service.
- A Postgres `jobs` table instead of Redis/BullMQ — `FOR UPDATE SKIP LOCKED` plus `dedupe_key`.
- PDFs via headless Chromium, not a React PDF library: the only approach giving correct
  Arabic shaping and RTL tables without hand-managing font subsets.

**Tenancy**

- One database role with an `app.is_admin` escape hatch for the worker and auth layer, which
  legitimately span clinics; those run in an audited system context.
- Impersonation issues a separate session and is banner-flagged.

**Product**

- Path-based booking (`/book/{slug}`) maps 1:1 to a `book.domain.com` rewrite.
- Platform accent in the staff workspace, clinic branding on patient-facing surfaces.
- WhatsApp offline doesn't block online booking.
- The AI defaults to after-hours only and answers strictly from the knowledge base.
- Automation idempotency is scoped to the context, not the run.
- Critical alerts fall back to WhatsApp when push fails.

**Documents**

- The frozen snapshot, not the PDF, is what the hash covers and what a dispute is resolved against.
- `document_events` is append-only, with a cascade-aware exception so tenants remain deletable.
- Placed field coordinates are page fractions.
- Editing a template publishes a version rather than mutating one.
- An uploaded signed copy is marked as one and never dressed up as a captured signature.
- The kiosk has no hand-over gate; containment arms immediately.
- The document list loads both scopes and filters in the browser (tab switch under 400ms,
  no navigation).

**Gotchas that bit during the build**

- `jsonb` read back from `pg` must be **re-stringified** before being written again —
  node-pg encodes a JS array as a Postgres array literal, which fails as JSON.
- `Promise.all` over a single `pg` client is a no-op; node-pg serialises per connection.
- A `date` column comes back from node-pg as a JS `Date` in the *server's* zone, so
  clinic-local day comparisons must cast `::text` (this silently broke the daily cap).
- The PostgreSQL cluster must be initialised `--encoding=UTF8`; Windows `initdb` defaults to
  WIN1252, which cannot store Arabic at all.
- Baileys is pinned to 6.7.21; 7.0.0-rc pulls a native bridge that breaks Node's resolver.
- TypeScript is pinned to 5.x.

**Operational notes carried in project memory**

- Every requested change ships to production the same turn: migrate-prod, push to main, verify.
- "Target crashed" on PDF renders usually means a stale worker still owns port 4020.
- `EAUTHQUERY` / connection-refused 500s are almost always the pooler, not Postgres — check
  `pg_postmaster_start_time` before blaming the database.
- The app retries **connects**, never queries; widening the retry to queries would double writes.
- Measure performance against a scratch `dist` dir — dev mode is ~10× slower than production,
  and never build into `.next` while dev is running.
