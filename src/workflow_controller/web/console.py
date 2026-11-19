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

"""Console 装配：领域路由聚合、插件路由注册、Insight 反代与 SPA 挂载。"""

from __future__ import annotations

import functools
import logging
from typing import TYPE_CHECKING, Any

from workflow_controller.web.insight import detect_insight_port, mount_insight_proxy
from workflow_controller.web.spa import mount_spa

if TYPE_CHECKING:
    from fastapi import FastAPI

    from workflow_controller.core.orchestrator import Orchestrator

log = logging.getLogger(__name__)

# ── 领域路由与 Swagger 分组（单一来源）────────────────────────────────
# URL 前缀、Swagger tag 与中文描述集中在此表；/docs 与 /openapi.json 的
# 展示顺序、OPENAPI_TAGS 均由它派生，scripts/kernel_split_baseline.py 也
# 从这张表派生前缀映射。路由模块不再声明前缀与 tags，新增领域只改这里
# 一行：漏登 / 拼错会在装配期立即报错，而不是静默漂移。
# (模块名, 前缀, tag, 中文描述) —— 模块名为 workflow_controller.web.routes.<名>（context_bay 除外）
DOMAIN_ROUTES: tuple[tuple[str, str, str, str], ...] = (
    ("sessions_routes", "/api/v1", "sessions", "Session 启动、控制、导入与提示注入"),
    ("runs_routes", "/api/v1/runs", "runs", "Run 启动、组控、成员操作、事件与导出"),
    ("overview_routes", "/api/v1", "overview", "健康检查、流水线进度、用量与事件轮询"),
    ("config_routes", "/api/v1", "config", "全局与项目配置、最近项目与目录浏览"),
    ("auth_routes", "/api/v1", "auth", "Provider 池、密钥状态与全局认证设置"),
    ("plugins_routes", "/api/v1", "plugins", "插件清单、启停、安装与配置"),
    ("sse_routes", "/api/v1", "sse", "实时事件流（Server-Sent Events）"),
    ("watchdog_routes", "/api/v1", "watchdog", "告警查询"),
    ("context_bay", "/api/v1", "context_bay", "insight 导入与 Context Bay 上传"),
)

# Swagger 分组（/docs 与 /openapi.json）：顺序与描述由 DOMAIN_ROUTES 派生，
# 不另行维护第二份，新增/改名 tag 只改上面一张表。
OPENAPI_TAGS: list[dict[str, str]] = [
    {"name": tag, "description": description} for _, _, tag, description in DOMAIN_ROUTES
]

# 模块名 → (前缀, tag)，装配期查表；重复登记在导入期即报错。
_MOUNT_BY_MODULE: dict[str, tuple[str, str]] = {}
for _name, _prefix, _tag, _description in DOMAIN_ROUTES:
    if _name in _MOUNT_BY_MODULE:
        raise ValueError(f"DOMAIN_ROUTES 重复登记模块：{_name}")
    _MOUNT_BY_MODULE[_name] = (_prefix, _tag)


def register_domain_routes(app: FastAPI) -> None:
    """注册自有领域路由：URL 前缀与 Swagger 分组由本装配层独占。

    路由模块只声明局部路径与 handler；改版本号、换分组只改 DOMAIN_ROUTES
    一张表。context_bay 需先构造 service，由 register_context_bay_router 单独装配。
    """
    from workflow_controller.web.routes import (
        auth_routes,
        config_routes,
        overview_routes,
        plugins_routes,
        runs_routes,
        sessions_routes,
        sse_routes,
        watchdog_routes,
    )

    route_modules = {
        "sessions_routes": sessions_routes,
        "runs_routes": runs_routes,
        "overview_routes": overview_routes,
        "config_routes": config_routes,
        "auth_routes": auth_routes,
        "plugins_routes": plugins_routes,
        "sse_routes": sse_routes,
        "watchdog_routes": watchdog_routes,
    }
    unregistered = set(_MOUNT_BY_MODULE) - set(route_modules) - {"context_bay"}
    if unregistered:
        raise ValueError(f"DOMAIN_ROUTES 未登记装配的领域模块：{sorted(unregistered)}")
    for name, module in route_modules.items():
        prefix, tag = _MOUNT_BY_MODULE[name]
        app.include_router(module.router, prefix=prefix, tags=[tag])


