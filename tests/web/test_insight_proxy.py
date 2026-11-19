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

"""insight 反代行为约定：流式透传（首段在上游流结束前到达）+ 502/504 失败响应 + 请求透传。

回归防线：旧实现整包缓冲 + 60s 总超时——mate 评分等分钟级 NDJSON 流经反代
必被截断（首段要等上游收尾才到）。首段到达时机断言直接钉住流式语义。
httpx ASGITransport 自身整包缓冲、观察不到流式，流式断言经进程内 uvicorn
真实端口端到端走 TCP。浏览器侧 base_url 固定 127.0.0.1（反代的 Host 回环校验）。
"""

from __future__ import annotations

import asyncio
import socket
import time

import httpx
import uvicorn
from fastapi import FastAPI

from workflow_controller.web.insight import mount_insight_proxy


def _make_app(insight_port: int) -> FastAPI:
    app = FastAPI()
    app.state.insight_port = insight_port
    mount_insight_proxy(app)
    return app


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1")


async def _run_uvicorn(app: FastAPI) -> tuple[uvicorn.Server, asyncio.Task[None], int]:
    """进程内起真实 ASGI 服务器（端口 0 自动分配），返回 server / serve task / 实际端口。"""
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    return server, task, port


async def test_proxy_streams_chunks_before_upstream_completes() -> None:
    """上游分两段、间隔 1.5s 吐完：首段必须在上游收尾前到达浏览器侧。"""

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readuntil(b"\r\n\r\n")
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/x-ndjson; charset=utf-8\r\n"
            b"Connection: close\r\n\r\n"
            b'{"type":"progress","done":1}\n'
        )
        await writer.drain()
        await asyncio.sleep(1.5)
        writer.write(b'{"type":"done"}\n')
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    upstream = await asyncio.start_server(handle, "127.0.0.1", 0)
    upstream_port = upstream.sockets[0].getsockname()[1]
    server, serve_task, app_port = await _run_uvicorn(_make_app(upstream_port))
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{app_port}") as client:
            t0 = time.monotonic()
            async with client.stream("GET", "/api/observe/session/mate-agent") as resp:
                assert resp.status_code == 200
                assert resp.headers["content-type"] == "application/x-ndjson; charset=utf-8"
                chunks = resp.aiter_bytes()
                first = await asyncio.wait_for(anext(chunks), timeout=5.0)
                t_first = time.monotonic()
                rest = b"".join([chunk async for chunk in chunks])
                t_end = time.monotonic()

        assert first == b'{"type":"progress","done":1}\n'
        assert rest == b'{"type":"done"}\n'
        # 首段在上游收尾前到达（旧整包缓冲实现要等满 ~1.5s 才有首段）
        assert t_first - t0 < 1.0
        assert t_end - t0 >= 1.3
    finally:
        upstream.close()
        await upstream.wait_closed()
        server.should_exit = True
        await asyncio.wait_for(serve_task, timeout=5.0)


async def test_proxy_502_when_insight_unreachable() -> None:
    """insight 端口无进程监听：502 + JSON 错误体，前端可识别。"""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    async with _client(_make_app(port)) as client:
        resp = await client.get("/api/observe/data?pageSize=1")

    assert resp.status_code == 502
    assert "cannbot-insight not reachable" in resp.text


async def test_proxy_504_when_upstream_silent(monkeypatch) -> None:
    """上游连上但持续静默：按 read 间隔限时快速 504，不挂住请求也不抛 500。"""
    monkeypatch.setenv("WORKFLOW_CONTROLLER_INSIGHT_READ_TIMEOUT", "0.5")

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readuntil(b"\r\n\r\n")
        await asyncio.sleep(1.2)
        writer.close()
        await writer.wait_closed()

    upstream = await asyncio.start_server(handle, "127.0.0.1", 0)
    upstream_port = upstream.sockets[0].getsockname()[1]
    try:
        async with _client(_make_app(upstream_port)) as client:
            t0 = time.monotonic()
            resp = await client.get("/api/observe/data?pageSize=1")
            elapsed = time.monotonic() - t0
    finally:
        upstream.close()
        await upstream.wait_closed()

    assert resp.status_code == 504
    assert "not responding" in resp.text
    assert elapsed < 1.5


async def test_proxy_passes_method_path_query_body_and_negotiates_identity() -> None:
    """方法/路径/查询/请求体原样透传；压缩协商固定 identity（本地一跳不压缩）。"""
    seen: dict[str, bytes] = {}

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode("utf-8").split("\r\n")
        seen["request_line"] = lines[0].encode()
        seen["headers"] = "\n".join(lines[1:]).encode()
        seen["body"] = await reader.readexactly(5)
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: 2\r\n"
            b"Connection: close\r\n\r\n"
            b"{}"
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    upstream = await asyncio.start_server(handle, "127.0.0.1", 0)
    upstream_port = upstream.sockets[0].getsockname()[1]
    try:
        async with _client(_make_app(upstream_port)) as client:
            resp = await client.post(
                "/api/ingest/import?x=1",
                content=b"hello",
                headers={"Accept-Encoding": "gzip, br", "X-Custom": "v"},
            )
    finally:
        upstream.close()
        await upstream.wait_closed()

    assert resp.content == b"{}"
    assert seen["request_line"] == b"POST /api/ingest/import?x=1 HTTP/1.1"
    assert seen["body"] == b"hello"
    headers_lower = seen["headers"].decode().lower()
    assert "accept-encoding: identity" in headers_lower
    assert "x-custom: v" in headers_lower


async def test_proxy_forwards_insight_settings_api() -> None:
    """Insight 数据仓设置 API 经同源反代原样到达上游。"""
    body = b'{"address":"https://example.test/lake.git"}'
    seen: dict[str, bytes] = {}

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = await reader.readuntil(b"\r\n\r\n")
        seen["request_line"] = head.decode("utf-8").split("\r\n", 1)[0].encode()
        seen["body"] = await reader.readexactly(len(body))
        response = b'{"ok":true}'
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/json\r\n"
            + f"Content-Length: {len(response)}\r\n".encode()
            + b"Connection: close\r\n\r\n"
            + response
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    upstream = await asyncio.start_server(handle, "127.0.0.1", 0)
    upstream_port = upstream.sockets[0].getsockname()[1]
    try:
        async with _client(_make_app(upstream_port)) as client:
            resp = await client.put("/api/settings/lake-config", content=body)
    finally:
        upstream.close()
        await upstream.wait_closed()

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert seen["request_line"] == b"PUT /api/settings/lake-config HTTP/1.1"
    assert seen["body"] == body
