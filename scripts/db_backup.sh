#!/usr/bin/env bash
# Keep one up-to-date copy of the ChessGod database in backups/chessgod.dump.
#
# The library (games, positions, days of engine evaluations) and the training
# progress (every XP event, line memory, engine games) live in one Postgres
# volume on this laptop, and nothing else held a copy. This writes a pg_dump
# custom-format archive (compressed, restorable table by table) through the
# running postgres container — but only when something has changed since the
# last dump, and always to the same file: a dump cannot be appended to, so the
# whole archive is rewritten and swapped in atomically, which leaves exactly one
# current backup rather than a pile of dated ones.
#
#   make db-backup                      dump now if anything changed
#   FORCE=1 make db-backup              dump regardless
#   BACKUP_COPY_DIR=/media/usb/chessgod make db-backup
#                                       also keep the copy somewhere off this disk
#
# Exit status is non-zero on any failure, so the systemd timer records it.
set -euo pipefail

cd "$(dirname "$0")/.."

# .env is the compose file's own source of these; defaults match compose.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
POSTGRES_DB="${POSTGRES_DB:-chessgod}"
POSTGRES_USER="${POSTGRES_USER:-chessgod}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_COPY_DIR="${BACKUP_COPY_DIR:-}"

compose() { docker compose "$@"; }

if ! compose ps --status running postgres 2>/dev/null | grep -q postgres; then
  echo "db-backup: the postgres container is not running (make run first)" >&2
  exit 1
fi
pg=$(compose ps -q postgres)

mkdir -p "$BACKUP_DIR"
# One run at a time: the timer and a hand-run `make db-backup` share the
# temp file, and two dumps at once leave one of them with nothing to move.
exec 9> "$BACKUP_DIR/.lock"
if ! flock -n 9; then
  echo "db-backup: another backup is already running"
  exit 0
fi
target="$BACKUP_DIR/chessgod.dump"
part="$target.part"
mark="$target.state"

# What the player's data amounts to: games imported, training events, engine
# evaluations stored, line memory reviewed, engine games and repertoire marks.
# Equal to the value saved with the last dump means nothing was added, so
# there is nothing to back up. (The master-theory sync rewrites position stats
# around the clock; that is a cache and does not count.)
state=$(docker exec -i "$pg" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
  SELECT concat_ws('/',
    (SELECT count(*) FROM games),
    (SELECT coalesce(max(id), 0) FROM training_events),
    (SELECT count(*) FROM analysis_results),
    (SELECT count(*) || ':' || coalesce(max(last_reviewed_at)::text, '') FROM line_move_progress),
    (SELECT count(*) FROM sparring_games),
    (SELECT count(*) FROM repertoire_marks))")
if [ "${FORCE:-}" != "1" ] && [ -f "$target" ] && [ -f "$mark" ] && [ "$(cat "$mark")" = "$state" ]; then
  echo "db-backup: nothing new since $(date -r "$target" '+%Y-%m-%d %H:%M'); $target is current"
  exit 0
fi

started=$(date +%s)
# -T: no TTY, so the archive bytes come through stdout untouched.
compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc --no-owner --no-privileges "$POSTGRES_DB" > "$part"

# A dump that pg_restore cannot list is not a backup; the old one stays.
if ! docker exec -i "$pg" pg_restore --list < "$part" > /dev/null; then
  rm -f "$part"
  echo "db-backup: the archive did not verify; the previous backup is untouched" >&2
  exit 1
fi
mv "$part" "$target"
printf '%s' "$state" > "$mark"

size=$(du -h "$target" | cut -f1)
seconds=$(( $(date +%s) - started ))
echo "db-backup: $target updated ($size, ${seconds}s)"

if [ -n "$BACKUP_COPY_DIR" ]; then
  if mkdir -p "$BACKUP_COPY_DIR" 2>/dev/null && cp "$target" "$BACKUP_COPY_DIR/chessgod.dump.part" \
     && mv "$BACKUP_COPY_DIR/chessgod.dump.part" "$BACKUP_COPY_DIR/chessgod.dump"; then
    echo "db-backup: copied to $BACKUP_COPY_DIR/chessgod.dump"
  else
    echo "db-backup: could not copy to $BACKUP_COPY_DIR (is the drive mounted?)" >&2
    exit 1
  fi
fi
