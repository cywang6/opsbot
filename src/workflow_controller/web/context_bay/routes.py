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

"""CANN 领域暂存路由 — insight 导入与 context_bay 上传的薄路由层。

无前缀：由 Console 装配挂 /api/v1 前缀。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request

if TYPE_CHECKING:
    from workflow_controller.web.context_bay.service import ContextBayConsoleService


def build_router(service: ContextBayConsoleService) -> APIRouter:
    """构建领域路由：处理器只做参数解析与服务委托。"""
    router = APIRouter()

    @router.post("/insight/import")
    async def import_to_insight(session_id: str, request: Request) -> dict[str, Any]:
        """把 session 转录导入 cannbot-insight。"""
        return await service.import_to_insight(session_id, _insight_port(request))

    @router.get("/insight/status")
    async def insight_status(request: Request) -> dict[str, Any]:
        """探测 cannbot-insight 是否在线。"""
        return service.insight_status(_insight_port(request))

    @router.post("/sessions/{session_id}/upload-to-context-bay")
    async def upload_to_context_bay(session_id: str) -> dict[str, Any]:
        """启动后台上传，立即返回 taskId。"""
        return await service.start_upload(session_id)

    @router.get("/sessions/{session_id}/upload-progress/{task_id}")
    async def upload_progress(session_id: str, task_id: str) -> dict[str, Any]:
        """轮询上传进度（终态读后即清）。"""
        return service.upload_progress(task_id)

    return router


def _insight_port(request: Request) -> int:
    """Console 装配期探测到的 insight 端口（缺省 21025）。"""
    return getattr(request.app.state, "insight_port", 21025)