def register_plugin_routers(app: FastAPI, orchestrator: Orchestrator) -> None:
    """注册已装载插件的 web router（必须在 SPA catch-all 之前）。"""
    app.state.plugin_routers = set()
    app.state.register_runtime_plugin_router = functools.partial(
        register_runtime_plugin_router, app
    )
    for plugin in orchestrator.plugins:
        try:
            router = plugin.get_web_router()
            if router is not None:
                app.include_router(router)
                app.state.plugin_routers.add(plugin.config.name)
        except Exception:
            log.exception("Failed to register web router for plugin '%s'", plugin.config.name)


def register_context_bay_router(app: FastAPI) -> None:
    """注册 CANN 领域暂存路由（上传/导入），前缀与分组取自 DOMAIN_ROUTES。

    CANN 上传/导入是核心交付面，装配失败不降级：异常向上抛出终止启动。
    """
    from workflow_controller.web.context_bay.routes import build_router as build_context_bay_router
    from workflow_controller.web.context_bay.service import ContextBayConsoleService

    prefix, tag = _MOUNT_BY_MODULE["context_bay"]
    service = ContextBayConsoleService(app.state.api)
    router = build_context_bay_router(service)
    app.include_router(router, prefix=prefix, tags=[tag])
    # 注册领域配置段服务：配置路由与 SSE 经它组合领域段
    providers = getattr(app.state, "config_section_providers", None)
    if providers is None:
        providers = {}
        app.state.config_section_providers = providers
    providers["context_bay"] = service


async def assemble_console(app: FastAPI, orchestrator: Orchestrator) -> None:
    """启动期 Console 装配：探测 insight 端口，按序注册插件、领域与反代、SPA 路由。"""
    app.state.insight_port = await detect_insight_port()
    register_plugin_routers(app, orchestrator)
    register_context_bay_router(app)
    mount_insight_proxy(app)
    mount_spa(app)


def register_runtime_plugin_router(app: FastAPI, name: str, router: Any) -> None:
    """运行期注册插件 router（前插于 SPA catch-all 之前），同名只注册一次。"""
    if name in app.state.plugin_routers:
        return
    include_router_before_catchall(app, router)
    app.state.plugin_routers.add(name)


def include_router_before_catchall(app: FastAPI, router: Any) -> None:
    """运行期把 router 注册到 SPA catch-all 之前。

    启动期 ``app.include_router`` 发生在 SPA 挂载之前，router 天然排在
    catch-all 前。但运行期 Settings 里 toggle 启用插件时，``app.include_router``
    把 router **追加**到 ``app.router.routes`` 末尾——排在已注册的 catch-all
    ``@app.get("/{full_path:path}")`` 之后。Starlette 按注册顺序匹配，GET 请求
    会被 catch-all 截胡返回 404，永远到不了 plugin router（catch-all 只注册了
    GET，故 POST 不受影响——这是诊断该问题的鉴别性特征）。本函数先
    ``include_router``，再把本次新增的全部路由从末尾移到首个 catch-all Route
    之前。

    用 ``n_before`` 记录 include 前的长度，按长度批量前移——不依赖 FastAPI
    是否把 router 包成单个 ``_IncludedRouter``（0.141+）或逐条 append Route
    （0.136），也不依赖 ``_mark_routes_changed``（0.141+ 才有）。若运行环境有
    该内部方法则调用刷新路由缓存，否则跳过。
    """
    from starlette.routing import Route

    n_before = len(app.router.routes)
    app.include_router(router)
    routes = app.router.routes
    added = routes[n_before:]  # 本次新增的全部条目（1 或 N）

    catchall_idx = next(
        (
            i
            for i, r in enumerate(routes)
            if isinstance(r, Route) and r.path in ("/api/breather/{path:path}", "/{full_path:path}")
        ),
        None,
    )
    if catchall_idx is not None and added:
        del routes[n_before:]  # 从末尾摘除新增的条目
        for r in reversed(added):  # 逆序插入，保持原相对顺序
            routes.insert(catchall_idx, r)
        # 0.141+ 有内部路由缓存刷新方法；0.136 无此方法，直接改 routes 即生效。
        refresh = getattr(app.router, "_mark_routes_changed", None)
        if refresh is not None:
            refresh()
