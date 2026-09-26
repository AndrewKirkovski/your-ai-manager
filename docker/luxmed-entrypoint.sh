#!/bin/sh
set -eu

# Pre-September Compose passed only DB_HOST/DB_PORT. Its working sidecar used
# these database credentials internally. Retain that exact legacy layout for
# image-only updates; never replace an explicitly supplied password, even empty.
if [ "${DB_PASSWORD+x}" != x ] && [ "${DB_HOST:-}" = luxmed-db ] &&
   [ "${DB_PORT:-5432}" = 5432 ] && [ "${DB_USER+x}" != x ] &&
   [ "${DB_NAME+x}" != x ] && [ "${REST_SECRET+x}" != x ] &&
   [ -n "${SECURITY_SECRET:-}" ] && [ -n "${MONITORING_WEBHOOK_URL:-}" ]; then
    export DB_PASSWORD=lsb123
    echo "Using existing legacy database configuration for an image-only update."
fi

: "${DB_PASSWORD:?DB_PASSWORD is required outside the legacy Compose configuration}"
echo "Waiting for database on ${DB_HOST:-localhost}:${DB_PORT:-5432}..."
attempt=0
until nc -z "${DB_HOST:-localhost}" "${DB_PORT:-5432}"; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
        echo "Database connection timed out." >&2
        exit 1
    fi
    sleep 2
done
exec java -Xmx256m -jar /app/server.jar
