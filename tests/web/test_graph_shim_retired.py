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

"""旧 /api/graph 端点退役断言：路由面不再注册任何 graph shim 端点。"""

from __future__ import annotations

from fastapi import FastAPI

from workflow_controller.web.console import register_domain_routes


def test_no_graph_shim_routes_registered() -> None:
    app = FastAPI()
    register_domain_routes(app)
    paths = {route.path for route in app.routes}
    assert not any("/api/graph" in p for p in paths), (
        f"旧 graph shim 端点残留：{sorted(p for p in paths if '/api/graph' in p)}"
    )
