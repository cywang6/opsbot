#!/usr/bin/env python3
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

"""E2E 本地 Anthropic 兼容端点：reviewer 原生 HTTP 路径的确定性替身。

reviewer（core/reviewer_runner.py 的 DriverReviewerRunner）不经子进程，
由 `AnthropicHttpClient` 直接 POST `/v1/messages`，PATH 前置的 CLI shim
拦不到它。`boot-server.sh` 起本脚本（127.0.0.1 固定端口）并把地址种为
假 provider 的 `base_url`，使 provider 校验、auth 探活与潜在 reviewer
判定调用全部落在本地，不出网。

应答规则（见设计文档 docs/designs/workflow-controller-e2e-feature-matrix.md §4.4）：
- 探活类 prompt（provider 校验的 "Reply with exactly OK."、auth 探活的
  "hi"）→ 纯文本 "OK"；
- 其余（`decide_stop` / `review_stage` 等判定类 prompt）→ 固定 `let_exit`
  判定 JSON。现有矩阵用例不驱动 Stop hook，此默认仅保证万一触发时结果
  确定、不出网。
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# logger 名沿用 shim 名，输出前缀 "anthropic-mock: " 与历史一致
logger = logging.getLogger("anthropic-mock")


def _configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


PROBE_SENTINEL = "Reply with exactly OK."
PROBE_GREETING = "hi"
DEFAULT_DECISION = json.dumps(
    {"action": "let_exit", "feedback": "", "rationale": "e2e-mock-reviewer"},
    ensure_ascii=False,
)


def _reply_text(prompt: str) -> str:
    if prompt.strip() == PROBE_GREETING or PROBE_SENTINEL in prompt:
        return "OK"
    return DEFAULT_DECISION


class Handler(BaseHTTPRequestHandler):
    def handle_get(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_post(self) -> None:
        if self.path != "/v1/messages":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self.send_error(400)
            return
        messages = payload.get("messages") or []
        content = messages[0].get("content", "") if messages else ""
        if not isinstance(content, str):
            content = "".join(
                block.get("text", "")
                for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
        text = _reply_text(content)
        body = json.dumps(
            {
                "id": "msg_e2e_mock",
                "type": "message",
                "role": "assistant",
                "model": payload.get("model", ""),
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 16, "output_tokens": 8},
            },
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = handle_get
    do_POST = handle_post

    def log_message(self, fmt: str, *args: object) -> None:
        logger.info("%s", fmt % args)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    _configure_logging()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    logger.info("listening on %s:%s", args.host, args.port)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
