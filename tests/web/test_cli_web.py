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

"""CLI web 的 Insight 启动行为与 web 模式日志测试。"""

from __future__ import annotations

import os
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

import pytest
from click.testing import CliRunner

if TYPE_CHECKING:
    from pathlib import Path


def _prepare_web_cli(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """准备 Web CLI 测试并记录子进程参数。"""
    monkeypatch.setenv("WORKFLOW_CONTROLLER_INSIGHT_PORT", "")
    monkeypatch.setenv("WORKFLOW_CONTROLLER_LOG_LEVEL", "INFO")
    monkeypatch.delenv("CANNBOT_NO_BROWSER", raising=False)
    monkeypatch.setattr(
        "workflow_controller.web.cli._WorkflowControllerServer.run",
        lambda self, sockets=None: None,
    )
    monkeypatch.setattr(
        "threading.Timer",
        lambda *args, **kwargs: SimpleNamespace(start=lambda: None),
    )
    launched: list[dict[str, Any]] = []

    def fake_popen(*args: object, **kwargs: object) -> object:
        launched.append({"command": args[0], **kwargs})
        return SimpleNamespace(pid=12345, poll=lambda: 0)

    monkeypatch.setattr("subprocess.Popen", fake_popen)
    return launched


@pytest.mark.parametrize("no_open", [False, True])
def test_cmd_web_starts_default_insight(monkeypatch: pytest.MonkeyPatch, no_open: bool) -> None:
    launched = _prepare_web_cli(monkeypatch)

    from workflow_controller.__main__ import cli

    args = ["web", "--insight", "--insight-port", "21877"]
    if no_open:
        args.append("--no-open")
    result = CliRunner().invoke(cli, args)

    assert result.exit_code == 0, result.output
    assert len(launched) == 1
    assert launched[0]["command"] == ["cannbot-insight"]
    assert launched[0]["cwd"] is None
    env = launched[0]["env"]
    assert env["PORT"] == "21877"
    assert env["BASE_PORT"] == "21877"
    assert env["CANNBOT_INSIGHT_PORT"] == "21877"
    assert env["CONTEXT_INSIGHT_PORT"] == "21877"
    assert env.get("CANNBOT_NO_BROWSER") == ("1" if no_open else None)
    assert os.environ["WORKFLOW_CONTROLLER_INSIGHT_PORT"] == "21877"


def test_cmd_web_starts_local_insight_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launched = _prepare_web_cli(monkeypatch)
    package_dir = tmp_path / "node_modules" / "custom-insight"
    package_dir.mkdir(parents=True)
    command_path = tmp_path / "node_modules" / ".bin" / "custom-insight"

    from workflow_controller.__main__ import cli

    result = CliRunner().invoke(
        cli,
        ["web", "--insight", str(command_path), "--insight-port", "21878", "--no-open"],
    )

    assert result.exit_code == 0, result.output
    assert launched[0]["command"] == [str(command_path.resolve())]
    assert launched[0]["cwd"] == package_dir.resolve()
    env = launched[0]["env"]
    assert env["PORT"] == "21878"
    assert env["BASE_PORT"] == "21878"
    assert env["CANNBOT_INSIGHT_PORT"] == "21878"
    assert env["CONTEXT_INSIGHT_PORT"] == "21878"
    assert env["CANNBOT_NO_BROWSER"] == "1"
    assert env["NODE_PATH"] == str(package_dir.parent)


def test_cmd_web_writes_workflow_controller_log(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    # Don't actually serve — just let cmd_web reach past setup. cmd_web drives
    # uvicorn.Server.run directly (not uvicorn.run), so stub the Server.run
    # bound method on our _WorkflowControllerServer subclass.
    monkeypatch.setattr(
        "workflow_controller.web.cli._WorkflowControllerServer.run",
        lambda self, sockets=None: None,
    )

    from workflow_controller.__main__ import cli

    with monkeypatch.context() as command_environment:
        command_environment.setenv("WORKFLOW_CONTROLLER_LOG_LEVEL", "before-command")
        result = CliRunner().invoke(cli, ["web", "--no-open"])
    assert result.exit_code == 0, result.output

    log = tmp_path / ".workflow-controller" / "workflow-controller.log"
    assert log.exists(), "web 模式也要写 workflow-controller.log，让用户能打开搜关键字"
