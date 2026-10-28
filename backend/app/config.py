from __future__ import annotations

import json
import hashlib
from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://chessgod:chessgod@localhost:15432/chessgod"
    db_pool_size: int = Field(default=10, ge=1)
    db_max_overflow: int = Field(default=20, ge=0)
    db_pool_recycle_seconds: int = Field(default=1800, ge=60)
    cors_origins: list[str] = ["http://localhost:15173"]
    # Politeness delay between serial chess.com requests. The client retries 429s
    # with exponential backoff, so a small delay is enough; 0.5s added ~70s of
    # pure sleep for accounts with 100+ monthly archives.
    chesscom_request_delay: float = Field(default=0.25, ge=0.0)
    lichess_cache_ttl_days: int = 30
    # TTL for a position fetched and found to have zero master games. 86% of
    # fetched positions are past master play entirely and will never gain games,
    # so re-asking them on the 30-day clock would spend the whole sync quota
    # re-confirming empty answers before any new position is reached.
    lichess_empty_ttl_days: int = Field(default=365, ge=1)
    lichess_explorer_url: str = "https://explorer.lichess.org"
    lichess_api_token: str | None = None
    # Lichess asks for one request at a time and, on a 429, a full minute before
    # resuming (https://lichess.org/page/api-tips). At 0.2s the explorer sync
    # made five requests a second and was rate-limited after about twenty of
    # them -- roughly 4.6 seconds of work bought a cooldown, so a run cached 23
    # positions and then stopped. One request a second is both what they ask for
    # and far more throughput, because it does not spend the run getting banned.
    lichess_request_delay: float = Field(default=3.0, ge=0.0)
    # Positions seen in one game found master games 1.2% of the time (164k
    # fetched), against 37.5% at two games and 67.6% at three; at 1 the backlog
    # of 2.4M one-off positions kept the sync running around the clock. A
    # one-off position is still fetched on demand when the board reaches it.
    lichess_sync_min_position_games: int = Field(default=2, ge=0)
    # Per-run cap on explorer fetches. Staleness is filtered in SQL, so capped
    # runs still walk the whole corpus over successive cycles; the cap keeps a
    # single run from loading an unbounded ORM result (millions of positions
    # here) and from spamming Lichess for hours.
    lichess_sync_max_positions_per_run: int | None = Field(default=1000, ge=1)
    # How often the maintenance loop wakes to seed/refresh master data. Short
    # enough that a run cut off by a rate-limit cooldown resumes the same day.
    lichess_sync_interval_hours: int = Field(default=6, ge=1)
    lichess_sync_cooldown_auth_minutes: int = Field(default=360, ge=1)
    # A full minute is what Lichess documents for a 429. Fifteen was not more
    # polite, just slower to recover: paired with the old request delay it meant
    # ~23 positions cached per quarter hour.
    lichess_sync_cooldown_rate_limit_seconds: int = Field(default=60, ge=1)
    observability_retention_days: int = Field(default=14, ge=1)
    observability_slow_request_ms: int = Field(default=500, ge=1)
    observability_slow_query_ms: int = Field(default=100, ge=1)
    observability_n_plus_one_threshold: int = Field(default=20, ge=1)
    observability_admin_passphrase_sha256: str = "3f665a20748df42949e495a1b363194e5c5ab24b12080232a8ec3263fcb2145e"
    tree_max_depth: int = 40
    # How long the backend keeps warming the expensive read caches after the
    # last request from a person. Ten minutes matches the crawler's own
    # CRAWL_IDLE_AFTER_MS, so the two agree on when the machine is unattended.
    # Set it very high to restore the old always-warm behaviour, at the cost
    # measured in `_cache_warmup_worker`.
    cache_warmup_idle_after_seconds: float = Field(default=600.0, ge=0)
    # New games are fetched on their own while somebody uses the app, at most
    # this often per player (services/auto_sync.py); 0 turns it off.
    auto_sync_interval_seconds: float = Field(default=3 * 3600.0, ge=0)
    # Shared response cache. When unset, caching falls back to a per-process
    # dict — fine for tests and single-worker dev, but set REDIS_URL when
    # running more than one uvicorn worker so all of them share one cache.
    redis_url: str | None = None
    # Legacy cloud-evaluation settings remain parseable for old deployments,
    # but the runtime intentionally accepts and serves browser Stockfish 19 only.
    lichess_cloud_eval_enabled: bool = False
    lichess_cloud_eval_url: str = "https://lichess.org/api/cloud-eval"
    # Accept evals at least this deep; matches the browser engine's depth target
    # (DEFAULT_DEPTH in engine-store.ts) so either source can satisfy coverage
    # checks. Keep the two in step: mistake detection differences a parent and
    # child eval, so mixing depths across sources shows up as phantom eval drops.
    # Lower this to trade eval quality for faster coverage growth.
    lichess_cloud_eval_min_depth: int = Field(default=30, ge=1)
    lichess_cloud_eval_timeout_seconds: float = Field(default=5.0, ge=0.5)
    lichess_cloud_eval_request_delay: float = Field(default=0.5, ge=0.0)
    lichess_cloud_eval_max_positions_per_run: int = Field(default=300, ge=1)
    lichess_cloud_eval_interval_minutes: int = Field(default=15, ge=1)
    # Cover complete games by default, including long endgames. Operators can
    # set a ceiling if needed; the per-run cap and request delay already bound
    # work while Lichess does the engine computation elsewhere.
    lichess_cloud_eval_max_ply: int | None = Field(default=None, ge=0)
    lichess_cloud_eval_min_user_rating: int = Field(default=1000, ge=100, le=4000)
    lichess_cloud_eval_min_games: int = Field(default=1, ge=1)
    lichess_cloud_eval_negative_ttl_hours: int = Field(default=24, ge=1)
    lichess_cloud_eval_rate_limit_cooldown_seconds: int = Field(default=900, ge=1)

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: Any) -> Any:
        if isinstance(value, str):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("observability_admin_passphrase_sha256", mode="before")
    @classmethod
    def hash_admin_passphrase_if_needed(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        trimmed = value.strip()
        if not trimmed:
            return ""
        if len(trimmed) == 64 and all(ch in "0123456789abcdef" for ch in trimmed.lower()):
            return trimmed.lower()
        return hashlib.sha256(trimmed.encode("utf-8")).hexdigest()


settings = Settings()
