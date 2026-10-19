# Clevo

Two layers in one product:

1. **Patient communication automation.** Enquiry → classification → booking → WhatsApp confirmation →
   reminders → no-show recovery → discharge follow-up → feedback, with a staff work queue for everything
   that needs a person. It sits around a hospital's existing systems, or works on its own.
2. **A hospital operating system for the OPD and wards**, so the automation has a source of truth:
   reception and a token queue, the doctor's consultation and e-prescription, a pharmacy with batch stock,
   billing and payments, wards and beds, and management analytics. Every step feeds the WhatsApp layer
   (token, prescription ready, receipt, follow-up reminder, discharge follow-up).

The automation never diagnoses or advises on treatment: patient messages are fixed templates. Clinical
records are written by doctors, behind per-person logins, and every change names the person who made it.

### The patient journey, end to end

```
 enquiry / walk-in
      │
 Reception ─ register (UHID), check in, token ──► queue
      │
 Doctor ──── calls in, vitals, case sheet, prescription (allergy check) ──► finish
      │                                                   │
 Pharmacy ── dispenses from batches, first-expired-first-out   WhatsApp: consultation done, follow-up reminder
      │
 Billing ─── invoice (fee + medicines + services) ──► payment ──► receipt (WhatsApp)
      │
 Wards ───── admit, move, discharge ──► discharge follow-up + feedback automation ──► bed charges to billing
      │
 Analytics ─ patients, waits, money, diagnoses, occupancy
```

Each role sees only its own screens (`src/lib/rbac.ts`).

## Quick start (local)

Requirements: Node 22+, PostgreSQL 15+.

```bash
npm install
cp .env.example .env          # defaults work with no API keys
npm run db:setup              # create tables + demo hospital (4 departments, 8 doctors, 14 days of slots)
npm run dev:all               # web app on http://localhost:3000 + background worker

Before a sales demo, fill the hospital with a month of realistic history so the dashboard and reports
look alive (this clears existing transactional data and regenerates open slots):

```bash
npm run db:demo               # ~200 enquiries over 30 days, with no-shows, discharges and feedback
```
```

| URL | What |
|---|---|
| `/login` | Staff sign-in (per person, with roles) |
| `/enquiry` | Public patient form for the fictional *DemoCare Multispeciality Hospital* |
| `/` | Staff dashboard (live) |
| `/reception`, `/reception/register` | Front desk: queue, expected appointments, patient search and registration |
| `/consult`, `/consult/<visit>` | Doctor's queue and consultation workspace (vitals, case sheet, prescription) |
| `/patients/<id>` | Patient record: details, visits, consultations |
| `/pharmacy`, `/pharmacy/stock` | Dispensing counter, batch stock, receiving, expiry and low-stock |
| `/billing`, `/billing/<id>`, `/billing/day-book` | Invoices, payments, refunds, day book, printable invoice |
| `/wards`, `/admissions/<id>` | Bed board, admissions, transfers, discharge |
| `/analytics` | Hospital analytics: patients, waits, collections, diagnoses, occupancy |
| `/admin/users` | Staff accounts and roles (administrator) |
| `/leads/<id>` | Full automation timeline for one enquiry |
| `/discharges` | Record a discharge and watch post-discharge coordination |
| `/follow-ups` | Patients being chased after a missed appointment, with recovery KPIs |
| `/feedback` | Patient ratings, satisfaction stats and service-recovery queue |
| `/reports` | Management report: funnel, conversion, response times, department and source performance |
| `/r/<token>` | One-time patient feedback link (public, sent by WhatsApp) |
| `/exceptions` | Work queue: everything the system would not decide on its own |
| `/phone` | Demo phone showing the WhatsApp messages patients would receive |
| `POST /api/webhooks/lead` | Intake for external sources (Tally, website, Meta lead ads) |
| `POST /api/webhooks/discharge` | Discharge event from the hospital's HMS |
| `GET/POST /api/webhooks/whatsapp` | Delivery receipts and patient replies from Meta (signature verified) |
| `GET /api/health` | Health check for uptime monitoring |

## How it works

