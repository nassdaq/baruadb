#!/usr/bin/env bash
# Add a box to the BaruaDB cluster. Run as root on a fresh Ubuntu 24.04
# server (e.g. a Linode). The box joins the cluster by itself.
#
#   curl -fsSL https://raw.githubusercontent.com/nassdaq/workingdb/barua-db/deploy/install.sh -o install.sh
#   BARUA_JOIN_TOKEN=... \
#   BARUA_R2_ACCOUNT_ID=... BARUA_R2_ACCESS_KEY_ID=... BARUA_R2_SECRET_ACCESS_KEY=... \
#   CF_DNS_API_TOKEN=... \
#   bash install.sh
#
# Required:
#   BARUA_JOIN_TOKEN            the control plane's JOIN_TOKEN secret
#   BARUA_R2_ACCOUNT_ID, BARUA_R2_ACCESS_KEY_ID, BARUA_R2_SECRET_ACCESS_KEY
# DNS credentials for the wildcard certificate (DNS-01) — one of:
#   CF_DNS_API_TOKEN            Cloudflare token with Zone.DNS edit on barua.tz
#   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
#                               an IAM user limited to route53:ChangeResourceRecordSets
#                               on the hosted zone (never root keys)
# Optional:
#   BARUA_CONTROL_URL           default https://pgapi.barua.tz
#   BARUA_R2_BUCKET             default barua
#   BARUA_DOMAIN                default pg.barua.tz
#   BARUA_BOX_NAME              default: the hostname
#   BARUA_BINARY_URL            prebuilt barua binary; otherwise built from source
#   BARUA_GIT_REF               branch/tag to build from (default barua-db)
#   CERT_EMAIL                  Let's Encrypt account email
set -euo pipefail

need() { [[ -n "${!1:-}" ]] || { echo "missing $1" >&2; exit 1; }; }
need BARUA_JOIN_TOKEN
need BARUA_R2_ACCOUNT_ID
need BARUA_R2_ACCESS_KEY_ID
need BARUA_R2_SECRET_ACCESS_KEY
# The wildcard certificate is issued over DNS-01, so certbot needs write access
# to whichever provider is authoritative for $BARUA_DOMAIN.
if [[ -n "${CF_DNS_API_TOKEN:-}" ]]; then
  DNS_PROVIDER=cloudflare
