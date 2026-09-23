from __future__ import annotations

import pytest

from app.services import cache as cache_module


@pytest.fixture(autouse=True)
def isolated_shared_cache(monkeypatch: pytest.MonkeyPatch):
    """Give every test a private, in-process shared cache.

    `get_shared_cache()` memoises one instance built from `settings.redis_url`.
    Under `make backend-test` that URL is unset and the dict fallback applies,
    but inside the backend container REDIS_URL points at the app's own Redis —
    so cached state survived both across tests and across whole pytest runs.
    Concretely, the cloud-eval negative cache (`cloudeval:miss:<fen>`) persisted,
    and a test asserting a fetch produced a miss would pass on a clean Redis and
    fail on every rerun, while also evicting the running app's warm caches.

    Forcing a fresh no-URL SharedCache per test makes the suite hermetic and
    repeatable wherever it runs, and keeps it off the real Redis.
    """
    monkeypatch.setattr(cache_module, "_shared_cache", cache_module.SharedCache(None))
    yield
    monkeypatch.setattr(cache_module, "_shared_cache", None)
