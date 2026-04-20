# AGENTS.md (OpenCode)

## Commands (Source Of Truth)
- Use the root `Makefile` as the command surface.
- `make run`: `docker compose up --build` (starts Postgres + backend + frontend).
- `make test`: runs both suites (`make backend-test` then `make frontend-test`).
- `make backend-test`: `cd backend && .venv/bin/pytest` (expects local venv).
- `make frontend-test`: `cd frontend && pnpm test` (Vitest).
- `make frontend-build`: `cd frontend && pnpm build` (runs `tsc -b` first).
- `make theory-sync`: seeds/syncs master opening data (`scripts/seed_eco.py --force-sync`).

## Runtime Wiring / Gotchas
- Docker backend runs `alembic upgrade head` on container start (`docker-compose.yml`), so DB schema changes must include an Alembic migration.
- Backend app entrypoint is `backend/app/main.py` (`uvicorn app.main:app`) and it starts a background task that periodically seeds/refreshes “master openings” data.
- Frontend dev server requires cross-origin isolation for Stockfish (COOP/COEP headers are set in `frontend/vite.config.ts`).
- Frontend container runs `node scripts/sync-stockfish-assets.mjs` before `pnpm dev`; `frontend/package.json` also runs it on `postinstall`.
- Stockfish assets live in `frontend/public/stockfish/`.
- `sf_18_smallnet.{js,wasm}` are copied from `node_modules/@lichess-org/stockfish-web` if missing.
- `nn-4ca89e4b3abf.nnue` is downloaded at install/startup unless `SKIP_STOCKFISH_NNUE_DOWNLOAD=1`.

## Import Cache Behavior
- Chess.com imports cache fetched monthly archives in the DB (see `backend/app/services/import_cache.py`).
- Default behavior re-fetches only the current + previous month; use `POST /api/import/{username}?force=true` to bypass the cache.

## Where To Look First
- Backend routers: `backend/app/routers/` (API surface is mounted under `/api` in `backend/app/main.py`).
- Backend migrations: `backend/alembic/` + `backend/alembic.ini` (reads `DATABASE_URL` from `.env` via `app.config`).
- Frontend app entry: `frontend/src/main.tsx`.
