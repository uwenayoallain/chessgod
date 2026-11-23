#!/usr/bin/env python3
"""Deploy the tunnel-offline page Worker and route it on chess.uwe.rw.

    make offline-page

Uploads scripts/cloudflare/offline-worker.js as the Worker `chessgod-offline`
and makes sure a route `chess.uwe.rw/*` points at it. Needs an API token with
Workers Scripts Write and Workers Routes Write in `.env.tunnel` as
CLOUDFLARE_API_TOKEN (create one at dash.cloudflare.com/profile/api-tokens);
the first deploy was done through the Cloudflare connector, so this exists for
the next change to the page.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import uuid
from pathlib import Path

ACCOUNT_ID = "f6c525e6c96462a7f6e1eddd5fc2b4e4"
ZONE_ID = "39100703458d81405ad572ec03bf4293"
SCRIPT_NAME = "chessgod-offline"
ROUTE_PATTERN = "chess.uwe.rw/*"
API = "https://api.cloudflare.com/client/v4"

ROOT = Path(__file__).resolve().parents[2]


def read_token() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    env_file = ROOT / ".env.tunnel"
    if not token and env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("CLOUDFLARE_API_TOKEN="):
                token = line.split("=", 1)[1].strip()
    if not token:
        sys.exit("Set CLOUDFLARE_API_TOKEN in .env.tunnel (Workers Scripts Write + Workers Routes Write).")
    return token


def call(token: str, method: str, path: str, body: bytes | None = None, content_type: str = "application/json") -> dict:
    request = urllib.request.Request(API + path, data=body, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    if body is not None:
        request.add_header("Content-Type", content_type)
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)
    if not payload.get("success"):
        sys.exit(f"{method} {path}: {payload.get('errors')}")
    return payload["result"]


def main() -> None:
    token = read_token()
    source = (ROOT / "scripts/cloudflare/offline-worker.js").read_bytes()
    boundary = f"----chessgod{uuid.uuid4().hex}"
    metadata = json.dumps({"main_module": "worker.js", "compatibility_date": "2026-10-01"})
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{metadata}\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"worker.js\"; filename=\"worker.js\"\r\nContent-Type: application/javascript+module\r\n\r\n".encode()
        + source
        + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    call(
        token, "PUT", f"/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}",
        b"".join(parts), f"multipart/form-data; boundary={boundary}",
    )
    print(f"uploaded {SCRIPT_NAME} ({len(source):,} bytes)")

    routes = call(token, "GET", f"/zones/{ZONE_ID}/workers/routes")
    existing = next((route for route in routes if route["pattern"] == ROUTE_PATTERN), None)
    if existing and existing.get("script") == SCRIPT_NAME:
        print(f"route {ROUTE_PATTERN} already points at {SCRIPT_NAME}")
    elif existing:
        call(token, "PUT", f"/zones/{ZONE_ID}/workers/routes/{existing['id']}",
             json.dumps({"pattern": ROUTE_PATTERN, "script": SCRIPT_NAME}).encode())
        print(f"route {ROUTE_PATTERN} now points at {SCRIPT_NAME}")
    else:
        call(token, "POST", f"/zones/{ZONE_ID}/workers/routes",
             json.dumps({"pattern": ROUTE_PATTERN, "script": SCRIPT_NAME}).encode())
        print(f"route {ROUTE_PATTERN} created")


if __name__ == "__main__":
    main()
