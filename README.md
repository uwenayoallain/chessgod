# ChessGod

Chess analysis and repertoire explorer for Chess.com imports, opening-tree navigation, theory comparison, and browser-side engine analysis.

## Structure

- `backend/`: FastAPI, SQLAlchemy, Alembic
- `frontend/`: React, Vite, Zustand, chessground
- `docker-compose.yml`: local development stack

## Run

From the repo root:

```bash
make run
```

That starts PostgreSQL, the FastAPI backend on `http://localhost:8000`, and the Vite frontend on `http://localhost:5173`.

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
   pnpm install
   ```
4. Run the full stack with `make run`.

### Lichess API behavior

- The backend seeds local opening names from bundled ECO TSV files, then optionally refreshes master stats from the Lichess Opening Explorer.
- Explorer requests use `https://explorer.lichess.org` (configurable with `LICHESS_EXPLORER_URL`).
- To avoid overloading third-party servers, master sync is throttled and scoped:
  - `LICHESS_REQUEST_DELAY` adds spacing between explorer requests.
  - `LICHESS_SYNC_MIN_POSITION_GAMES` skips low-signal positions.
  - `LICHESS_SYNC_MAX_POSITIONS_PER_RUN` caps requests per maintenance run.
- If explorer responds with auth/rate-limit errors (`401/403/429`), the sync pass stops gracefully, persists a cooldown in the database, and skips future runs until the cooldown expires.
- Cooldown windows are configurable with `LICHESS_SYNC_COOLDOWN_AUTH_MINUTES` and `LICHESS_SYNC_COOLDOWN_RATE_LIMIT_SECONDS`.
- If you have a valid Lichess token for explorer access, set `LICHESS_API_TOKEN` to reduce unauthorized responses.

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
- `make frontend-build`
- `make down`

## Notes

- Stockfish assets are generated from `@lichess-org/stockfish-web` and expected at `frontend/public/stockfish/sf_18_smallnet.js`, `frontend/public/stockfish/sf_18_smallnet.wasm`, and `frontend/public/stockfish/nn-4ca89e4b3abf.nnue`.
- `make run` starts the frontend container with a startup step that copies missing Stockfish assets into `frontend/public/stockfish/` before Vite starts.
- The root `Makefile` is the intended command surface for local development.
- Imported Chess.com monthly archives are cached in the database via `import_archives`, so rerunning an import reuses already-fetched months instead of pulling them again.
- If you need to bypass the cache, call `POST /api/import/{username}?force=true`.
