# ChessGod

Chess analysis and repertoire explorer for Chess.com imports, opening-tree navigation, theory comparison, and browser-side engine analysis.

The primary workflow is now improvement training: ChessGod ranks mistakes from a
player's rapid and blitz games, groups them into concrete patterns, turns past
positions into board drills, and schedules missed positions for review. See the
[improvement plan](docs/IMPROVEMENT_PLAN.md) for the product rules, performance
budgets, and remaining phases.

## Structure

- `backend/`: FastAPI, SQLAlchemy, Alembic
- `frontend/`: React, Vite+, Zustand, chessground
- `docker-compose.yml`: local development stack

## Run

From the repo root:

```bash
make run
```

That starts PostgreSQL on host port `15432`, the FastAPI backend on `http://localhost:18000`, and the Vite frontend on `http://localhost:15173`. Set `POSTGRES_PORT`, `BACKEND_PORT`, or `FRONTEND_PORT` to override the host bindings.

## Development

1. Copy `.env.example` to `.env`.
2. Backend setup:
   ```bash
   cd backend
   python3 -m venv .venv
   .venv/bin/pip install -e .[dev]
   ```
3. Frontend setup:
   ```bash
   cd frontend
   vp install
   ```
4. Run the full stack with `make run`.

### Lichess API behavior

- The backend seeds local opening names from bundled ECO TSV files, then optionally refreshes master stats from the Lichess Opening Explorer.
- Explorer requests use `https://explorer.lichess.org` (configurable with `LICHESS_EXPLORER_URL`).
- The goal is to persist master stats for as many positions as possible; positions that already have a stored engine evaluation are synced first, since recurring-mistake detection needs both an eval and master stats for the same position.
- To avoid overloading third-party servers, master sync is throttled and scoped:
  - `LICHESS_REQUEST_DELAY` adds spacing between explorer requests.
  - `LICHESS_SYNC_MIN_POSITION_GAMES` skips low-signal positions.
  - `LICHESS_SYNC_MAX_POSITIONS_PER_RUN` caps requests per maintenance run (unset by default — each run keeps going until the corpus is covered or Lichess throttles it).
  - `LICHESS_SYNC_INTERVAL_HOURS` sets how often the maintenance loop runs (default 6), so a run cut short by a rate limit resumes the same day.
- If explorer responds with auth/rate-limit errors (`401/403/429`), the sync pass stops gracefully, persists a cooldown in the database, and skips future runs until the cooldown expires.
- Cooldown windows are configurable with `LICHESS_SYNC_COOLDOWN_AUTH_MINUTES` and `LICHESS_SYNC_COOLDOWN_RATE_LIMIT_SECONDS`.
- If you have a valid Lichess token for explorer access, set `LICHESS_API_TOKEN` to reduce unauthorized responses.

### External cloud-evaluation helper

- `backend/app/services/cloud_evals.py` contains an optional HTTP-only helper for
  looking up Lichess's cached evaluations. It is not scheduled by the current
  runtime and its `lichess-cloud` rows are never treated as trusted learning
  evidence.
- The improvement pipeline and analysis APIs accept only browser Stockfish 19
  rows (`engine=stockfish-19`, `engine_version=19`); cloud and legacy rows cannot
  suppress the Stockfish 19 queue.
- Browser batches contain 24 targets and rotate through available endgame,
  middlegame, and opening decisions while preserving recency inside each phase.
  The before/after positions are selected together so each completed pair can
  produce a measured decision loss.

### Observability admin panel

- The app now records backend request metrics and frontend telemetry events (errors, failed API requests, long tasks) with request-id correlation.
- Use the **Admin** tab in the right workspace panel to open observability.
- Access is protected by an admin passphrase sent in `X-Admin-Passphrase` to `GET /api/health/observability`.
- By default, the configured passphrase hash corresponds to `born a saint`.
- For production, set your own `OBSERVABILITY_ADMIN_PASSPHRASE_SHA256` to a SHA-256 hash of a different secret sentence.
- Event retention is controlled with `OBSERVABILITY_RETENTION_DAYS`.

## Testing

```bash
make test
```

Useful individual commands:

- `make backend-test`
- `make frontend-test`
- `make engine-test` — the headless Stockfish harness (`node --test`)
- `make frontend-check`
- `make frontend-build`
- `make down`

## Notes

- **Background analysis.** The original `analysis-worker` service ran native Stockfish beside Postgres and the API and was removed because it ate the host; its opt-in scope table (`analysis_requests`, migration 006) is dropped in migration 009. Background analysis came back on different terms as `scripts/engine/crawl.mjs`, which loads the *same* `sf_19` wasm build and pinned net the browser uses — so its evaluations satisfy the engine contract rather than being a second engine's opinion — and is built to yield rather than compete: one engine thread, `nice -n 19`, a rest between positions, and it stands down whenever load per core rises above `CRAWL_MAX_LOAD` (default 0.7). Start it with `make crawl USERNAME=name`, or as the opt-in compose service (`CRAWL_USERNAME=name docker compose --profile crawl up -d crawl`), which is additionally capped at one core and 512MB. It takes work from `/api/games/unanalyzed-fens` and uploads through `POST /api/analysis/evaluations`, so it shares the browser crawl's queue ordering and dedup. Browser Stockfish 19 remains the other trusted source.
- **`make system-audit USERNAME=name`** reports data integrity, training coverage, and where the stored evidence came from. Only rows matching the active engine contract can grade a decision; migration 018 moved everything else into `cloud_evaluations` and `legacy_analysis_results` and a CHECK constraint keeps `analysis_results` clean.
- Stockfish assets are generated from `@lichess-org/stockfish-web` and expected at `frontend/public/stockfish/sf_19.js`, `frontend/public/stockfish/sf_19.wasm`, plus the pinned `nn-1a298aa575a0.nnue` file.
- `make run` starts the frontend container with a startup step that copies missing Stockfish assets into `frontend/public/stockfish/` before Vite+ starts.
- The root `Makefile` is the intended command surface for local development.
- Expensive read paths (recurring mistakes, repertoire tree, family stats, analysis coverage, cloud-eval negative cache) are cached in **Redis** (`redis` compose service, `REDIS_URL` env). The cache is shared across workers and survives backend restarts; when `REDIS_URL` is unset the backend falls back to a per-process dict. A background warmup task refreshes these caches every ~50s for imported usernames so users never hit the cold path.
- Imported Chess.com monthly archives are cached in the database via `import_archives`, so rerunning an import reuses already-fetched months instead of pulling them again.
- If you need to bypass the cache, call `POST /api/import/{username}?force=true`.
