# Handoff — where this project stands

**Project 1 of 2.** This is the company product, built for Nithish (`nithishbabu236@gmail.com`),
from the "Hospital AI Automation Master Blueprint V3" PDF. The blueprint says to build it in
Make.com or n8n; we deliberately did not — it is custom code on a VPS instead, so the company
owns it, it can be tested, and it runs on the hospital's own server.

The other project (a voice call agent for a demo at Yashwanth's mother's hospital) lives at
`D:\hospital-voice-agent` and is tracked in its own chat. Keep them separate.

## What it is

A WhatsApp-based automation layer around a hospital's existing HMS: enquiry → AI classification
→ booking → confirmation → reminders → no-show recovery → discharge follow-up → feedback, with a
staff console, management reports and a paid-audit tool for selling it.

Commercially: ₹50,000 starter, ₹1,00,000 growth, plus monthly maintenance.

## State: working, tested, not deployed

- 7 commits, clean tree, **143 tests**, type check and production build clean.
- All three blueprint demos work end to end, verified in a browser, not only in tests.
- Runs locally: `npm run dev:all` (web + worker), Postgres 18 on localhost.
- AI: OpenRouter, `deepseek/deepseek-v4-flash` (~25× cheaper than Haiku, scored better on our
  own test set). Key is in `.env`, which is gitignored.

Read `README.md` for the full picture — it documents the safety guarantees, configuration and
what still has to happen before a real hospital uses it.

## Not done

1. **Real WhatsApp sending.** Code is written and untested against Meta. Needs a test number
   (Yashwanth can create it himself; an email explaining it went to Nithish on 20 Sep).
2. **Docker deployment** — `docker-compose.yml` exists but has never run; Docker is not
   installed on this laptop.
3. **Not deployed anywhere.** Localhost only. A VPS with a real URL is the highest-value next
   step: opening a live link in a hospital beats "let me start my laptop", and it would prove
   the untested Docker setup.
4. **Audit form wording** is my draft, never tested on a real hospital owner.
5. Blueprint modules beyond the three demos (diagnostics, billing, IPD, referrals) are
   deliberately skipped — the blueprint itself says build three, sell, then extend per client.

## Sales material

Pitch sheet and demo script: https://claude.ai/code/artifact/4ab3ab61-b035-4612-bfaf-47cd83d8a1b7

## Conventions worth keeping

- Every patient-facing message is a fixed template, never AI-written text (WhatsApp requires
  pre-approved templates anyway).
- Emergencies are caught by a deterministic keyword check that runs regardless of the AI, and
  can only make the outcome more cautious.
- Nothing fails silently: every failure opens an exception with an owner and a due time.
- Tests cover the concurrency and failure paths (double booking, duplicate messages, ambiguous
  sends, crashed workers). Keep that bar — it is the difference between this and the thousands
  of copies of the same blueprint.
