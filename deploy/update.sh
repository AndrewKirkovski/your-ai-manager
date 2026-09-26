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
# Never generate replacement database passwords or encryption keys here.
# Watchtower image updates do not need this manual configuration updater.
docker info >/dev/null

# Never switch an existing PostgreSQL data volume to a new major version
# without a dump and restore.
existing_db_id="$(docker ps -aq --filter 'name=^/luxmed-db$')"
existing_volumes="$(docker volume ls -q --filter 'label=com.docker.compose.volume=luxmed-postgres')"
if [ -n "$existing_db_id" ]; then
    # The actual on-disk major version is authoritative, not the image tag.
    db_major="$(docker exec "$existing_db_id" cat /var/lib/postgresql/data/PG_VERSION)"
    if [ "$db_major" != 16 ]; then
        echo "Existing database major version is $db_major. This script does not migrate database volumes."
        echo "Use the unattended image update or perform a separate backed-up database migration."
        exit 2
    fi
elif [ -n "$existing_volumes" ] || docker volume inspect luxmed-postgres >/dev/null 2>&1; then
    echo "Found an existing LuxMed volume without its container. Manual inspection is required."
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
docker compose up -d --wait --wait-timeout 180
docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' | grep -E '^(ai-manager-bot|luxmed-sidecar|luxmed-db|watchtower)\|' || true

echo "Deployment updated. Check sidecar logs with: docker compose logs --tail 100 luxmed-sidecar"
