# Deploying to a VPS

Written for Ubuntu 24.04 on a small VPS (2 vCPU / 4 GB is plenty for one hospital). Two
processes — web and worker — plus Postgres and Caddy for HTTPS. No Docker needed; if you
prefer containers, `docker compose up -d --build` does the same thing, but has not been
tested yet.

Budget: roughly ₹500–1,500 a month for the server.

## 1. Server

```bash
sudo apt update && sudo apt install -y postgresql nodejs npm git
sudo adduser --system --group --home /opt/nit-hospital-automation nit
```

Node must be 22 or newer (`node -v`). If Ubuntu ships something older, install from NodeSource.

## 2. Database

```bash
sudo -u postgres psql
```
```sql
CREATE ROLE nit_app LOGIN PASSWORD 'use-a-long-random-password';
CREATE DATABASE nit_hospital OWNER nit_app;
```

Postgres should listen on localhost only (the default). The database is never exposed to the
internet; the app reaches it over the loopback interface.

## 3. Application

```bash
sudo -u nit git clone <your repo> /opt/nit-hospital-automation
cd /opt/nit-hospital-automation
sudo -u nit npm ci
sudo -u nit cp .env.example .env
sudo -u nit nano .env          # see the checklist below
sudo -u nit npm run build
sudo -u nit npm run db:migrate
sudo -u nit npm run db:seed    # departments, doctors and slots; skip if the HMS supplies them
```

`.env` must have, at minimum:

| Setting | Why |
|---|---|
| `DATABASE_URL` | the password you just set, not the development one |
| `PUBLIC_BASE_URL` | `https://your-domain` — patient links use it |
| `WEBHOOK_SECRET` | without it, anyone can post leads into the system |
| `HOSPITAL_NAME`, `HOSPITAL_CONTACT` | spoken to patients in every message |
| `AI_API_KEY` | OpenRouter, or leave `AI_PROVIDER=rules` |
| `MESSAGING_PROVIDER=whatsapp_cloud` + `WA_*` | real WhatsApp; `WA_APP_SECRET` is required |

Keep `.env` at mode 600, owned by `nit`. It holds credentials for the hospital's WhatsApp
account.

Then create the first administrator. There is no shared password: everyone signs in as
themselves, and the administrator adds the rest from **Staff accounts**.

```bash
sudo -u nit npm run user:create -- --role admin --name "Your Name" --email you@hospital.com
```

It prints a temporary password once; you choose your own at first sign-in. If every
administrator is ever locked out, `npm run user:reset -- --email you@hospital.com` on the
server recovers access.

## 4. Services

```bash
sudo cp deploy/nit-web.service deploy/nit-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nit-web nit-worker
sudo systemctl status nit-web nit-worker
```

Logs: `journalctl -u nit-web -f` and `journalctl -u nit-worker -f`.

**Both must run.** The web process takes enquiries; the worker does everything else —
classification, messages, reminders, no-show detection, retention. With the worker stopped,
enquiries pile up silently in the queue. The dashboard shows a warning when it is not running,
and `/api/health` returns 503.

## 5. HTTPS

```bash
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # set the real domain
sudo systemctl restart caddy
```

Caddy gets a certificate automatically. Point the domain's A record at the server first.

## 6. Backups

```bash
sudo cp deploy/backup.sh /usr/local/bin/nit-backup && sudo chmod +x /usr/local/bin/nit-backup
sudo crontab -e     #  15 2 * * *  /usr/local/bin/nit-backup
```

Nightly `pg_dump`, kept 14 days, mode 600. **Restore one into a scratch database every month.**
A backup nobody has restored is not a backup.

## 7. Before the first real patient

```bash
npm run preflight
```

It checks the things that actually break deployments: pending migrations, a worker that was
never started, demo data still present, a development database password, a missing dashboard
password, HTTP instead of HTTPS, and whether WhatsApp is still on the demo phone. It exits
non-zero while anything is blocking.

Then, from the blueprint's go-live procedure:

1. Clear demo data (`psql` → truncate the transactional tables, or run `npm run db:demo` only
   on a demo server, never on the hospital's).
2. Register the WhatsApp templates and wait for approval. `npm run templates` prints every
   template exactly as it will be sent; `npm run templates -- --submit` creates the missing ones
   in Meta (set `WA_BUSINESS_ACCOUNT_ID` and `WA_ACCESS_TOKEN`). It never edits or deletes an
   existing template.
3. Point Meta's webhook at `https://your-domain/api/webhooks/whatsapp` with your
   `WA_VERIFY_TOKEN`, and subscribe to the `messages` field so delivery receipts and replies
   arrive.
4. Send one test enquiry to a staff member's own number and watch it end to end.
5. Agree who owns the exceptions queue, and check it on day one.

## Updating

```bash
cd /opt/nit-hospital-automation
sudo -u nit git pull
sudo -u nit npm ci
sudo -u nit npm run build
sudo -u nit npm run db:migrate
sudo systemctl restart nit-web nit-worker
```

Migrations run in a transaction and are applied once. Restarting mid-job is safe: jobs are
claimed with a lock and released back to the queue if a worker dies.

## If something goes wrong

| Symptom | Where to look |
|---|---|
| Enquiries arrive but nothing happens | Is the worker running? `systemctl status nit-worker` |
| Messages stuck at "sending" | The provider never answered — the exceptions page lists them as delivery unknown |
| Every enquiry goes to review | The AI provider may be down; the dashboard shows `rules_fallback` |
| Patients report no WhatsApp | Templates not approved, or the number is not verified in Meta |
| Dashboard 503 | Database unreachable, or the worker has not reported for 60 seconds |

Every failure also appears on the exceptions page with an owner and a due time. That page,
not the logs, is the daily view for hospital staff.
