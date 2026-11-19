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

"""breather web 路由约定：插件 router 单独承载三条端点，响应形状与删除前的通用侧一致。"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from workflow_controller.event.type_registry import EventTypeRegistry
from workflow_controller.plugin.base import PluginConfig
from workflow_controller.plugin.context import PluginContext
from workflow_controller.plugin.registry import _build_plugin_services
from workflow_controller.plugins.breather.plugin import BreatherPlugin
from workflow_controller.web.console import register_domain_routes, register_plugin_routers
from workflow_controller.web.insight import mount_insight_proxy


def _installed_breather(orch: MagicMock) -> BreatherPlugin:
    """经生产装配路径构造并安装 breather 插件（services 端口接到 mock 上）。"""
    orch.bus.type_registry = EventTypeRegistry()
    plugin = BreatherPlugin(
        PluginConfig(name="breather", version="0", enabled=True),
        Path("."),
    )
    plugin.install(
        PluginContext(
            bus=orch.bus,
            type_registry=EventTypeRegistry(),
            hook_server=MagicMock(),
            services=_build_plugin_services(orch),
        )
    )
    return plugin


# 原通用侧路由的响应形状，逐键锁定
IDLE_STATE = {
    "pending": False,
    "finalizing": False,
    "stop_armed": False,
    "force_pending": False,
    "pending_session_id": "",
    "active_subagents": [],
}


def _breather_client() -> tuple[TestClient, BreatherPlugin]:
    """按生产装配方式挂载：领域路由在前，breather 插件 router 在后。"""
    orch = MagicMock()
    getattr(orch, "_subagents").in_flight.return_value = {}
    orch.pool.get.return_value = None
    orch.resolve_cli_session_id.return_value = None
    orch.pool.list_sessions.return_value = []
    plugin = _installed_breather(orch)

    app = FastAPI()
    register_domain_routes(app)
    register_plugin_routers(app, SimpleNamespace(plugins=[plugin]))
    return TestClient(app), plugin


def _arm_force_pending(plugin: BreatherPlugin, session_id: str) -> None:
    """构造一个待决强制交接的 session 状态。"""
    getattr(plugin, "_select_state")(session_id)
    setattr(plugin, "_handoff_force_pending", True)


def test_state_idle_matches_legacy_shape() -> None:
    client, _ = _breather_client()

    resp = client.get("/api/breather/state")

    assert resp.status_code == 200
    assert resp.json() == IDLE_STATE


def test_state_pending_reports_scoped_session() -> None:
    client, plugin = _breather_client()
    _arm_force_pending(plugin, "s1")

    resp = client.get("/api/breather/state", params={"session_id": "s1"})

    assert resp.status_code == 200
    assert resp.json() == {**IDLE_STATE, "force_pending": True, "pending_session_id": "s1"}


def test_cancel_without_session_id_rejected() -> None:
    client, _ = _breather_client()

    resp = client.post("/api/breather/cancel", json={})

    assert resp.status_code == 400
    assert resp.json() == {"detail": "session_id is required"}


def test_cancel_resets_pending_state() -> None:
    client, plugin = _breather_client()
    _arm_force_pending(plugin, "s1")

    resp = client.post("/api/breather/cancel", json={"session_id": "s1"})

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert "s1" not in getattr(plugin, "_handoff_states")


def test_handoff_without_active_session_reports_reason() -> None:
    client, _ = _breather_client()

    resp = client.post("/api/breather/handoff", json={"session_id": "s1", "force": False})

    assert resp.status_code == 200
    assert resp.json() == {"handoff_triggered": False, "reason": "no active session"}


def test_routes_without_plugin_report_disabled() -> None:
    """插件未装载时专有端点由控制台响应，不误转发给 Insight。"""
    app = FastAPI()
    register_domain_routes(app)
    register_plugin_routers(app, SimpleNamespace(plugins=[]))
    app.state.insight_port = 1  # 关闭的端口：反代确定性地连接失败
    mount_insight_proxy(app)
    client = TestClient(app, base_url="http://127.0.0.1")

    state = client.get("/api/breather/state")

    assert state.status_code == 200
    assert state.json() == IDLE_STATE
    assert client.post("/api/breather/cancel", json={"session_id": "s1"}).status_code == 409
    assert client.post("/api/breather/handoff", json={"session_id": "s1"}).status_code == 409


def test_runtime_plugin_route_precedes_insight_proxy() -> None:
    from fastapi import APIRouter

    from workflow_controller.web.console import include_router_before_catchall

    app = FastAPI()
    app.state.insight_port = 1
    mount_insight_proxy(app)
    router = APIRouter()

    @router.get("/api/breather/state")
    async def state() -> dict[str, bool]:
        return {"plugin": True}

    include_router_before_catchall(app, router)
    response = TestClient(app, base_url="http://127.0.0.1").get("/api/breather/state")
    assert response.status_code == 200
    assert response.json() == {"plugin": True}
