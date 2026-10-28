# AGENTS.md (OpenCode)

## Commands (Source Of Truth)
- Use the root `Makefile` as the command surface.
- `make run`: `docker compose up --build` (starts Postgres + backend + frontend).
- `make test`: runs both suites (`make backend-test` then `make frontend-test`).
- `make backend-test`: `cd backend && .venv/bin/pytest` (expects local venv).
- `make frontend-test`: `cd frontend && vp test` (Vite+ Vitest runner).
- `make frontend-check`: `cd frontend && vp check` (format + lint + type-check).
- `make frontend-build`: `cd frontend && vp build` (Vite+ production build).
- `make theory-sync`: seeds/syncs master opening data (`scripts/seed_eco.py --force-sync`).

## Runtime Wiring / Gotchas
- Docker backend runs `alembic upgrade head` on container start (`docker-compose.yml`), so DB schema changes must include an Alembic migration.
- Backend app entrypoint is `backend/app/main.py` (`uvicorn app.main:app`) and it starts a background task that periodically seeds/refreshes “master openings” data (every `LICHESS_SYNC_INTERVAL_HOURS`, positions with stored evaluations first).
- Trusted learning evaluations may come from browser Stockfish 19 or a background Node/Docker crawler using the same pinned Stockfish 19 WASM build and NNUE. Both must sync through `POST /api/analysis/evaluations` and follow the same depth, score-orientation, and validation contract. Background crawling is explicitly allowed; keep it resource-limited and responsive to host load. The crawler sizes its own engine pool every batch (`CRAWL_WORKERS_MIN`/`CRAWL_WORKERS_MAX`, `scripts/engine/pool.mjs`): it fills an idle machine and backs down to one engine, then none, as other work arrives. Changing `deploy.resources` in docker-compose.yml needs `make crawl-recreate` — `docker compose restart` reuses the old container and silently keeps the old cgroup limits. Do not introduce a different or native engine into the backend. The optional `backend/app/services/cloud_evals.py` helper is external context only and is not a running learning source.
- Frontend dev server requires cross-origin isolation for Stockfish (COOP/COEP headers are set in `frontend/vite.config.ts`).
- Frontend container runs `vp node scripts/sync-stockfish-assets.mjs` before `vp dev`; `frontend/package.json` also runs it on `postinstall`.
- Stockfish assets live in `frontend/public/stockfish/`.
- `sf_19.{js,wasm}` are copied from `node_modules/@lichess-org/stockfish-web` if missing.
- `sf_19` uses the pinned single NNUE file `nn-1a298aa575a0.nnue`, downloaded at install/startup unless `SKIP_STOCKFISH_NNUE_DOWNLOAD=1`.
- Net filenames are pinned in `frontend/scripts/sync-stockfish-assets.mjs` and must be updated together with the `@lichess-org/stockfish-web` version — the correct names per build target are in that package's README, and are also recoverable with `strings sf_19.wasm | grep nnue`.

## Import Cache Behavior
- Chess.com imports cache fetched monthly archives in the DB (see `backend/app/services/import_cache.py`).
- Default behavior re-fetches only the current + previous month; use `POST /api/import/{username}?force=true` to bypass the cache.

## Where To Look First
- Backend routers: `backend/app/routers/` (API surface is mounted under `/api` in `backend/app/main.py`).
- Backend migrations: `backend/alembic/` + `backend/alembic.ini` (reads `DATABASE_URL` from `.env` via `app.config`).
- Frontend app entry: `frontend/src/main.tsx`.
