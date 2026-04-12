from __future__ import annotations

import json
from typing import Any

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://chessgod:chessgod@localhost:5432/chessgod"
    cors_origins: list[str] = ["http://localhost:5173"]
    chesscom_request_delay: float = 0.5
    lichess_cache_ttl_days: int = 30
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


settings = Settings()
