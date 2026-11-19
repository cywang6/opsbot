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

"""Breather 模板上传只写入启动目录，并返回可用于配置的绝对路径。"""

from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from workflow_controller.api.plugin_api import PluginAPI
from workflow_controller.plugins.breather.group_handoff import GROUP_HANDOFF_PROMPT, GroupHandoff
from workflow_controller.plugins.breather.handoff import (
    HANDOFF_AGENT_PROMPT,
    RESUME_PROMPT,
    HandoffGenerator,
)
from workflow_controller.plugins.breather.plugin import BreatherPlugin
from workflow_controller.web.routes.plugins_routes import router


def _template_client(monkeypatch, tmp_path) -> TestClient:
    """chdir 到临时目录并挂载 plugins_routes 的测试客户端。"""
    monkeypatch.chdir(tmp_path)
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    return TestClient(app)


def test_upload_template_to_startup_directory(tmp_path, monkeypatch) -> None:
    client = _template_client(monkeypatch, tmp_path)

    response = client.post(
        "/api/v1/plugins/breather/template?filename=handoff.md",
        content="交接说明".encode(),
    )

    assert response.status_code == 200
    assert response.json() == {"path": str(tmp_path / "handoff.md")}
    assert (tmp_path / "handoff.md").read_text() == "交接说明"
    assert (
        client.post(
            "/api/v1/plugins/breather/template?filename=handoff.md", content=b"new"
        ).status_code
        == 200
    )
    assert (tmp_path / "handoff.md").read_text() == "new"
    assert (
        client.post(
            "/api/v1/plugins/breather/template?filename=..%2Fescape.md", content=b"x"
        ).status_code
        == 400
    )
    assert (
        client.post("/api/v1/plugins/breather/template?filename=bad.pdf", content=b"x").status_code
        == 400
    )
    assert (
        client.post(
            "/api/v1/plugins/breather/template?filename=bad.txt", content=b"\xff"
        ).status_code
        == 400
    )


def test_upload_template_accepts_10_mib_and_rejects_larger_file(tmp_path, monkeypatch) -> None:
    client = _template_client(monkeypatch, tmp_path)

    limit = 10 * 1024 * 1024
    accepted = client.post(
        "/api/v1/plugins/breather/template?filename=limit.md", content=b"a" * limit
    )
    assert accepted.status_code == 200
    assert (tmp_path / "limit.md").stat().st_size == limit

    rejected = client.post(
        "/api/v1/plugins/breather/template?filename=too-large.txt", content=b"a" * (limit + 1)
    )
    assert rejected.status_code == 400
    assert "10 MiB" in rejected.json()["detail"]
    assert not (tmp_path / "too-large.txt").exists()


def _download_builtin_pair(client: TestClient) -> tuple:
    """下载 handoff/continuation 两份内置指令，断言下载头形态。"""
    handoff = client.get("/api/v1/plugins/breather/builtin-instructions/handoff")
    continuation = client.get("/api/v1/plugins/breather/builtin-instructions/continuation")
    assert handoff.status_code == continuation.status_code == 200
    assert (
        handoff.headers["content-disposition"]
        == 'attachment; filename="workflow-handoff-instructions.md"'
    )
    assert (
        continuation.headers["content-disposition"]
        == 'attachment; filename="workflow-continuation-instructions.md"'
    )
    return handoff, continuation


def _assert_builtin_instruction_content(handoff, continuation) -> None:
    """内置指令内容形态：分段标记、编辑说明与三段内置 prompt 全文。"""
    assert "<!-- workflow:main -->" in handoff.text
    assert "<!-- workflow:group -->" in handoff.text
    assert "主代理如何交接自己的工作" in handoff.text
    assert "每名子代理如何交接自己的工作" in handoff.text
    assert "交接文档名称由系统按会话 ID 和轮次生成" in handoff.text
    assert HANDOFF_AGENT_PROMPT.strip() in handoff.text
    assert GROUP_HANDOFF_PROMPT in handoff.text
    assert continuation.text == RESUME_PROMPT


def test_downloaded_builtin_instructions_can_be_uploaded_without_duplicate_group_rules(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "workflow_controller.web.routes.plugins_routes.get_core_api",
        lambda _request: SimpleNamespace(
            plugin=PluginAPI(
                SimpleNamespace(
                    discover_plugins=lambda: [
                        (SimpleNamespace(name="breather", enabled=False), None, BreatherPlugin)
                    ],
                )
            )
        ),
    )
    client = _template_client(monkeypatch, tmp_path)
    handoff, continuation = _download_builtin_pair(client)
    _assert_builtin_instruction_content(handoff, continuation)
    assert client.get("/api/v1/plugins/breather/builtin-instructions/unknown").status_code == 404

    uploaded = client.post(
        "/api/v1/plugins/breather/template?filename=workflow-handoff-instructions.md",
        content=handoff.content,
    )
    assert uploaded.status_code == 200
    path = uploaded.json()["path"]
    main = getattr(
        HandoffGenerator(skill="handoff", handoff_filename="handoff.md", handoff_prompt_path=path),
        "_load_template",
    )(str(tmp_path))
    session = SimpleNamespace(
        config=SimpleNamespace(
            cwd=str(tmp_path), handoff_prompt_path=path, group_handoff_prompt_path=None
        )
    )
    plugin = SimpleNamespace(_cfg=lambda key, default=None: default)
    group = getattr(GroupHandoff(plugin), "_prompt_template")(session)
    assert HANDOFF_AGENT_PROMPT.strip() in main
    assert GROUP_HANDOFF_PROMPT not in main
    assert group.count(GROUP_HANDOFF_PROMPT) == 1
    assert (
        getattr(GroupHandoff(plugin), "_prompt_template")(session, main_over=True).count(
            GROUP_HANDOFF_PROMPT
        )
        == 1
    )
