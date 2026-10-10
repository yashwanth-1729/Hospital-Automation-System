# Handoff: where this project stands

**Project 1 of 2.** This is the company product, built for Nithish (`nithishbabu236@gmail.com`),
from the "Hospital AI Automation Master Blueprint V3" PDF. The blueprint says to build it in
Make.com or n8n; we deliberately did not: it is custom code on a VPS, so the company owns it, it
can be tested, and it runs on the hospital's own server.

The other project (a voice call agent for a demo at Yashwanth's mother's hospital) lives at
`D:\hospital-voice-agent` and is tracked in its own chat. Keep them separate.

## What it is

Two layers in one product.

1. **Patient communication automation** (the blueprint): enquiry, AI classification, booking,
   WhatsApp confirmation, reminders, no-show recovery, discharge follow-up, feedback, with a staff
   console, management reports and a paid-audit tool for selling it.
2. **A hospital operating system** (added after the founder's brief, modelled on a MERN "Clevo"
   product but built in this stack): per-person logins and roles, reception and a token queue,
   consultation with vitals, case sheet and e-prescription (allergy check), pharmacy with batch
   stock, billing and payments, wards and beds, analytics. Each step feeds the WhatsApp layer.

Commercially: ₹50,000 starter, ₹1,00,000 growth, plus monthly maintenance.

## State: working, tested, deployable, not yet deployed

- ~370 tests, type check clean. Everything above was also driven end to end in a browser.
- Runs locally: `npm run dev:all` (web + worker), Postgres 18 on localhost.
- Create the first admin with `npm run user:create -- --role admin --name "..." --email ...`.
- AI: OpenRouter, `deepseek/deepseek-v4-flash`. Key is in `.env`, which is gitignored.
- One-command server install: `deploy/bootstrap.sh` (Ubuntu). See `docs/DEPLOY.md`.

## Not done

1. **Not deployed anywhere.** The VPS (`135.125.222.22`, SSH port 20078) is ready for the installer
   but nobody has run it: a person must log in and run the one-liner in `docs/DEPLOY.md`. The
   work since the last push is only on the local `master` branch until pushed to `origin/main`.
2. **Real WhatsApp sending is untested against Meta.** 14 templates exist in
   `src/server/messaging/templates.ts`. `npm run templates` shows them; `-- --submit` sends them for
   approval (needs `WA_BUSINESS_ACCOUNT_ID`, `WA_ACCESS_TOKEN`). Until approved, nothing can be sent.
   The test number can only message numbers added as recipients in the Meta console.
3. **Inpatient medicines and clinical notes** are out of scope: admissions track beds, charges and
   discharge. Vitals and prescriptions belong to OPD visits.
4. **Lab/diagnostics, insurance claims, procurement** are not built. The data model leaves room.
5. **Audit form wording** is a draft, never tested on a real hospital owner.
6. **Docker compose** exists but has never been run (no Docker on the laptop).

## Conventions worth keeping

- Every patient-facing message is a fixed template, never AI-written text.
- Emergencies are caught by a deterministic keyword check regardless of the AI, and can only make
  the outcome more cautious.
- Nothing fails silently: every failure opens an exception with an owner and a due time.
- Authorisation is by capability (`src/lib/rbac.ts`) and is checked against the database in every
  page and action (`requireStaff`). The proxy only redirects people with no cookie.
- Money and stock are in the database with constraints, and the tests attack the concurrent
  cases (two counters, last unit, double click). Keep that bar.
- Form fields that a server action can reject are controlled components, so an error never wipes
  what someone typed.
- Staff-initiated audit rows carry `actor_id`; reach it through `requireStaff` (it records the actor).

## Sales material

Pitch sheet and demo script: https://claude.ai/code/artifact/4ab3ab61-b035-4612-bfaf-47cd83d8a1b7
(written before the hospital operating system existed; worth refreshing).
