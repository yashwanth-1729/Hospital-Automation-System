# NIT Hospital Automation

An automation layer that sits **around** a hospital's existing systems (HMS/EMR/CRM) and handles the
administrative patient journey: enquiry → classification → booking → WhatsApp confirmation → reminders,
with a staff work queue for everything that needs a person.

It does **not** diagnose, advise on treatment, or interpret results. Clinical content is always routed to staff.

## Quick start (local)

Requirements: Node 22+, PostgreSQL 15+.

```bash
npm install
cp .env.example .env          # defaults work with no API keys
npm run db:setup              # create tables + demo hospital (4 departments, 8 doctors, 14 days of slots)
npm run dev:all               # web app on http://localhost:3000 + background worker
```

| URL | What |
|---|---|
| `/enquiry` | Public patient form for the fictional *DemoCare Multispeciality Hospital* |
| `/` | Staff dashboard (live) |
| `/leads/<id>` | Full automation timeline for one enquiry |
| `/follow-ups` | Patients being chased after a missed appointment, with recovery KPIs |
| `/exceptions` | Work queue: everything the system would not decide on its own |
| `/phone` | Demo phone showing the WhatsApp messages patients would receive |
| `POST /api/webhooks/lead` | Intake for external sources (Tally, website, Meta lead ads) |
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
- **Full audit trail.** Every step is logged with actor (patient / system / ai / staff) and correlation ID.
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

### Security

- `WEBHOOK_SECRET`: when set, the webhook requires header `x-webhook-secret`.
- `DASHBOARD_PASSWORD`: when set, the staff console requires basic auth (user `admin`). Set this before exposing
  the app beyond localhost. Production should sit behind HTTPS.

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
| Demo 3: Discharge → approved follow-up → reminder → feedback → service recovery | Next |
