.PHONY: help run up down logs build test backend-test frontend-test frontend-build theory-sync

help:
	@printf "ChessGod commands:\n"
	@printf "  make run           Start the full stack with Docker Compose\n"
	@printf "  make down          Stop the Docker Compose stack\n"
	@printf "  make logs          Tail service logs\n"
	@printf "  make build         Build Docker images\n"
	@printf "  make test          Run backend and frontend tests\n"
	@printf "  make backend-test  Run backend pytest suite\n"
	@printf "  make frontend-test Run frontend Vitest suite\n"
	@printf "  make frontend-build Build the frontend production bundle\n"
	@printf "  make theory-sync   Seed openings and refresh persisted master theory data\n"

run:
	docker compose up --build

up: run

down:
	docker compose down

logs:
	docker compose logs -f

build:
	docker compose build

test: backend-test frontend-test

backend-test:
	cd backend && .venv/bin/pytest

frontend-test:
	cd frontend && pnpm test

frontend-build:
	cd frontend && pnpm build

theory-sync:
	cd backend && .venv/bin/python ../scripts/seed_eco.py --force-sync
