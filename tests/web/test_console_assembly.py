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

"""Console 装配顺序回归：插件路由必须先于 SPA catch-all 生效。"""

from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute

from workflow_controller.web.console import (
    OPENAPI_TAGS,
    assemble_console,
    include_router_before_catchall,
    register_context_bay_router,
    register_domain_routes,
    register_plugin_routers,
)

if TYPE_CHECKING:
    from pathlib import Path


def _route_paths(app: FastAPI) -> list[str]:
    return [getattr(route, "path", "<no-path>") for route in app.router.routes]


def _plugin_router(path: str) -> APIRouter:
    """带单个 GET 路由的插件 router 桩。"""
    router = APIRouter()

    @router.get(path)
    async def handler() -> dict[str, str]:
        return {"ok": "1"}

    return router


def test_runtime_toggle_router_registered_before_spa_catchall() -> None:
    app = FastAPI()

    @app.get("/{full_path:path}")
    async def spa(full_path: str) -> dict[str, str]:
        return {"spa": full_path}

    include_router_before_catchall(app, _plugin_router("/plugin-runtime"))

    paths = _route_paths(app)
    assert paths.index("/plugin-runtime") < paths.index("/{full_path:path}")


def test_runtime_plugin_router_dedupes_by_name() -> None:
    """运行期注册回调：前插于 catch-all 之前，同名插件不重复注册。"""
    app = FastAPI()
    register_plugin_routers(app, SimpleNamespace(plugins=[]))
    register = app.state.register_runtime_plugin_router

    register("demo", _plugin_router("/demo-a"))
    register("demo", _plugin_router("/demo-b"))  # 同名：忽略

    paths = _route_paths(app)
    assert "/demo-a" in paths and "/demo-b" not in paths
    assert getattr(app.state, "plugin_routers") == {"demo"}


def test_domain_route_tags_match_openapi_tags() -> None:
    """领域路由挂载的 tag 必须与 OPENAPI_TAGS 完全一致（单一来源回归）。

    此前 tag 在 OPENAPI_TAGS 与挂载表各自硬编码一份，新增领域漏改会让
    端点静默丢失中文描述并被排到 /docs 末尾；此断言钉死两边集合一致。
    """
    app = FastAPI()
    app.state.api = MagicMock()
    register_domain_routes(app)
    register_context_bay_router(app)

    mounted: set[str] = set()
    for route in app.router.routes:
        if not (isinstance(route, APIRoute) and route.path.startswith("/api/v1")):
            continue
        for tag in route.tags:
            mounted.add(tag)
    documented = {entry["name"] for entry in OPENAPI_TAGS}
    assert mounted == documented, (
        f"领域挂载 tag={sorted(mounted)} 与 OPENAPI_TAGS={sorted(documented)} 不一致"
    )


def test_register_context_bay_router_failure_fails_boot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """装配失败必须向上抛出终止启动，不得吞异常静默丢掉 CANN 端点。"""

    def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("service build failed")

    monkeypatch.setattr(
        "workflow_controller.web.context_bay.service.ContextBayConsoleService", boom
    )
    app = FastAPI()
    app.state.api = MagicMock()
    with pytest.raises(RuntimeError):
        register_context_bay_router(app)


def test_register_context_bay_router_exposes_config_section_provider() -> None:
    """装配同时注册领域配置段服务：配置路由与 SSE 经它组合领域段。"""
    app = FastAPI()
    app.state.api = MagicMock()
    register_context_bay_router(app)
    provider = app.state.config_section_providers["context_bay"]
    assert provider.read_config_section() == {"repo_url": "", "snapshot_paths": []}


async def test_assemble_console_keeps_plugin_router_before_spa_catchall(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # dist 构建产物不入库，缺失时 mount_spa 会跳过 catch-all 注册；
    # 指向伪 dist 才能让真实装配路径完整生效。
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")
    monkeypatch.setattr("workflow_controller.web.spa._frontend_dist", lambda: dist)

    async def fake_detect() -> int:
        return 21025

    monkeypatch.setattr("workflow_controller.web.console.detect_insight_port", fake_detect)

    plugin = SimpleNamespace(
        config=SimpleNamespace(name="demo"),
        get_web_router=lambda: _plugin_router("/plugin-at-boot"),
    )
    app = FastAPI()
    # CANN 领域路由装配需要 CoreAPI
    app.state.api = MagicMock()
    await assemble_console(app, SimpleNamespace(plugins=[plugin]))  # type: ignore[arg-type]

    paths = _route_paths(app)
    assert paths.index("/plugin-at-boot") < paths.index("/{full_path:path}")
    assert app.state.insight_port == 21025
    assert "/insight/{path:path}" in paths
    assert "/api/v1/insight/status" in paths  # CANN 领域暂存路由随装配挂载
