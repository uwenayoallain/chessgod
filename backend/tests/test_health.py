from fastapi.testclient import TestClient

from app.main import app
from app.services.observability import get_observability_store


ADMIN_PASSPHRASE = "born a saint"


def test_health_endpoint_returns_ok() -> None:
    get_observability_store()
    client = TestClient(app)

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_observability_endpoint_reports_backend_request_metrics() -> None:
    client = TestClient(app)

    client.get("/api/health")
    response = client.get("/api/health/observability", headers={"X-Admin-Passphrase": ADMIN_PASSPHRASE})

    assert response.status_code == 200
    payload = response.json()
    assert payload["runtime"]["backend"]["total_requests"] >= 1
    assert isinstance(payload["runtime"]["backend"]["routes"], list)
    assert payload["request_id"]
    assert "total_events" in payload["persistent"]


def test_observability_endpoint_rejects_invalid_passphrase() -> None:
    client = TestClient(app)

    response = client.get("/api/health/observability", headers={"X-Admin-Passphrase": "wrong"})

    assert response.status_code == 401


def test_health_telemetry_ingest_adds_frontend_events() -> None:
    client = TestClient(app)

    ingest = client.post(
        "/api/health/telemetry",
        json={
            "events": [
                {
                    "kind": "error",
                    "name": "unhandledrejection",
                    "severity": "error",
                    "message": "frontend failure",
                }
            ]
        },
    )
    assert ingest.status_code == 202
    assert ingest.json()["accepted"] == 1

    response = client.get("/api/health/observability", headers={"X-Admin-Passphrase": ADMIN_PASSPHRASE})
    assert response.status_code == 200
    payload = response.json()
    assert payload["runtime"]["frontend"]["total_events"] >= 1
    assert "alerts" in payload["persistent"]
