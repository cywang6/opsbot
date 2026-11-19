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

"""Insight 端口探测测试。"""

from __future__ import annotations

from typing import TYPE_CHECKING

from workflow_controller.web.insight import detect_insight_port

if TYPE_CHECKING:
    import pytest


async def test_detect_insight_port_does_not_search_project_directory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("WORKFLOW_CONTROLLER_INSIGHT_PORT", raising=False)
    monkeypatch.delenv("WORKFLOW_CONTROLLER_INSIGHT_DIR", raising=False)
    probed_ports: list[int] = []

    async def fake_probe_port(port: int) -> bool:
        probed_ports.append(port)
        return port == 21027

    monkeypatch.setattr("workflow_controller.web.insight._probe_insight_port", fake_probe_port)

    assert await detect_insight_port() == 21027
    assert probed_ports == [21025, 21026, 21027]
