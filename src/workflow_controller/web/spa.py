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

"""SPA 静态资源与前端路由 fallback。"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response

if TYPE_CHECKING:
    from fastapi import FastAPI

# index.html 必须禁缓存：rebuild 后 chunk hash 变化，缓存的旧 index.html
# 会引用已删除的 chunk → 白屏。no-cache = 每次带 ETag 重验证（未变则 304）。
_NO_CACHE = {"Cache-Control": "no-cache"}
# 带内容 hash 的静态资源可长缓存
_LONG_CACHE = {"Cache-Control": "public, max-age=604800"}


def _frontend_dist() -> Path:
    """前端构建产物目录。"""
    return Path(__file__).parent / "frontend" / "dist"


def spa_fallback_response() -> Response:
    """SPA index 响应；构建产物缺失时 404。"""
    index = _frontend_dist() / "index.html"
    if index.exists():
        return FileResponse(index, headers=_NO_CACHE)
    return Response(status_code=404)


def mount_spa(app: FastAPI) -> None:
    """挂载 SPA 静态资源与 catch-all 路由（构建产物缺失时跳过）。"""
    dist = _frontend_dist()
    if not (dist.exists() and (dist / "index.html").exists()):
        return

    @app.get("/assets/{path:path}")
    async def _assets(path: str) -> Response:
        fp = dist / "assets" / path
        if fp.exists():
            return FileResponse(fp, headers=_LONG_CACHE)
        # 缺失的 chunk 直接 404——绝不能回退 index.html（HTML 当 JS 加载 → SyntaxError 白屏）
        return PlainTextResponse("asset not found", status_code=404)

    @app.get("/{full_path:path}")
    async def _spa(full_path: str) -> Response:
        if full_path.startswith("api/"):
            return JSONResponse({"error": "not found"}, status_code=404)
        fp = dist / full_path
        if fp.exists() and fp.is_file():
            return FileResponse(fp, headers=_NO_CACHE)
        return FileResponse(dist / "index.html", headers=_NO_CACHE)
