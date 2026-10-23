.PHONY: help run up tunnel tunnel-down tunnel-logs down logs build test db-backup db-restore db-backup-schedule db-backup-unschedule offline-page backend-test frontend-test frontend-check frontend-format frontend-build theory-sync clock-backfill ranking-eval system-audit triage-measure crawl engine-test repertoire-engine smoke

help:
	@printf "ChessGod commands:\n"
	@printf "  make run           Start the full stack with Docker Compose\n"
	@printf "  make start-local   Start installed local services without building or pulling images\n"
	@printf "  make crawl-restart Restart the existing crawler with current local code\n"
	@printf "  make crawl-recreate Recreate the crawler so changed CPU/memory limits apply\n"
	@printf "  make backend-restart Restart the existing backend without building or pulling images\n"
	@printf "  make tunnel        Start the stack plus Cloudflare Tunnel for chess.uwe.rw\n"
	@printf "  make tunnel-down   Stop the tunnel stack\n"
	@printf "  make tunnel-logs   Tail tunnel stack logs\n"
	@printf "  make offline-page  Deploy the page chess.uwe.rw shows while the tunnel is down\n"
	@printf "  make db-backup     Refresh backups/chessgod.dump if the database changed\n"
	@printf "  make db-restore    Replace the database with backups/chessgod.dump\n"
	@printf "  make db-backup-schedule  Install the daily 04:30 backup timer (systemd --user)\n"
	@printf "  make down          Stop the Docker Compose stack\n"
	@printf "  make logs          Tail service logs\n"
	@printf "  make build         Build Docker images\n"
	@printf "  make test          Run backend, frontend, and engine-harness tests\n"
	@printf "  make backend-test  Run backend pytest suite\n"
	@printf "  make frontend-test Run frontend Vite+ test suite\n"
	@printf "  make frontend-check Run frontend Vite+ format, lint, and type checks\n"
	@printf "  make frontend-build Build the frontend production bundle\n"
	@printf "  make theory-sync   Seed openings and refresh persisted master theory data\n"
	@printf "  make clock-backfill USERNAME=name  Backfill rapid/blitz move clocks from stored PGNs\n"
	@printf "  make ranking-eval USERNAME=name    Score the drill ranking on time-ordered holdout games\n"
	@printf "  make smoke USERNAME=name           Hit every workspace endpoint on the running stack\n"
	@printf "  make system-audit USERNAME=name    Audit stored evidence and training latency without changing data\n"
	@printf "  make triage-measure SAMPLE=path.json  Measure whether a shallow search predicts a deep one\n"
	@printf "  make crawl USERNAME=name           Background-analyse the library, yielding whenever the machine is busy\n"
	@printf "  make outcome-backfill USERNAME=name  Record checkmate/stalemate facts from imported final boards\n"

run:
	docker compose up --build $(RUN_ARGS)

up: run

.PHONY: start-local
start-local:
	docker compose up -d --no-build --pull never

# Restarts the *process* only. Docker reuses the existing container, so a
# changed cpus/memory limit in docker-compose.yml is NOT applied -- the crawler
# ran a 3-engine pool inside a stale 2.0-core cap for a whole crawl this way,
# throttled in 77% of scheduling periods. Code changes are picked up, because
# ./scripts is a bind mount. For anything under `deploy.resources`, use
# crawl-recreate.
.PHONY: crawl-restart
crawl-restart:
	docker compose restart crawl

# Recreates the container so resource limits in docker-compose.yml take effect.
.PHONY: crawl-recreate
crawl-recreate:
	docker compose up -d --no-build --force-recreate crawl

.PHONY: backend-restart
backend-restart:
	docker compose restart backend

# Both env files: `--env-file` replaces `.env` rather than adding to it, so
# naming only .env.tunnel dropped LICHESS_API_TOKEN and CRAWL_USERNAME and the
# public stack ran with master theory blocked. The later file wins on overlap.
TUNNEL_COMPOSE = docker compose --env-file .env --env-file .env.tunnel -f docker-compose.yml -f docker-compose.tunnel.yml

tunnel:
	$(TUNNEL_COMPOSE) up --build

tunnel-down:
	$(TUNNEL_COMPOSE) --profile crawl down

tunnel-logs:
	$(TUNNEL_COMPOSE) logs -f

# `--profile crawl` on purpose: without it, `down` leaves the opt-in crawler
# running against a backend that is no longer there. It did exactly that for 35
# hours -- a container in Up state, a log line every 35 seconds, and no work
# done since the moment the stack stopped. A stack stop must take the crawler
# with it; naming a profile that is not running is a no-op, so this is safe
# whether or not anyone is crawling.
down:
	docker compose --profile crawl down

logs:
	docker compose logs -f

build:
	docker compose build

test: backend-test frontend-test engine-test

backend-test:
	cd backend && .venv/bin/pytest

frontend-test:
	cd frontend && vp test

