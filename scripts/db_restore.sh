#!/usr/bin/env bash
# Restore the ChessGod database from a dump made by scripts/db_backup.sh.
#
#   make db-restore                       from backups/chessgod.dump
#   make db-restore FILE=/media/usb/chessgod/chessgod.dump
#
# Replaces the whole database: the backend and crawler are stopped first, the
# database is dropped and recreated, the archive restored, and the services
# started again (the backend runs its migrations on start, so a dump from an
# older schema is brought forward). Asks before touching anything unless
# FORCE=1.
set -euo pipefail

cd "$(dirname "$0")/.."

file="${1:-${FILE:-}}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "db-restore: no dump at ${file:-backups/chessgod.dump}; pass one with FILE=" >&2
  exit 2
fi

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
POSTGRES_DB="${POSTGRES_DB:-chessgod}"
POSTGRES_USER="${POSTGRES_USER:-chessgod}"

compose() { docker compose --profile crawl "$@"; }

if [ "${FORCE:-}" != "1" ]; then
  printf 'This replaces the %s database with %s. Type yes to continue: ' "$POSTGRES_DB" "$file"
  read -r answer
  [ "$answer" = "yes" ] || { echo "db-restore: nothing done"; exit 1; }
fi

compose up -d postgres >/dev/null
compose stop backend crawl >/dev/null 2>&1 || true

pg=$(compose ps -q postgres)
# Clients still attached (a psql left open) would block the drop.
docker exec -i "$pg" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid();" >/dev/null
docker exec -i "$pg" dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"
docker exec -i "$pg" createdb -U "$POSTGRES_USER" "$POSTGRES_DB"
docker exec -i "$pg" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges < "$file"
echo "db-restore: restored $file into $POSTGRES_DB"

compose up -d backend >/dev/null
# Only bring the crawler back if it was part of the stack (its profile is opt-in).
if [ -n "${CRAWL_USERNAME:-}" ]; then compose up -d crawl >/dev/null 2>&1 || true; fi
echo "db-restore: services started"
