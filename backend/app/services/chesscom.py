from __future__ import annotations

import asyncio

import httpx

from app.config import settings


class ChessComClient:
    def __init__(self, http_client: httpx.AsyncClient):
        self.client = http_client
        self._semaphore = asyncio.Semaphore(1)

    async def _get(self, url: str) -> dict:
        async with self._semaphore:
            last_response: httpx.Response | None = None
            for attempt in range(3):
                response = await self.client.get(url)
                last_response = response
                if response.status_code == 429:
                    await asyncio.sleep(2**attempt)
                    continue
                response.raise_for_status()
                await asyncio.sleep(settings.chesscom_request_delay)
                return response.json()
            assert last_response is not None
            raise httpx.HTTPStatusError(
                "Rate limited after retries",
                request=last_response.request,
                response=last_response,
            )

    async def fetch_archives(self, username: str) -> list[str]:
        data = await self._get(f"https://api.chess.com/pub/player/{username}/games/archives")
        return data.get("archives", [])

    async def fetch_monthly_games(self, archive_url: str) -> list[dict]:
        data = await self._get(archive_url)
        return data.get("games", [])
