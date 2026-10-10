#!/usr/bin/env bash
#
# One-shot installer for NIT Hospital Automation on a fresh Ubuntu 22.04 / 24.04 server.
#
#   curl -fsSL https://raw.githubusercontent.com/yashwanth-1729/Hospital-Automation-System/main/deploy/bootstrap.sh | bash
#
# Optional settings, given as variables in front of `bash`:
#
#   DOMAIN=care.example.com   default: <server-ip>.sslip.io, which gets a real HTTPS certificate
#                             with no DNS work. Use your own domain once you have one.
#   AI_API_KEY=sk-or-...      OpenRouter key. Without it, the keyword classifier is used.
#   WA_PHONE_NUMBER_ID=...    all three of these switch WhatsApp from the demo phone to real
#   WA_ACCESS_TOKEN=...       sending. Leave them out until the templates are approved.
#   WA_APP_SECRET=...
#   ADMIN_EMAIL=you@hospital  sign-in email for the first administrator (default admin@<domain>).
#   DEMO_DATA=1               load a month of fictional history, into an EMPTY database only.
#
# Safe to run again: it pulls the latest code and restarts. It never replaces an existing .env
# or database, so re-running cannot lose data or reset a password.

set -euo pipefail

APP_DIR=/opt/nit-hospital-automation
APP_USER=nit
REPO_URL="${REPO_URL:-https://github.com/yashwanth-1729/Hospital-Automation-System.git}"
BRANCH="${BRANCH:-main}"
DB_NAME=nit_hospital
DB_USER=nit_app
ENV_FILE="$APP_DIR/.env"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (or put sudo in front of bash)"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "written for Ubuntu; this server is ${PRETTY_NAME:-unknown}"
export DEBIAN_FRONTEND=noninteractive
cd /tmp

as_app() { sudo -u "$APP_USER" -H "$@"; }

# ---------------------------------------------------------------------------------------------
say "Checking memory"
mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
if [ "$mem_mb" -lt 3000 ] && [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  # The production build is memory hungry; on a small server it would be killed without swap.
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "server has ${mem_mb} MB of RAM: added 2 GB of swap for the build"
else
  echo "${mem_mb} MB of RAM"
fi

# ---------------------------------------------------------------------------------------------
say "Installing system packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg openssl sudo postgresql postgresql-contrib

if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
  echo "Node.js $(node -v) is already installed"
else
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
  echo "installed Node.js $(node -v)"
fi

# ---------------------------------------------------------------------------------------------
say "Fetching the code"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
  as_app git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  as_app git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
else
  as_app git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
echo "at commit $(as_app git -C "$APP_DIR" log --oneline -1)"

# ---------------------------------------------------------------------------------------------
say "Setting up the database"
systemctl enable --now postgresql >/dev/null 2>&1
psql_pg() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qtAX "$@"; }

FRESH_ENV=1
if [ -f "$ENV_FILE" ] && grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  FRESH_ENV=0
  echo "keeping the existing configuration and database password"
