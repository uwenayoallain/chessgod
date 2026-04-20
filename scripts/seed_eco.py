from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

import httpx


ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import async_session_factory  # noqa: E402
from app.config import settings  # noqa: E402
from app.services.master_openings import seed_opening_book, sync_stale_master_data  # noqa: E402
from app.services.theory import LichessExplorerClient  # noqa: E402


async def run(force_sync: bool) -> None:
    async with httpx.AsyncClient(
        headers={"User-Agent": "ChessGod/0.1"},
        timeout=30.0,
        limits=httpx.Limits(max_connections=10),
    ) as http_client:
        async with async_session_factory() as session:
            seeded = await seed_opening_book(session)
            await session.commit()
            refreshed = await sync_stale_master_data(
                session,
                LichessExplorerClient(http_client),
                force=force_sync,
                min_position_games=settings.lichess_sync_min_position_games,
                max_positions=settings.lichess_sync_max_positions_per_run,
            )
            await session.commit()

    mode = "forced" if force_sync else "stale-only"
    print(f"Seeded {seeded} opening lines and refreshed {refreshed} positions ({mode}).")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed local opening data and refresh persisted master stats.")
    parser.add_argument(
        "--force-sync",
        action="store_true",
        help="Refresh every persisted master position instead of only stale ones.",
    )
    args = parser.parse_args()
    asyncio.run(run(force_sync=args.force_sync))


if __name__ == "__main__":
    main()