elif [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  DNS_PROVIDER=route53
else
  echo "missing DNS credentials: set CF_DNS_API_TOKEN, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY" >&2
  exit 1
fi
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

CONTROL_URL=${BARUA_CONTROL_URL:-https://pgapi.barua.tz}
DOMAIN=${BARUA_DOMAIN:-pg.barua.tz}
BUCKET=${BARUA_R2_BUCKET:-baruadb}
BOX_NAME=${BARUA_BOX_NAME:-$(hostname -s)}
GIT_REF=${BARUA_GIT_REF:-barua-db}
PUBLIC_IP=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
echo "==> box $BOX_NAME ($PUBLIC_IP) joining $CONTROL_URL"

export DEBIAN_FRONTEND=noninteractive

echo "==> Postgres 16"
apt-get update -q
apt-get install -yq postgresql-common curl ca-certificates git build-essential pkg-config
# -y, not `yes |`: the script exits before draining the pipe, and SIGPIPE on
# `yes` would trip pipefail and abort the install.
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
apt-get install -yq postgresql-16
# The agent runs its own clusters; the distro default would sit on port 5432.
systemctl disable --now postgresql >/dev/null 2>&1 || true
pg_dropcluster --stop 16 main >/dev/null 2>&1 || true

echo "==> user and directories"
id barua >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/barua --shell /usr/sbin/nologin barua
install -d -o barua -g barua -m 700 /var/lib/barua
install -d -m 755 /etc/barua
install -d -o barua -g barua -m 750 /etc/barua/tls

echo "==> barua binary"
if [[ -n "${BARUA_BINARY_URL:-}" ]]; then
  curl -fsSL "$BARUA_BINARY_URL" -o /usr/local/bin/barua
else
  # Small boxes need swap to compile.
  if [[ $(free -m | awk '/Mem:/{print $2}') -lt 3000 && ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  fi
  [[ -x "$HOME/.cargo/bin/cargo" ]] || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
  rm -rf /tmp/barua-src
  git clone --depth 1 --branch "$GIT_REF" https://github.com/nassdaq/workingdb.git /tmp/barua-src
  (cd /tmp/barua-src/agent && "$HOME/.cargo/bin/cargo" build --release)
  install -m 755 /tmp/barua-src/agent/target/release/barua /usr/local/bin/barua
fi
chmod 755 /usr/local/bin/barua

echo "==> wildcard certificate for *.$DOMAIN (DNS-01 via $DNS_PROVIDER)"
if [[ $DNS_PROVIDER == cloudflare ]]; then
  apt-get install -yq certbot python3-certbot-dns-cloudflare
  umask 077
  printf 'dns_cloudflare_api_token = %s\n' "$CF_DNS_API_TOKEN" > /etc/barua/cloudflare.ini
  umask 022
  DNS_ARGS=(--dns-cloudflare --dns-cloudflare-credentials /etc/barua/cloudflare.ini
            --dns-cloudflare-propagation-seconds 30)
else
  apt-get install -yq certbot python3-certbot-dns-route53
  # Renewals run from a systemd timer with no environment, so the keys have to
  # be on disk. Use an IAM user limited to this zone, never root keys.
  install -d -m 700 /root/.aws
  umask 077
  cat > /root/.aws/credentials <<EOF
[default]
aws_access_key_id = $AWS_ACCESS_KEY_ID
aws_secret_access_key = $AWS_SECRET_ACCESS_KEY
EOF
  umask 022
  # route53 waits for the change to reach INSYNC, so no propagation flag.
  DNS_ARGS=(--dns-route53)
fi
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/barua.sh <<'HOOK'
#!/bin/sh
# Copy renewed certs where the agent (user barua) can read them, then
# restart it. Databases keep running across agent restarts.
install -o barua -g barua -m 640 "$RENEWED_LINEAGE/fullchain.pem" /etc/barua/tls/fullchain.pem
install -o barua -g barua -m 640 "$RENEWED_LINEAGE/privkey.pem" /etc/barua/tls/privkey.pem
# On a first install this hook runs before the unit exists; try-restart then
# exits 5 and would abort the install.
systemctl try-restart barua 2>/dev/null || true
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/barua.sh
# A box-specific extra name keeps each box's certificate distinct, so Let's
# Encrypt's duplicate-certificate limit (5 per week per identical name set)
# never blocks adding boxes. It sits one level deeper than the wildcard:
# *.pg.barua.tz already covers node-<box>.pg.barua.tz, and Let's Encrypt
# rejects an order whose names are redundant with its own wildcard.
if [[ -n "${CERT_EMAIL:-}" ]]; then ACCOUNT=(-m "$CERT_EMAIL"); else ACCOUNT=(--register-unsafely-without-email); fi
certbot certonly -n --agree-tos "${ACCOUNT[@]}" "${DNS_ARGS[@]}" \
  --cert-name barua -d "*.$DOMAIN" -d "$BOX_NAME.node.$DOMAIN"
RENEWED_LINEAGE=/etc/letsencrypt/live/barua /etc/letsencrypt/renewal-hooks/deploy/barua.sh

echo "==> configuration"
if [[ ! -f /etc/barua/barua.env ]]; then
  umask 077
  cat > /etc/barua/barua.env <<EOF
BARUA_CONTROL_URL=$CONTROL_URL
BARUA_JOIN_TOKEN=$BARUA_JOIN_TOKEN
BARUA_PUBLIC_IP=$PUBLIC_IP
BARUA_BOX_NAME=$BOX_NAME
BARUA_DOMAIN=$DOMAIN
BARUA_R2_ACCOUNT_ID=$BARUA_R2_ACCOUNT_ID
BARUA_R2_BUCKET=$BUCKET
BARUA_R2_ACCESS_KEY_ID=$BARUA_R2_ACCESS_KEY_ID
BARUA_R2_SECRET_ACCESS_KEY=$BARUA_R2_SECRET_ACCESS_KEY
BARUA_TLS_CERT=/etc/barua/tls/fullchain.pem
BARUA_TLS_KEY=/etc/barua/tls/privkey.pem
BARUA_DATA=/var/lib/barua
BARUA_PG_BIN=/usr/lib/postgresql/16/bin
EOF
  umask 022
fi

echo "==> firewall"
if command -v ufw >/dev/null; then
  ufw allow 22/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 5432/tcp >/dev/null
fi

echo "==> service"
curl -fsSL "https://raw.githubusercontent.com/nassdaq/workingdb/$GIT_REF/deploy/barua.service" -o /etc/systemd/system/barua.service \
  || cp "$(dirname "$0")/barua.service" /etc/systemd/system/barua.service
systemctl daemon-reload
systemctl enable --now barua

for _ in $(seq 1 30); do
  [[ -f /var/lib/barua/identity.json ]] && break
  sleep 2
done
if [[ -f /var/lib/barua/identity.json ]]; then
  echo "==> joined: $(grep -o '"box_id": *"[^"]*"' /var/lib/barua/identity.json)"
else
  echo "!! not joined yet; check: journalctl -u barua -n 50" >&2
  exit 1
fi
