# Repository Guidelines

## Project Structure & Module Organization
`backend/` holds the FastAPI service, SQLAlchemy models, Alembic migrations, and pytest suites. Keep API entrypoints in `backend/app/routers/`, domain logic in `backend/app/services/`, schemas in `backend/app/schemas/`, and utilities in `backend/app/utils/`. Tests live in `backend/tests/` as `test_*.py`.

`frontend/` contains the React + Vite app. Put route pages in `frontend/src/pages/`, reusable UI in `frontend/src/components/`, state in `frontend/src/store/`, hooks in `frontend/src/hooks/`, and helpers in `frontend/src/lib/`. Tests live in `frontend/tests/` and `frontend/src/**` as `*.test.ts`. Stockfish assets are served from `frontend/public/stockfish/`. Use the root `Makefile` as the main command surface.

## Build, Test, and Development Commands
Run the full stack with `make run`. This builds and starts PostgreSQL, the backend on `http://localhost:8000`, and the frontend on `http://localhost:5173`.

Use `make test` to run both suites, `make backend-test` for pytest, `make frontend-test` for Vitest, and `make frontend-build` to verify the bundle. Use `make down` to stop containers and `make logs` to inspect logs.

For local setup, copy `.env.example` to `.env`, create `backend/.venv`, install `backend` with `.[dev]`, then run `pnpm install` in `frontend/`.

## Coding Style & Naming Conventions
Follow the existing style in each package. Python uses 4-space indentation, type hints, snake_case modules, and focused service/router modules. TypeScript and TSX use 2-space indentation, single quotes, PascalCase for React components, kebab-case file names, and `use-*` naming for hooks.

No dedicated lint or formatter config is checked in, so keep imports tidy and match nearby files.

## Testing Guidelines
Backend tests use `pytest` and `fastapi.testclient`; frontend tests use `vitest` with `src/**/*.test.ts` and `tests/**/*.test.ts` from `frontend/vitest.config.ts`. Add tests with each change and prefer behavior-focused names such as `test_health_endpoint_returns_ok` or `returns ready when imported games exist`.

Coverage thresholds are not configured, but new API routes, parsing logic, store behavior, and engine helpers should ship with tests.

## Commit & Pull Request Guidelines
This repository currently has no commit history, so there is no convention to copy yet. Use short imperative commit subjects such as `Add theory comparison caching` and keep each commit scoped to one change.

PRs should include a concise summary, test evidence, linked issues when relevant, and screenshots or recordings for UI changes. Call out schema, env, or asset changes explicitly.

## Security & Configuration Tips
Do not commit secrets; keep values in `.env`. If you change Stockfish integration, verify the expected files remain under `frontend/public/stockfish/`. For backend data changes, include the Alembic migration and note any import-cache impact in the PR.
