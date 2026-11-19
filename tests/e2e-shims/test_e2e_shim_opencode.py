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

"""opencode shim 黑盒测试：worker 探测前缀匹配 + resume 链路落盘。

shim 是被 PATH 前置的 CLI 替身（非可导入包），这里按真实子进程方式在
临时 cwd 里跑 `opencode run`，读回它落盘的 `.workflow-controller-e2e/state.json`
断言可观测事实，与矩阵 e2e（O2 回读断言）共用同一协议。
"""

import json
import os
import subprocess
import sys
from pathlib import Path

SHIM_DIR = Path(__file__).resolve().parent
OPENCODE = SHIM_DIR / "opencode"
CLAUDE = SHIM_DIR / "claude"


def run_shim(cwd: Path, script: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(cwd),
        env=env,
    )


def read_state(cwd: Path) -> dict:
    return json.loads(
        (cwd / ".workflow-controller-e2e" / "state.json").read_text(encoding="utf-8"),
    )


def test_worker_probe_matches_prefix_without_touching_state(tmp_path: Path) -> None:
    """worker 探测（auth_rotator._probe_worker 的
    "Reply with exactly OK. Do not use tools."）仍按 PROBE_PROMPT 前缀兜住
    （删除死常量 WORKER_PROBE_PROMPT 后行为不变），且不落回合状态。
    """
    r = run_shim(tmp_path, OPENCODE, "run", "Reply with exactly OK. Do not use tools.")
    assert r.returncode == 0, r.stderr
    assert '"text": "OK"' in r.stdout
    assert not (tmp_path / ".workflow-controller-e2e" / "state.json").exists()


def test_resume_recorded_in_state(tmp_path: Path) -> None:
    """worker 回合把「是否收到 --session」与所用原生会话 id 落进 state.json，
    供 O2 回读断言 resume 链路（--session 复用同一原生会话）真实跑过。
    """
    r1 = run_shim(
        tmp_path, OPENCODE, "run", "E2E-SCENARIO:review-then-pass 请完成本用例定义的任务。"
    )
    assert r1.returncode == 0, r1.stderr
    s1 = read_state(tmp_path)
    assert s1["worker"] == 1
    assert s1["resumed"] is False
    assert isinstance(s1["session_id"], str) and s1["session_id"].startswith("ses_")

    sid = s1["session_id"]
    r2 = run_shim(tmp_path, OPENCODE, "run", "--session", sid, "请按评审反馈补齐产物。")
    assert r2.returncode == 0, r2.stderr
    s2 = read_state(tmp_path)
    assert s2["worker"] == 2
    assert s2["resumed"] is True
    assert s2["session_id"] == sid


def test_claude_shim_keeps_state_shape(tmp_path: Path) -> None:
    """claude shim 走 --resume、不传 session_id：worker_reply 默认不落
    resumed/session_id 键（共享函数签名扩展不改变 claude 侧落盘形状）。
    """
    r = run_shim(tmp_path, CLAUDE, "-p", "E2E-SCENARIO:pass-first 请完成。")
    assert r.returncode == 0, r.stderr
    state = read_state(tmp_path)
    assert state["worker"] == 1
    assert state["scenario"] == "pass-first"
    assert "resumed" not in state
    assert "session_id" not in state
