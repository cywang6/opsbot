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

"""e2e CLI shim 公共件：角色哨兵、worker 场景表与回合状态。

`claude` / `opencode` 两个 CLI 替身共享「业务剧本」——角色识别哨兵、
worker 场景脚本与 `<cwd>/.workflow-controller-e2e/` 回合状态；各 shim 只自持
「参数面 + 事件流组装」（解析协议不同：stream-json 三段式 vs opencode
逐行 JSON）。新场景在本模块落一份，两个 shim 同时获得；shim 卓议与
各自 driver 解析层的对齐仍由各 shim 自己负责（`tests/e2e-shims/README.md`
场景登记表同步两边）。
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

EVALUATOR_SENTINEL = "You are a task completion evaluator"
HANDOFF_SENTINEL = "你是 handoff agent"
CONTINUATION_MARKER = "E2E-CONTINUATION"
SCENARIO_RE = re.compile(r"E2E-SCENARIO:([a-z0-9-]+)")
WRITE_RE = re.compile(r"\[E2E:WRITE:([^\]:]+):([^\]]*)\]")
DOC_RE = re.compile(r"产出交接文档 `([^`]+)`")

# 探测 prompt（auth_rotator 的 provider 冒烟 / ContextTracker 的用量探测）：
# 不是 worker 回合，不得触碰场景回合计数（E3 回滚对回合计数敏感，探测先跑
# 一轮会让 attempt 编号整体偏移）。「hi」用量探测除外——回合计数同样跳过，
# 但 usage 读数须沿当前场景（usage-unknown 场景的探测也要报无效读数，SD-08
# 的用量未知分支才能成立）。
PROBE_PROMPT = "Reply with exactly OK"
CONTEXT_PROBE_PROMPT = "hi"

# worker 探测（auth_rotator._probe_worker，read-only 沙箱探活，prompt 为
# "Reply with exactly OK. Do not use tools."）与 evaluator 判定 prompt 都可能
# 携带工具禁用后缀，worker_reply 统一按 PROBE_PROMPT 前缀匹配兜住。

# handoff-auto 场景的上报读数：input 900K / 窗口 1M（breather config.yaml
# 的 context_window 默认值）= 90% > 默认阈值 70%，驱动阈值自动交接。
HANDOFF_AUTO_USAGE = {"input_tokens": 900_000, "output_tokens": 200}
# usage-unknown 场景：input_tokens 给非法字符串，context_input_tokens 判
# 无效读数返回 None（含 ContextTracker 的探测子进程回退——探测 prompt "hi"
# 无场景标记，沿 cwd state.json 继续用本场景，同样上报无效读数）。
USAGE_UNKNOWN = {"input_tokens": "unknown"}

# graph-slow-write 场景：前 N 轮每轮 sleep 放慢（给 run 面交互留窗口），
# 之后照常 DONE；产物写入与 graph-write 同协议。
SLOW_ROUNDS = 10
SLEEP_SECONDS = 2.0


def _state_file() -> Path:
    return Path.cwd() / ".workflow-controller-e2e" / "state.json"


def _read_state() -> dict:
    try:
        data = json.loads(_state_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_state(data: dict) -> None:
    _state_file().parent.mkdir(parents=True, exist_ok=True)
    _state_file().write_text(json.dumps(data), encoding="utf-8")


def scenario_without_turn() -> str:
    """当前 cwd 的场景名（无回合上下文的探测用），缺省 pass-first。"""
    return str(_read_state().get("scenario", "pass-first"))


def record_scenario(scenario: str, turn: int) -> None:
    """tool-loop 等需专用事件组装的场景：落盘场景标记供续跑/探测分辨。"""
    _write_state({"scenario": scenario, "worker": turn})


def evaluator_reply(prompt: str) -> str:
    if "[E2E:INCOMPLETE]" in prompt:
        return json.dumps(
            {
                "is_complete": False,
                "progress": 0.4,
                "summary": "e2e: 产物未达验收标准",
                "feedback": "请继续补齐缺失产物（[E2E:INCOMPLETE] 仍存在）",
            },
            ensure_ascii=False,
        )
    return json.dumps(
        {
            "is_complete": True,
            "progress": 1.0,
            "summary": "e2e: 验收通过",
            "feedback": "",
        },
        ensure_ascii=False,
    )


def handoff_reply(prompt: str) -> str:
    match = DOC_RE.search(prompt)
    doc_name = match.group(1) if match else "handoff-doc"
    root = Path.cwd()
    (root / doc_name).write_text(
        "# E2E 交接文档\n\n确定性 shim 产出的交接内容。\n", encoding="utf-8"
    )
    done_name = doc_name[:-4] + "-done" if doc_name.endswith("-doc") else doc_name + "-done"
    (root / done_name).write_text("done\n", encoding="utf-8")
    return f"交接文档 {doc_name} 已写入 [E2E:DONE]"


def continuation_reply() -> str:
    return "已读取交接文档并完成接续 [E2E:DONE]"


def _write_directives(prompt: str, turn: int) -> None:
    for rel_path, prefix in WRITE_RE.findall(prompt):
        target = Path.cwd() / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"{prefix}{turn}", encoding="utf-8")


def _scenario_reply(scenario: str, prompt: str, turn: int) -> tuple[str, dict]:
    """场景分支的 (回复文本, usage 读数)；pass-first 与未知场景一轮完成。"""
    usage = {"input_tokens": 128, "output_tokens": 32}
    if scenario == "review-then-pass":
        if turn == 1:
            return "首轮仅产出草稿，最终产物缺失 [E2E:INCOMPLETE]", usage
        return "已按评审反馈补齐全部产物 [E2E:DONE]", usage
    if scenario == "max-iter-never":
        return f"第 {turn} 轮仍未达成验收标准 [E2E:INCOMPLETE]", usage
    if scenario == "ask-human":
        if turn == 1:
            return "存在两种可行方案，请选择继续方式？", usage
        return "已按人工指示完成 [E2E:DONE]", usage
    if scenario == "handoff-keep-running":
        # 每轮放慢 1.5s：给 UI 交互（点强制交接）留出稳定窗口，同时
        # 降低事件库写入频率；30 轮预算 ≈ 45s+ 的可交互跑道。
        time.sleep(1.5)
        return f"交接演练第 {turn} 轮，产物尚未收尾 [E2E:INCOMPLETE]", usage
    if scenario == "handoff-auto":
        # 每轮在 assistant/result 行上报高用量读数：breather 在 loop 边界
        # 读 context_usage/step_finish 事件算配比（ContextTracker），超阈值
        # 自动触发交接（无需 UI 点「强制」）。
        return f"自动交接演练第 {turn} 轮，产物尚未收尾 [E2E:INCOMPLETE]", dict(HANDOFF_AUTO_USAGE)
    if scenario == "usage-unknown":
        return f"第 {turn} 轮任务已完成 [E2E:DONE]", dict(USAGE_UNKNOWN)
    if scenario == "graph-slow-write":
        # graph 节点长跑道：前 N 轮慢速 INCOMPLETE（run 面成员级控制的
        # 交互窗口），之后 DONE；产物协议与 graph-write 一致。
        _write_directives(prompt, turn)
        if turn <= SLOW_ROUNDS:
            time.sleep(SLEEP_SECONDS)
            return f"SLOW attempt {turn} 未收尾 [E2E:INCOMPLETE]", usage
        return f"DONE attempt {turn} [E2E:DONE]", usage
    if scenario == "graph-write":
        # graph 节点产物指令：[E2E:WRITE:<相对路径>:<内容前缀>]，
        # 文件内容 = 前缀 + 回合数（验收脚本据此判定第几次尝试）。
        _write_directives(prompt, turn)
        return f"DONE attempt {turn} [E2E:DONE]", usage
    if scenario == "verify-pass":
        # graph 独立验收 agent：parse_verifier_verdict 只认独立行 PASS/FAILED。
        return "产物检查完成\nPASS", usage
    return f"第 {turn} 轮任务已完成 [E2E:DONE]", usage


def worker_reply(
    prompt: str,
    *,
    session_id: str | None = None,
    resumed: bool = False,
) -> tuple[str, dict]:
    """按场景返回 (回复文本, usage 读数)。

    session_id/resumed 仅 opencode shim 传入（claude shim 不走 --session）：
    把本轮「是否收到 --session」与所用原生会话 id 落进回合状态，供 O2 回读
    断言 resume 链路（--session 复用同一原生会话）真实跑过。回合推进本身
    靠 state.json 计数，与是否传 --session 无关——不落这个盘，resume 断掉时
    O2 的「迭代推进 + 已完成」断言照样会过。探测 prompt 在此早退、不落盘。
    """
    stripped = prompt.strip()
    if stripped.startswith(PROBE_PROMPT):
        return "OK", {"input_tokens": 128, "output_tokens": 32}
    if stripped == CONTEXT_PROBE_PROMPT:
        usage = (
            dict(USAGE_UNKNOWN)
            if scenario_without_turn() == "usage-unknown"
            else {"input_tokens": 128, "output_tokens": 32}
        )
        return "OK", usage
    data = _read_state()

    # 场景只随首轮 prompt 携带（第 2 轮起 prompt 是评估器反馈/自恢复
    # 模板，不含标记），首轮落盘后整个会话沿同一场景推进。
    match = SCENARIO_RE.search(prompt)
    if match:
        data["scenario"] = match.group(1)
    scenario = data.get("scenario", "pass-first")
    turn = int(data.get("worker", 0)) + 1
    data["worker"] = turn
    if session_id is not None:
        data["resumed"] = resumed
        data["session_id"] = session_id
    _write_state(data)
    return _scenario_reply(scenario, prompt, turn)