else
  DB_PASS="$(openssl rand -hex 24)"
  if [ "$(psql_pg -c "SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER'")" = "1" ]; then
    psql_pg -c "ALTER ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS'"
  else
    psql_pg -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
  fi
  if [ "$(psql_pg -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" != "1" ]; then
    psql_pg -c "CREATE DATABASE $DB_NAME OWNER $DB_USER"
  fi
  echo "created database $DB_NAME"
fi

# ---------------------------------------------------------------------------------------------
if [ -z "${DOMAIN:-}" ]; then
  ip="$(curl -fsS -m 8 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  DOMAIN="${ip//./-}.sslip.io"
fi

set_env() { # KEY VALUE: replace the line if present, append it if not
  local key="$1" value="$2" escaped
  escaped="$(printf '%s' "$value" | sed -e 's/[\\|&]/\\&/g')"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

if [ "$FRESH_ENV" -eq 1 ]; then
  say "Writing the configuration"
  install -m 600 -o "$APP_USER" -g "$APP_USER" "$APP_DIR/.env.example" "$ENV_FILE"
  set_env DATABASE_URL "postgresql://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME"
  set_env TEST_DATABASE_URL ""
  set_env POSTGRES_PASSWORD ""
  set_env PUBLIC_BASE_URL "https://$DOMAIN"
  set_env WEBHOOK_SECRET "$(openssl rand -hex 24)"
  set_env WA_VERIFY_TOKEN "$(openssl rand -hex 16)"

  if [ -n "${AI_API_KEY:-}" ]; then
    set_env AI_PROVIDER openai_compatible
    set_env AI_API_KEY "$AI_API_KEY"
  fi
  if [ -n "${WA_PHONE_NUMBER_ID:-}" ] && [ -n "${WA_ACCESS_TOKEN:-}" ] && [ -n "${WA_APP_SECRET:-}" ]; then
    set_env MESSAGING_PROVIDER whatsapp_cloud
    set_env WA_PHONE_NUMBER_ID "$WA_PHONE_NUMBER_ID"
    set_env WA_ACCESS_TOKEN "$WA_ACCESS_TOKEN"
    set_env WA_APP_SECRET "$WA_APP_SECRET"
  fi
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# ---------------------------------------------------------------------------------------------
say "Installing dependencies and building (this takes a few minutes)"
as_app bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund && npm run build"

say "Applying database migrations"
as_app bash -c "cd '$APP_DIR' && npm run db:migrate"

departments="$(sudo -u postgres psql -d "$DB_NAME" -qtAX -c 'SELECT count(*) FROM departments' 2>/dev/null || echo 0)"
if [ "$departments" = "0" ]; then
  echo "loading the demonstration departments, doctors and appointment slots"
  as_app bash -c "cd '$APP_DIR' && npm run db:seed"
fi

ADMIN_PASSWORD=""
admins="$(sudo -u postgres psql -d "$DB_NAME" -qtAX -c "SELECT count(*) FROM staff_users WHERE role = 'admin' AND active" 2>/dev/null || echo 0)"
if [ "$admins" = "0" ]; then
  ADMIN_EMAIL="${ADMIN_EMAIL:-admin@$DOMAIN}"
  say "Creating the first administrator"
  created="$(as_app bash -c "cd '$APP_DIR' && npm run --silent user:create -- --role admin --name Administrator --email '$ADMIN_EMAIL'")"
  ADMIN_PASSWORD="$(printf '%s\n' "$created" | sed -n 's/^Temporary password: //p')"
  [ -n "$ADMIN_PASSWORD" ] || die "could not create the administrator: $created"
fi

leads="$(sudo -u postgres psql -d "$DB_NAME" -qtAX -c 'SELECT count(*) FROM leads' 2>/dev/null || echo 0)"
DEMO_ACCOUNTS=""
if [ "${DEMO_DATA:-0}" = "1" ] && [ "$leads" = "0" ]; then
  echo "loading a month of fictional history"
  as_app bash -c "cd '$APP_DIR' && npm run db:demo"
  # One sign-in per role, for showing each person's view. Random passwords, printed once below.
  DEMO_ACCOUNTS="$(as_app bash -c "cd '$APP_DIR' && npm run --silent user:demo" || true)"
fi

# ---------------------------------------------------------------------------------------------
say "Starting the services"
install -m 644 "$APP_DIR/deploy/nit-web.service" /etc/systemd/system/nit-web.service
install -m 644 "$APP_DIR/deploy/nit-worker.service" /etc/systemd/system/nit-worker.service
systemctl daemon-reload
systemctl enable nit-web nit-worker >/dev/null 2>&1
systemctl restart nit-web nit-worker

say "Setting up HTTPS (Caddy)"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

say "Scheduling nightly backups"
install -m 755 "$APP_DIR/deploy/backup.sh" /usr/local/bin/nit-backup
printf '15 2 * * * root /usr/local/bin/nit-backup >> /var/log/nit-backup.log 2>&1\n' > /etc/cron.d/nit-backup
chmod 644 /etc/cron.d/nit-backup

# ---------------------------------------------------------------------------------------------
say "Waiting for the app to come up"
healthy=0
for _ in $(seq 1 40); do
  body="$(curl -sS -m 5 http://127.0.0.1:3000/api/health 2>/dev/null || true)"
  if printf '%s' "$body" | grep -q '"worker_online":true'; then healthy=1; break; fi
  sleep 3
done
echo "health: ${body:-no response}"
[ "$healthy" -eq 1 ] || warn "the app is not fully healthy yet: journalctl -u nit-web -u nit-worker -n 50"

say "Go-live check"
as_app bash -c "cd '$APP_DIR' && npm run preflight" || true

cert=0
for _ in $(seq 1 15); do
  if [ "$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "https://$DOMAIN/login" 2>/dev/null)" = "200" ]; then cert=1; break; fi
  sleep 4
done

cat <<EOF

--------------------------------------------------------------------------------
 NIT Hospital Automation is installed.

   Address        https://$DOMAIN  $( [ "$cert" -eq 1 ] && echo "(HTTPS working)" || echo "(certificate still being issued: try again in a minute)" )
   Patient form   https://$DOMAIN/enquiry
EOF
if [ -n "$ADMIN_PASSWORD" ]; then
  cat <<EOF
   Staff login    email:    $ADMIN_EMAIL
                  password: $ADMIN_PASSWORD
                  (temporary, shown only once: you choose your own at first sign-in)
EOF
else
  echo "   Staff login    unchanged. List or recover accounts: cd $APP_DIR && sudo -u $APP_USER npm run user:list"
fi
if [ -n "$DEMO_ACCOUNTS" ]; then
  printf '%s
' "$DEMO_ACCOUNTS"
fi
cat <<EOF

   Logs           journalctl -u nit-web -u nit-worker -f
   Update later   re-run this same command
--------------------------------------------------------------------------------
EOF
