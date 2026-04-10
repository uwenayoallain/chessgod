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
