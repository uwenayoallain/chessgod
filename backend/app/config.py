from __future__ import annotations

import json
import hashlib
from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://chessgod:chessgod@localhost:5432/chessgod"
    cors_origins: list[str] = ["http://localhost:5173"]
    chesscom_request_delay: float = 0.5
    lichess_cache_ttl_days: int = 30
    lichess_explorer_url: str = "https://explorer.lichess.org"
    lichess_api_token: str | None = None
    lichess_request_delay: float = Field(default=0.2, ge=0.0)
    lichess_sync_min_position_games: int = Field(default=1, ge=0)
    lichess_sync_max_positions_per_run: int | None = Field(default=100, ge=1)
    lichess_sync_cooldown_auth_minutes: int = Field(default=360, ge=1)
    lichess_sync_cooldown_rate_limit_seconds: int = Field(default=900, ge=1)
    observability_retention_days: int = Field(default=14, ge=1)
    observability_admin_passphrase_sha256: str = "3f665a20748df42949e495a1b363194e5c5ab24b12080232a8ec3263fcb2145e"
    tree_max_depth: int = 40

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