# The harness that drives Stockfish outside the browser. Only *.test.mjs --
# the other files in that folder start an engine when executed.
engine-test:
	node --test "$(or $(ENGINE_TEST_FILES),scripts/engine/*.test.mjs)"

frontend-check:
	cd frontend && vp check

frontend-format:
	cd frontend && vp check --fix

frontend-build:
	cd frontend && vp build

theory-sync:
	cd backend && .venv/bin/alembic upgrade head && .venv/bin/python ../scripts/seed_eco.py --force-sync

clock-backfill:
	test -n "$(USERNAME)" -a "$(origin USERNAME)" != environment || (printf "USERNAME is required (make $@ USERNAME=name)\n" && exit 2)
	cd backend && .venv/bin/alembic upgrade head && .venv/bin/python ../scripts/backfill_clocks.py "$(USERNAME)"

ranking-eval:
	test -n "$(USERNAME)" -a "$(origin USERNAME)" != environment || (printf "USERNAME is required (make $@ USERNAME=name)\n" && exit 2)
	cd backend && .venv/bin/python ../scripts/evaluate_ranking.py "$(USERNAME)"

.PHONY: outcome-backfill
outcome-backfill:
	test -n "$(USERNAME)" -a "$(origin USERNAME)" != environment || (printf "USERNAME is required (make $@ USERNAME=name)\n" && exit 2)
	cd backend && .venv/bin/alembic upgrade head && .venv/bin/python ../scripts/backfill_outcomes.py "$(USERNAME)"

smoke:
	test -n "$(USERNAME)" -a "$(origin USERNAME)" != environment || (printf "USERNAME is required (make $@ USERNAME=name)\n" && exit 2)
	python3 scripts/smoke.py "$(USERNAME)"

system-audit:
	test -n "$(USERNAME)" -a "$(origin USERNAME)" != environment || (printf "USERNAME is required (make $@ USERNAME=name)\n" && exit 2)
	cd backend && .venv/bin/python ../scripts/audit_system.py "$(USERNAME)"

# Offline measurement only. This drives the same Stockfish 19 build the browser
# runs, from Node, so an experiment measures the engine whose numbers actually
# get stored. It is not a background analysis loop and must not become one --
# the host has no CPU budget for crawling the library server-side.
triage-measure:
	test -n "$(SAMPLE)" || (printf "SAMPLE=path/to/sample.json is required\n" && exit 2)
	node scripts/engine/measure_triage.mjs "$(SAMPLE)" $(SHALLOW) $(DEEP)

# Niced to the back of the queue, one thread per engine, and the pool sizes
# itself every batch to whatever is left of the CRAWL_MAX_LOAD budget after
# other work: it fills an idle machine and backs down to a single engine (then
# to none) as the machine gets busy. Tune with CRAWL_WORKERS_MIN /
# CRAWL_WORKERS_MAX / CRAWL_MAX_LOAD / CRAWL_REST_MS / CRAWL_BATCH.
# Searches a player's repertoire positions with MultiPV (a one-off job, nice 19).
repertoire-engine:
	test -n "$(USERNAME)" -a "$(origin USERNAME)" != environment || (printf "USERNAME is required (make $@ USERNAME=name)\n" && exit 2)
	USERNAME="$(USERNAME)" COLORS="$(or $(COLORS),black,white)" nice -n 19 node scripts/engine/repertoire.mjs

crawl:
	test -n "$(USERNAME)" -a "$(origin USERNAME)" != environment || (printf "USERNAME is required (make $@ USERNAME=name)\n" && exit 2)
	CRAWL_USERNAME="$(USERNAME)" nice -n 19 node scripts/engine/crawl.mjs

# --- Backups ----------------------------------------------------------------
# The library and every bit of training progress live in one Postgres volume
# on this laptop. backups/chessgod.dump (ignored by git) is the one copy,
# rewritten only when the database changed; set BACKUP_COPY_DIR in .env to an
# external or synced folder to keep it off this disk as well.
db-backup:
	./scripts/db_backup.sh

db-restore:
	FILE="$(or $(FILE),backups/chessgod.dump)" ./scripts/db_restore.sh

SYSTEMD_USER_DIR = $(HOME)/.config/systemd/user

db-backup-schedule:
	mkdir -p $(SYSTEMD_USER_DIR)
	cp scripts/systemd/chessgod-backup.service scripts/systemd/chessgod-backup.timer $(SYSTEMD_USER_DIR)/
	systemctl --user daemon-reload
	systemctl --user enable --now chessgod-backup.timer
	systemctl --user list-timers chessgod-backup.timer --no-pager

db-backup-unschedule:
	systemctl --user disable --now chessgod-backup.timer || true
	rm -f $(SYSTEMD_USER_DIR)/chessgod-backup.service $(SYSTEMD_USER_DIR)/chessgod-backup.timer
	systemctl --user daemon-reload

# The page Cloudflare serves for chess.uwe.rw while the tunnel is down: a
# Worker in front of the hostname (custom error pages need a paid plan).
offline-page:
	python3 scripts/cloudflare/deploy_offline_page.py
