# Copyright (c) 2026 Workflow Controller Contributors
#
# Licensed under the MIT License (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://opensource.org/licenses/MIT
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

PORT = int(os.environ.get("BASE_PORT", "21025"))

_INDEX_HTML = b"""<!doctype html>
<html><head><title>Insight Stub</title><link rel=\"icon\" href=\"/icon.svg\"></head>
<body><main id=\"insight-root\">Insight Stub</main>
<script src=\"/_next/static/app.js\"></script>
<script>window.__hmrSocket = new WebSocket(`ws://${location.host}/_next/webpack-hmr`)</script>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "fake-cannbot-insight/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_get(self) -> None:
        path = urlparse(self.path).path
        if path == "/_next/webpack-hmr" and self.headers.get("Upgrade", "").lower() == "websocket":
            self._accept_websocket_upgrade()
            return
        if path.startswith("/api/observe/"):
            self.send_bytes(
                200, json.dumps({"ok": True, "source": "fake-insight"}).encode(), "application/json"
            )
            return
        if path.startswith(("/api/ingest/", "/api/ai/", "/api/config/")):
            self.send_bytes(200, b'{"ok":true}', "application/json")
            return
        if path.startswith("/_next/static/"):
            self.send_bytes(
                200, b"document.body.dataset.fakeInsightAsset='loaded';", "application/javascript"
            )
            return
        if path == "/icon.svg":
            self.send_bytes(
                200,
                b"<svg xmlns='http://www.w3.org/2000/svg'><title>fake insight</title></svg>",
                "image/svg+xml",
            )
            return
        is_run = path.startswith("/run/solo:") and path != "/run/solo:legacy-demo"
        is_legacy_session = path == "/session/legacy-demo"
        wants_rsc_payload = self.headers.get("RSC") or "text/x-component" in self.headers.get(
            "Accept", ""
        )
        if (is_run or is_legacy_session) and wants_rsc_payload:
            self.send_bytes(200, b"RSC fake insight", "text/x-component")
            return
        if path == "/" or is_run or is_legacy_session:
            self.send_bytes(200, _INDEX_HTML, "text/html; charset=utf-8")
            return
        self.send_bytes(404, b"not found", "text/plain")

    do_GET = handle_get

    def _accept_websocket_upgrade(self) -> None:
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(
            hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode(),
            ).digest()
        ).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        payload = b'{"type":"connected"}'
        self.wfile.write(bytes([0x81, len(payload)]) + payload)
        self.wfile.flush()
        time.sleep(0.2)


if __name__ == "__main__":
    # Bind the port before publishing the lock. If 21025 is already taken (an
    # orphaned fixture from a previous run, or a concurrent E2E round), the
    # constructor raises `Address already in use` and we exit without ever
    # writing a lock that claims a port we don't hold.
    #
    # Note this is not a hard safety net: `cmd_web`'s lock wait (30×0.5s in
    # __main__.py) merely times out and keeps the default port 21025, and
    # app.py keeps `insight_port = 21025` when the HTTP probe fails — so if an
    # unrelated process owns 21025, the reverse proxy may still forward Insight
    # traffic to it and the suite fails at a downstream assertion. When that
    # happens, investigate whoever occupies 21025.
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)

    # `workflow-controller web --insight` waits up to 15s for the real next dev server to write
    # .next/dev/lock before continuing; the fake fixture never wrote it, so every
    # E2E run sat idle. Write the lock ourselves with a live pid (app.py's
    # stale-lock check requires the pid to exist) so the wait breaks immediately.
    lock_dir = Path(__file__).resolve().parent / ".next" / "dev"
    lock_dir.mkdir(parents=True, exist_ok=True)
    (lock_dir / "lock").write_text(json.dumps({"port": PORT, "pid": os.getpid()}))

    server.serve_forever()
