#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-$HOME/ai-manager-bot}"
COMPOSE_URL="${COMPOSE_URL:-https://raw.githubusercontent.com/AndrewKirkovski/your-ai-manager/main/docker-compose.yml}"

cd "$PROJECT_DIR"

command -v docker >/dev/null 2>&1 || {
    echo "Docker is required."
    exit 1
}
docker compose version >/dev/null 2>&1 || {
    echo "Docker Compose is required."
    exit 1
}
test -f .env || {
    echo "Missing $PROJECT_DIR/.env. Run deploy/setup.sh first."
    exit 1
}
command -v openssl >/dev/null 2>&1 || {
    echo "OpenSSL is required to create missing deployment secrets."
    exit 1
}

ensure_secret() {
    local name="$1"
    if ! grep -qE "^${name}=" .env; then
        printf '%s=%s\n' "$name" "$(openssl rand -hex 32)" >> .env
        echo "Added ${name} to .env."
    fi
}

ensure_secret LUXMED_SIDECAR_SECRET
ensure_secret LUXMED_SECURITY_SECRET
ensure_secret LUXMED_WEBHOOK_SECRET
ensure_secret LUXMED_DB_PASSWORD

# Never switch an existing PostgreSQL data volume to a new major version
# without a dump and restore.
existing_db_image="$(docker inspect --format '{{.Config.Image}}' luxmed-db 2>/dev/null || true)"
case "$existing_db_image" in
    postgres:10*|postgres:11*|postgres:12*|postgres:13*|postgres:14*|postgres:15*)
        echo "Found $existing_db_image for luxmed-db. Export and restore the database before using postgres:16."
        exit 2
        ;;
esac

if [ -z "$existing_db_image" ] && docker volume inspect luxmed-postgres >/dev/null 2>&1; then
    echo "Found an existing luxmed-postgres volume without a running container."
    echo "Inspect and migrate it before using postgres:16."
    exit 2
fi

compose_tmp="$(mktemp docker-compose.yml.XXXXXX)"
backup_path="docker-compose.yml.backup.$(date -u +%Y%m%dT%H%M%SZ)"
cleanup() {
    rm -f "$compose_tmp"
}
trap cleanup EXIT

curl -fsSL "$COMPOSE_URL" -o "$compose_tmp"
docker compose --env-file .env -f "$compose_tmp" config -q

if [ -f docker-compose.yml ]; then
    cp -p docker-compose.yml "$backup_path"
    echo "Backed up the previous Compose file to $backup_path."
fi
mv "$compose_tmp" docker-compose.yml
trap - EXIT

docker compose pull
docker compose up -d --remove-orphans
docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' | grep -E '^(ai-manager-bot|luxmed-sidecar|luxmed-db|watchtower)\|' || true

echo "Deployment updated. Check sidecar logs with: docker compose logs --tail 100 luxmed-sidecar"
