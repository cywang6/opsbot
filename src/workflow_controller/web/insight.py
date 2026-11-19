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

"""cannbot-insight 端口探测与同源反代。"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
from fastapi import Request  # noqa: TC002 — handler 注解需运行时可解析
from fastapi.responses import JSONResponse, RedirectResponse, Response
from starlette.responses import StreamingResponse
from starlette.websockets import WebSocket  # noqa: TC002

from workflow_controller.web.spa import spa_fallback_response

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Awaitable, Callable
    from typing import Any
    from urllib.parse import SplitResult

    from fastapi import FastAPI

log = logging.getLogger(__name__)


def _read_lock_port(insight_dir: Path | None) -> int | None:
    """读 insight 目录 .next/dev/lock 登记的端口。

    lock 里的 pid 必须存活，否则视为上次启动的残留（进程已死、端口
    可能已被别人占用），返回 None 让调用方走 probe fallback。
    """
    if insight_dir is None:
        return None
    lock_file = insight_dir / ".next" / "dev" / "lock"
    try:
        lock_data = json.loads(lock_file.read_text())
        lp = int(lock_data.get("port", 0))
        if lp <= 0:
            return None
        pid = int(lock_data.get("pid", 0))
        if pid > 0:
            try:
                os.kill(pid, 0)  # 信号 0 = 只探测进程是否存在
            except OSError:
                return None  # stale lock：写它的进程已死
        return lp
    except Exception:
        return None


async def detect_insight_port() -> int:
    """探测 Insight 端口：环境优先，兼容显式目录元数据。"""
    env_port = os.environ.get("WORKFLOW_CONTROLLER_INSIGHT_PORT", "")
    env_dir = os.environ.get("WORKFLOW_CONTROLLER_INSIGHT_DIR", "")
    insight_port = int(env_port) if env_port.isdigit() else 21025

    if env_port.isdigit():
        await _probe_insight_port(insight_port)
        return insight_port

    insight_dir: Path | None = Path(env_dir) if env_dir else None

    lock_port: int | None = None
    if env_dir:
        # 子进程刚启动时 lock 写入可能延迟。
        for _ in range(40):
            lock_port = _read_lock_port(insight_dir)
            if lock_port is not None:
                break
            await asyncio.sleep(0.2)
    else:
        lock_port = _read_lock_port(insight_dir)
    if lock_port is not None:
        insight_port = lock_port
        log.info("insight port detected from .next/dev/lock: %d", lock_port)

    # lock 只 probe 这一个确认服务活着；没有 lock 时才 range scan。
    ports_to_probe = [lock_port] if lock_port is not None else list(range(21025, 21036))
    for probe_port in ports_to_probe:
        if await _probe_insight_port(probe_port):
            return probe_port
    return insight_port


async def _probe_insight_host(port: int, probe_host: str) -> bool:
    """单个 host 上指定端口的 Insight 探测（observe API 返回 200 即可用）。"""
    try:
        async with httpx.AsyncClient(timeout=3.0, trust_env=False) as probe_client:
            probe_resp = await probe_client.get(
                f"http://{probe_host}:{port}/api/observe/data?pageSize=1"
            )
            return probe_resp.status_code == 200
    except Exception:
        log.debug("insight 端口探测失败（%s），尝试下一候选", probe_host)
        return False


async def _probe_insight_port(port: int) -> bool:
    """确认指定端口上的 Insight 服务可用。"""
    for probe_host in ("127.0.0.1", "[::1]"):
        if await _probe_insight_host(port, probe_host):
            return True
    return False


_INSIGHT_API_PREFIXES = (
    "api/observe/",
    "api/ingest/",
    "api/ai/",
    "api/settings/",
    "api/config/context-windows",
    "api/breather/",
)

# Next.js 静态资源与图标：insight HTML 以绝对路径 src="/_next/..." / href="/icon.svg"
# 引用，浏览器按原点请求 → 命中 Workflow Controller SPA catch-all（返回 index.html，非 JS）。
# 这些路径 Workflow Controller 自己没有，直接反代到 insight。
_INSIGHT_STATIC_PREFIXES = (
    "_next/",
    "icon.svg",
)

# Next.js 的 RSC 请求使用实际路由路径，省略 /insight 前缀。
_INSIGHT_PAGE_PREFIXES = ("run/", "session/")
_INSIGHT_PAGE_REFERER = re.compile(r"^https?://[^/?#]+/insight/(?:run|session)/")


def _insight_port(app: FastAPI, port_holder: dict[str, int]) -> int:
    """每次 request 读 app.state.insight_port（探测结果），缓存到 holder。"""
    p = getattr(app.state, "insight_port", 21025)
    if isinstance(p, int) and p > 0:
        port_holder["port"] = p
    return port_holder["port"] or 21025


def _insight_read_timeout() -> float:
    """反代读超时上限（评分接口可能在首事件前静默数分钟，只限连接建立与相邻数据段间隔）。"""
    try:
        read_timeout = float(os.environ.get("WORKFLOW_CONTROLLER_INSIGHT_READ_TIMEOUT", "3600"))
    except ValueError:
        read_timeout = 3600.0
        log.warning(
            "WORKFLOW_CONTROLLER_INSIGHT_READ_TIMEOUT 无法解析，回退默认值 3600；当前值=%r",
            os.environ.get("WORKFLOW_CONTROLLER_INSIGHT_READ_TIMEOUT"),
        )
    return read_timeout


def _insight_forbidden() -> JSONResponse:
    """跨源反代请求的统一 403 响应。"""
    return JSONResponse(
        {"error": "Forbidden: cross-origin insight proxy request"},
        status_code=403,
    )


def _insight_host_allowed(host: str) -> bool:
    """Host 头校验：无 Origin/Referer 的子资源请求仍可能经 DNS rebinding 到回环端口，
    须单独限定白名单（可经环境变量追加）。
    """
    allowed_hosts = {"127.0.0.1", "localhost", "0.0.0.0", "::1"}
    extra_hosts = os.environ.get("WORKFLOW_CONTROLLER_INSIGHT_PROXY_HOSTS", "")
    allowed_hosts.update(h.strip().lower() for h in extra_hosts.split(",") if h.strip())
    try:
        parsed_host = urlsplit(f"http://{host}")
        return (
            parsed_host.hostname in allowed_hosts
            and parsed_host.netloc == host
            and parsed_host.path == ""
            and parsed_host.username is None
            and parsed_host.password is None
            and parsed_host.port != 0
        )
    except ValueError:
        return False


def _insight_check_site(
    host: str, origin: str | None, referer: str | None
) -> tuple[bool, SplitResult | None]:
    """Origin/Referer 同源校验（头存在才校验）；返回（是否通过, 解析后的 referer）。"""
    same_origins = {f"http://{host}", f"https://{host}"}
    valid_origin = origin is None or origin.lower() in same_origins
    try:
        ref = urlsplit(referer) if referer is not None else None
        valid_referer = ref is None or f"{ref.scheme}://{ref.netloc}".lower() in same_origins
    except ValueError:
        return False, None
    return valid_origin and valid_referer, ref


def _insight_forward_headers(
    request: Request,
    origin: str | None,
    referer: str | None,
    ref: SplitResult | None,
    port: int,
) -> dict[str, str]:
    """转发请求头：去掉 host/长度/传输/压缩协商字段；origin/referer 改写为 insight 同源。"""
    fwd_headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length", "transfer-encoding", "accept-encoding")
    }
    upstream_origin = f"http://127.0.0.1:{port}"
    if origin is not None:
        fwd_headers["origin"] = upstream_origin
    if referer is not None and ref is not None:
        fwd_headers["referer"] = urlunsplit(
            ("http", f"127.0.0.1:{port}", ref.path, ref.query, ref.fragment)
        )
    return fwd_headers


async def _send_insight_upstream(
    client: httpx.AsyncClient,
    request: Request,
    target: str,
    body: bytes,
    fwd_headers: dict[str, str],
    read_timeout: float,
) -> httpx.Response | Response:
    """发上游请求（流式）；连接失败/读超时/其他超时分别映射为 502/504 终态响应。"""
    try:
        return await client.send(
            client.build_request(
                request.method,
                target,
                headers={**fwd_headers, "accept-encoding": "identity"},
                content=body if body else None,
            ),
            stream=True,
        )
    except httpx.ConnectError:
        await client.aclose()
        return Response(
            content='{"error":"cannbot-insight not reachable. '
            'Start it with `workflow-controller web --insight`."}',
            media_type="application/json",
            status_code=502,
        )
    except httpx.ReadTimeout:
        await client.aclose()
        return Response(
            content=json.dumps(
                {"error": f"cannbot-insight not responding within {read_timeout:g}s"},
                ensure_ascii=False,
            ),
            media_type="application/json",
            status_code=504,
        )
    except httpx.TimeoutException:
        await client.aclose()
        return Response(
            content=json.dumps(
                {"error": "cannbot-insight connection timed out"},
                ensure_ascii=False,
            ),
            media_type="application/json",
            status_code=504,
        )


def _insight_legacy_redirect(request: Request) -> RedirectResponse:
    """旧版独立会话页链接重定向到新的同源会话页（保留查询串）。"""
    task_id = request.url.path.removeprefix("/insight/run/solo:")
    legacy_url = f"/insight/session/{quote(task_id, safe='')}"
    if request.url.query:
        legacy_url = f"{legacy_url}?{request.url.query}"
    return RedirectResponse(legacy_url)


def _insight_response_headers(upstream: httpx.Response) -> dict[str, str]:
    """响应头透传过滤：去逐跳与长度字段；保留上游已设的 content-encoding。"""
    out_headers: dict[str, str] = {}
    for k, v in upstream.headers.items():
        if k.lower() not in (
            "content-encoding",
            "transfer-encoding",
            "connection",
            "content-length",
        ):
            out_headers[k] = v
    if upstream.headers.get("content-encoding"):
        out_headers["content-encoding"] = upstream.headers["content-encoding"]
    return out_headers


async def _insight_chunks(
    upstream: httpx.Response, client: httpx.AsyncClient
) -> AsyncIterator[bytes]:
    """上游流改写为响应体迭代器；结束/异常时关闭上游连接与客户端。"""
    try:
        if upstream.is_stream_consumed:
            if upstream.content:
                yield upstream.content
            return
        async for chunk in upstream.aiter_raw():
            yield chunk
    finally:
        await upstream.aclose()
        await client.aclose()


async def _proxy_to_insight(
    path: str,
    request: Request,
    port_holder: dict[str, int],
    stream_timeout: httpx.Timeout,
    read_timeout: float,
) -> Response:
    """单个请求的同源反代核心：站点校验 → 构造转发 → 流式回传。"""
    port = _insight_port(request.app, port_holder)
    raw_path = request.scope.get("raw_path")
    if raw_path is not None:
        path = raw_path.decode("ascii").removeprefix("/insight/").removeprefix("/")
    target = f"http://127.0.0.1:{port}/{path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"

    body = await request.body()

    host = request.headers.get("host", "").lower()
    origin = request.headers.get("origin")
    referer = request.headers.get("referer")

    if not _insight_host_allowed(host):
        return _insight_forbidden()
    site_ok, ref = _insight_check_site(host, origin, referer)
    if not site_ok:
        return _insight_forbidden()

    fwd_headers = _insight_forward_headers(request, origin, referer, ref, port)

    client = httpx.AsyncClient(timeout=stream_timeout, trust_env=False)
    upstream = await _send_insight_upstream(
        client, request, target, body, fwd_headers, read_timeout
    )
    if isinstance(upstream, Response):
        return upstream

    # 旧版 cannbot-insight 只有独立会话页。改用同源旧链接也能保留其 RSC 分流。
    if (
        upstream.status_code == 404
        and request.method in ("GET", "HEAD")
        and request.url.path.startswith("/insight/run/solo:")
    ):
        await upstream.aclose()
        await client.aclose()
        return _insight_legacy_redirect(request)

    out_headers = _insight_response_headers(upstream)
    return StreamingResponse(
        _insight_chunks(upstream, client),
        status_code=upstream.status_code,
        headers=out_headers,
        media_type=upstream.headers.get("content-type"),
    )


def _insight_proxy_sender(
    port_holder: dict[str, int],
    stream_timeout: httpx.Timeout,
    read_timeout: float,
) -> Callable[[str, Request], Awaitable[Response]]:
    """绑定 mount 时的端口 holder 与超时参数，返回各路由 handler 共用的转发入口。"""

    async def _send(path: str, request: Request) -> Response:
        return await _proxy_to_insight(path, request, port_holder, stream_timeout, read_timeout)

    return _send


def _register_insight_api_proxy(
    app: FastAPI, proxy: Callable[[str, Request], Awaitable[Response]]
) -> None:
    """insight 数据 API 路由：Workflow Controller 自身路由先注册、重叠路径由其命中；
    这里只回退 insight 独有的子路径。
    """
    methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]

    def register(pattern: str) -> None:
        @app.api_route(pattern, methods=methods)
        async def _insight_api_proxy(request: Request) -> Response:
            full = request.url.path.lstrip("/")
            if full == "api/breather/state" and request.method == "GET":
                return JSONResponse(
                    {
                        "pending": False,
                        "finalizing": False,
                        "stop_armed": False,
                        "force_pending": False,
                        "pending_session_id": "",
                        "active_subagents": [],
                    }
                )
            if full in ("api/breather/handoff", "api/breather/cancel"):
                return JSONResponse({"detail": "Breather plugin is disabled"}, status_code=409)
            return await proxy(full, request)

    for prefix in _INSIGHT_API_PREFIXES:
        # 以 '/' 结尾的前缀（如 "api/observe/"）匹配子路径 /api/observe/{path}；
        # 不以 '/' 结尾的前缀（如 "api/config/context-windows"）匹配精确路径。
        pattern = f"/{prefix}{{path:path}}" if prefix.endswith("/") else f"/{prefix}"
        register(pattern)


def _register_insight_static_proxy(
    app: FastAPI, proxy: Callable[[str, Request], Awaitable[Response]]
) -> None:
    """insight 静态资源路由：HTML 以绝对路径引用，不反代会命中 SPA catch-all。"""

    def register(pattern: str) -> None:
        @app.api_route(pattern, methods=["GET", "HEAD", "OPTIONS"])
        async def _insight_static_proxy(request: Request) -> Response:
            full = request.url.path.lstrip("/")
            return await proxy(full, request)

    for prefix in _INSIGHT_STATIC_PREFIXES:
        pattern = f"/{prefix}{{path:path}}" if prefix.endswith("/") else f"/{prefix}"
        register(pattern)


def _register_insight_page_proxy(
    app: FastAPI, proxy: Callable[[str, Request], Awaitable[Response]]
) -> None:
    """/run/* 和 /session/* 与 Vue 路由重叠，按 Referer 分流。Vite 使用同一判据。"""

    def register(pattern: str) -> None:
        @app.api_route(pattern, methods=["GET", "POST", "HEAD", "OPTIONS"])
        async def _insight_route_proxy(request: Request) -> Response:
            referer = request.headers.get("referer", "")
            if not _INSIGHT_PAGE_REFERER.match(referer):
                return spa_fallback_response()
            full = request.url.path.lstrip("/")
            return await proxy(full, request)

    for prefix in _INSIGHT_PAGE_PREFIXES:
        pattern = f"/{prefix}{{path:path}}" if prefix.endswith("/") else f"/{prefix}"
        register(pattern)


async def _ws_browser_to_insight(ws: WebSocket, ws_insight: Any) -> None:
    """浏览器 → insight 单向泵：收到 disconnect 帧即结束。"""
    while True:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            break
        data = msg.get("bytes") or msg.get("text", b"")
        await ws_insight.send(data)


async def _ws_insight_to_browser(ws: WebSocket, ws_insight: Any) -> None:
    """insight → 浏览器单向泵：按帧类型转发 bytes/text。"""
    while True:
        data = await ws_insight.recv()
        if isinstance(data, bytes):
            await ws.send_bytes(data)
        else:
            await ws.send_text(data)


async def _proxy_insight_ws(ws: WebSocket, port_holder: dict[str, int]) -> None:
    """浏览器 ↔ insight 的 HMR websocket 桥接（httpx 不支持 ws upgrade，用 websockets 库）。"""
    await ws.accept()
    port = _insight_port(ws.app, port_holder)
    ws_path = ws.url.path
    if ws.url.query:
        ws_path = f"{ws_path}?{ws.url.query}"
    target = f"ws://127.0.0.1:{port}{ws_path}"

    import websockets as _ws_lib

    try:
        async with _ws_lib.connect(target) as ws_insight:
            task1 = asyncio.create_task(_ws_browser_to_insight(ws, ws_insight))
            task2 = asyncio.create_task(_ws_insight_to_browser(ws, ws_insight))
            _done, pending = await asyncio.wait([task1, task2], return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
    except Exception:
        log.debug("insight 双向代理结束（连接异常关闭）")
    finally:
        with contextlib.suppress(Exception):
            await ws.close()


def _register_insight_ws_proxy(app: FastAPI, port_holder: dict[str, int]) -> None:
    """WebSocket 反代注册。

    Next.js turbopack dev mode 的 HMR 用 websocket（/_next/webpack-hmr）。React
    hydration 依赖 HMR ws 连接成功——连不上时 React 不 hydrate，页面永远卡在
    "Loading session..."。

    注意：WebSocket 类型必须全局 import（文件顶部），不能局部 import。
    `from __future__ import annotations` 使注解变成字符串，get_type_hints
    在全局作用域找不到局部 import 的名字 → FastAPI 把 WebSocket 参数误认为
    query param → handler 不被调用 → ws upgrade 返回 403。
    """

    @app.websocket("/_next/webpack-hmr")
    async def _insight_ws_proxy(ws: WebSocket) -> None:
        await _proxy_insight_ws(ws, port_holder)


def mount_insight_proxy(app: FastAPI) -> None:
    """把 cannbot-insight 的页面与数据 API 反代到 Workflow Controller 同源端口。

    远程（SSH 转发）场景用户只需转发 Workflow Controller 的 18600 一个端口，insight 经
    反代访问；端口读 app.state.insight_port（detect_insight_port 探测结果）。
    三类路径被反代：

    1. ``/insight/{path}`` — insight 页面与路由（Next.js 页面）。
       剥掉 ``/insight`` 前缀后透传给 insight 的 ``/{path}``。
    2. insight 数据 API — insight 前端用绝对路径 ``/api/observe/*`` 等发请求，
       浏览器按原点解析会打到 Workflow Controller 的 ``/api/*``（命中 SPA catch-all → 404）。
       所以这些路径也需反代到 insight。
    3. insight 静态资源 — ``/_next/*``、``/icon.svg`` 等，insight HTML 以绝对
       路径引用，同样需反代否则命中 Workflow Controller SPA catch-all。

    Workflow Controller 自身的 API 路由（领域路由模块）先于本函数注册，FastAPI 按注册顺序
    匹配，因此与 insight 重叠的子路径（如 ``/api/breather/handoff``）由 Workflow Controller
    自己的 handler 命中；insight 独有的子路径（如 ``/api/breather/check-file``）
    落到本反代。无重叠的前缀（``/api/observe/*``、``/api/ingest/*``、``/api/ai/*``、
    ``/api/settings/*``）整体反代。
    """
    insight_port_holder: dict[str, int] = {"port": 0}
    read_timeout = _insight_read_timeout()
    stream_timeout = httpx.Timeout(connect=10.0, read=read_timeout, write=60.0, pool=10.0)
    proxy = _insight_proxy_sender(insight_port_holder, stream_timeout, read_timeout)

    # 1) insight 页面与静态资源：/insight/{path} → insight 的 /{path}
    @app.api_route(
        "/insight/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]
    )
    async def _insight_page_proxy(path: str, request: Request) -> Response:
        return await proxy(path, request)

    # 2) insight 数据 API → insight（重叠路径由 Workflow Controller 自身路由命中）
    _register_insight_api_proxy(app, proxy)

    # 3) insight 静态资源 → insight
    _register_insight_static_proxy(app, proxy)

    # 4) /run/* 和 /session/* 与 Vue 路由重叠，按 Referer 分流
    _register_insight_page_proxy(app, proxy)

    # 5) WebSocket 反代（Next.js HMR）
    _register_insight_ws_proxy(app, insight_port_holder)