```
Patient form / webhook
      │  validate, dedupe, store, queue            (≈ instant; responds 202)
      ▼
   jobs table ──► worker
                    │ 1. classify (AI or rules) + deterministic safety check
                    │ 2a. emergency  → staff alert (high) + "call 108" message
                    │ 2b. unclear / clinical question → staff review + acknowledgement
                    │ 2c. routine → lock earliest free slot → book → confirmation
                    │ 3. reminders scheduled 24h and 3h before the visit
                    ▼
         communication_log · exceptions · audit_log
```

Everything runs on Postgres. There is no n8n/Make dependency: the job queue is a table claimed with
`FOR UPDATE SKIP LOCKED`, so any number of workers can run safely.

### Invariants the database enforces (and the tests attack)

- A queue token is never issued twice; a patient is never in the same doctor's queue twice.
- A prescription is locked once finished; later notes are addenda with their author.
- Stock never goes negative; a batch's count always equals the sum of its movement ledger; expired
  batches are never dispensed; two counters cannot take the last units.
- Each billable item is on at most one live invoice; a payment cannot exceed the balance, even with two
  counters at once; a double-clicked payment form records once; voiding frees the items to be re-billed.
- A bed holds one patient and a patient is in one bed; a transfer day is charged once.

## Safety guarantees (each is covered by tests)

- **No double booking.** Slots are locked in a transaction; concurrent leads racing for one slot get exactly one booking.
- **No duplicate leads.** Repeated or concurrent webhook submissions collapse into one lead (idempotency key).
- **No duplicate messages.** Every message has a dedupe key claimed *before* sending. A definite provider rejection
  is retried; an ambiguous outcome (timeout, crash) is never auto-retried and raises a high-severity exception.
- **Emergencies are never missed by the AI.** A deterministic safety check (English + common Hinglish) runs on
  every enquiry and can only make the outcome more conservative.
- **Minimum data to the AI.** The model receives the enquiry text and department list only, never name or phone.
- **AI output is never trusted blindly.** It is schema-validated; unknown departments become `NEEDS_HUMAN_REVIEW`;
  if the AI is down or returns garbage, the rules engine takes over and IT is alerted.
- **Consent respected.** No WhatsApp message without consent; staff get a task to call instead.
- **Nothing fails silently.** Failed jobs retry with backoff, then open an exception with an owner and due time.
- **Replies reach a person, never a bot.** The system never answers a patient message. A reply
  becomes work for staff, and a reply that sounds clinical becomes urgent work — the same
  safety net as the enquiry form applies to WhatsApp.
- **Opt-out is honoured immediately.** "STOP" (and its Hinglish equivalents) withdraws consent
  and cancels everything already queued for that patient.
- **Delivery is tracked, not assumed.** Receipts move a message sent → delivered → read, never
  backwards, and a failed delivery opens work for staff.
- **Full audit trail.** Every step is logged with actor (patient / system / ai / staff) and correlation ID.
- **Cancelled slots are reusable.** Cancelling frees the slot immediately, stops reminders and recovery,
  and tells the patient; a cancelled appointment never blocks that slot or that lead again.
- **No pointless chasing.** Recovery stops the moment a patient rebooks or staff correct the attendance,
  and reminders for a missed visit are cancelled.

## Configuration

All settings are in `.env` (see `.env.example`).

### AI provider

| Setting | Meaning |
|---|---|
| `AI_PROVIDER=rules` | Deterministic keyword classifier. No API key. Good for demos. |
| `AI_PROVIDER=openai_compatible` | Any OpenAI-compatible API: OpenRouter, DeepSeek, OpenAI, Groq, local Ollama. |

OpenRouter example:

```env
AI_PROVIDER=openai_compatible
AI_BASE_URL=https://openrouter.ai/api/v1
AI_API_KEY=sk-or-...
AI_MODEL=anthropic/claude-haiku-4.5
```

The task is simple classification, so small, fast models are enough. For real patient data, prefer a provider
whose data-retention terms the hospital's IT/privacy team has approved.

### WhatsApp

