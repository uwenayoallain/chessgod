from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class FrontendTelemetryEventIn(BaseModel):
    kind: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=128)
    severity: Literal["debug", "info", "warn", "error"] = "info"
    request_id: str | None = Field(default=None, max_length=128)
    message: str | None = Field(default=None, max_length=1000)
    stack: str | None = Field(default=None, max_length=4000)
    url: str | None = Field(default=None, max_length=2048)
    duration_ms: float | None = Field(default=None, ge=0)
    status_code: int | None = Field(default=None, ge=100, le=599)
    created_at: str | None = Field(default=None, max_length=64)
    meta: dict[str, Any] | None = None


class FrontendTelemetryIngestRequest(BaseModel):
    events: list[FrontendTelemetryEventIn] = Field(default_factory=list, max_length=100)


class FrontendTelemetryIngestResponse(BaseModel):
    accepted: int


class ObservabilitySnapshot(BaseModel):
    request_id: str
    generated_at: str
    runtime: dict[str, Any]
    persistent: dict[str, Any]