`MESSAGING_PROVIDER=mock` shows messages on the demo phone. For real sending set
`MESSAGING_PROVIDER=whatsapp_cloud` with `WA_PHONE_NUMBER_ID` and `WA_ACCESS_TOKEN` from Meta, and register the
templates in `src/server/messaging/templates.ts` (names like `appt_confirm_01`) in WhatsApp Manager.

In mock mode, phone numbers ending in `0000` simulate a provider rejection, to demo the failure path.

### No-show recovery

A missed visit is detected either from staff marking attendance or automatically,
`NO_SHOW_GRACE_MINUTES` after the visit ended (`NO_SHOW_AUTO_DETECT=false` for hospitals whose HMS
reports attendance). The patient then gets a reschedule message with real open slots, reception gets a task,
and after `NO_SHOW_FOLLOWUP_HOURS` the system tries again up to `NO_SHOW_MAX_ATTEMPTS` before handing the
patient to a person. Set `NO_SHOW_RECOVERY_DELAY_MINUTES=0` for live demos so the message appears instantly.

### Discharge follow-up and feedback

A discharge arrives from the HMS webhook or the staff form. **The follow-up date must come from the hospital
and name the clinician who approved it** - the system never infers one. Without an approved date the discharge
is queued for the department instead of promising the patient anything.

The patient then gets the approved date, a reminder the day before, and a feedback link
`FEEDBACK_DELAY_HOURS` after discharge (set `0` for live demos). A rating of 3 or below immediately opens a
service-recovery task and an exception. No clinical content is ever stored or sent.

### Management report and daily summary

`/reports` answers the questions an HMS cannot: how fast enquiries were answered, how many converted,
which source and department they came from, how many needed a person, and whether the automation itself is healthy.

The daily summary is written from **aggregate numbers only** - no names, phone numbers, enquiry text or
clinical data ever reach the AI provider. Without an AI provider (or if it fails) a deterministic summary is
generated from the same numbers.

### Security

- `WEBHOOK_SECRET`: when set, the webhook requires header `x-webhook-secret`.
- Staff sign in with their own account (email and password, 12-hour sessions, lock-out after five wrong
  attempts). Roles: administrator, receptionist, doctor, pharmacist, billing, nurse; what each may see and
  do is defined in `src/lib/rbac.ts`. Create the first administrator with
  `npm run user:create -- --role admin --name "Your Name" --email you@hospital.com`, then manage everyone
  from **Staff accounts**. Production should sit behind HTTPS.

## Retention (DPDP Act 2023)

The worker purges daily, and `npm run retention` runs it on demand:

- message bodies and patient replies are redacted after `RETENTION_MESSAGE_DAYS` (180 default)
- free-text enquiries after `RETENTION_ENQUIRY_DAYS` (365 default)
- what remains is the operational record — who was contacted, which template, when, and whether
  it arrived — so the hospital can answer "did you contact this patient" years later without
  still holding what the patient said
- the audit log is untouched, because it never contained patient content

Every run is recorded in `retention_runs`, which is what an auditor asks to see.

## Deploying

See [docs/DEPLOY.md](docs/DEPLOY.md): Ubuntu VPS, Postgres, two systemd services, Caddy for
HTTPS, nightly backups. Before the first real patient:

```bash
npm run preflight
```

It fails on the things that actually break deployments — pending migrations, a worker that was
never started, demo data still present, a development database password, no administrator account,
HTTP instead of HTTPS, WhatsApp still on the demo phone.

## Tests

```bash
npm test          # unit + integration tests against TEST_DATABASE_URL (a separate database)
npm run typecheck
```

## Deployment

`docker compose up -d --build` runs Postgres, migrations, web and worker (set `POSTGRES_PASSWORD` in `.env`).
Note: the Docker setup has not yet been run on a machine with Docker installed; verify before the first deployment.

## Blueprint coverage

| Blueprint demo | Status |
|---|---|
| Demo 1: Lead → AI classification → availability → booking → confirmation → reminders | Done |
| Demo 2: No-show → recovery message → follow-up task → staff escalation | Done |
| Demo 3: Discharge → approved follow-up → reminder → feedback → service recovery | Done |
| Beyond the blueprint: reception, consultation, e-prescription, pharmacy, billing, wards, analytics | Done |
