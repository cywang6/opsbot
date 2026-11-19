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

"""Execution splitter — aggregates turns into root + subagent executions.

Port of insight's execution-split.ts.
"""

from __future__ import annotations

import re
import secrets
import time

from .types import ExecutionRow, SkillEventRow, ToolCallRow, TurnRow

_id_counter = 0


def _gen_id() -> str:
    global _id_counter
    _id_counter += 1
    return f"c{int(time.time()):x}{secrets.token_hex(4)}{_id_counter:x}"


def reset_id_counter() -> None:
    global _id_counter
    _id_counter = 0


def _window_and_latency(turns: list[TurnRow]) -> tuple[float, float, int, str]:
    """(earliest, latest, latency_ms, created_at)：created/completed 时间戳毫秒归一。"""
    from datetime import datetime

    timestamps = [t.created_at_ts for t in turns if t.created_at_ts]
    ms_ts = []
    for ts in timestamps:
        try:
            ms_ts.append(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            continue
    end_ts = []
    for t in turns:
        if t.completed_at:
            try:
                end_ts.append(
                    datetime.fromisoformat(t.completed_at.replace("Z", "+00:00")).timestamp() * 1000
                )
            except ValueError:
                continue
    earliest = min(ms_ts) if ms_ts else time.time() * 1000
    latest = (
        max(end_ts)
        if end_ts
        else (max(ms_ts) + (turns[-1].latency_ms if turns else 0) if ms_ts else time.time() * 1000)
    )
    latency = max(0, int(latest - earliest))
    created = datetime.fromtimestamp(earliest / 1000).isoformat()
    return earliest, latest, latency, created


def _aggregate(
    turns: list[TurnRow], all_tcs: list[ToolCallRow], all_ses: list[SkillEventRow]
) -> dict:
    turn_ids = {t.id for t in turns}
    tokens = sum(t.total_tokens for t in turns)
    input_tokens = sum(t.input_tokens for t in turns)
    output_tokens = sum(t.output_tokens for t in turns)
    reasoning = sum(t.reasoning_tokens for t in turns)
    cache_read = sum(t.cache_read_tokens for t in turns)
    cache_write = sum(t.cache_write_tokens for t in turns)
    cost = sum(t.cost for t in turns)
    max_single = max((t.total_tokens for t in turns), default=0)

    _, _, latency, created = _window_and_latency(turns)

    related_tcs = [tc for tc in all_tcs if tc.turn_id in turn_ids]
    related_ses = [se for se in all_ses if se.turn_id in turn_ids]

    return {
        "tokens": tokens,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "reasoning_tokens": reasoning,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_write,
        "max_single_call_tokens": max_single,
        "cost": cost,
        "latency_ms": latency,
        "created_at": created,
        "tool_call_count": len(related_tcs),
        "tool_call_error_count": sum(
            1 for tc in related_tcs if tc.state not in ("ok", "completed")
        ),
        "llm_call_count": sum(1 for t in turns if t.role == "assistant"),
        "skill_load_count": sum(1 for se in related_ses if se.event_type == "load"),
        "skill_invoke_count": sum(1 for se in related_ses if se.event_type in ("invoke", "use")),
    }


def _root_execution(
    turns: list[TurnRow],
    tool_calls: list[ToolCallRow],
    skill_events: list[SkillEventRow],
    session_id: str,
) -> tuple[str, ExecutionRow]:
    """根执行（非 subagent turns 聚合），返回 (root_id, 行)。"""
    root_turns = [t for t in turns if not t.is_subagent]
    root_id = _gen_id()
    root_agg = _aggregate(root_turns, tool_calls, skill_events)
    root_model = next((t.model for t in root_turns if t.model), None)
    root_agent = next((t.agent_name for t in root_turns if t.agent_name), None)
    root_final = root_turns[-1].content_summary if root_turns else None
    return root_id, ExecutionRow(
        id=root_id,
        session_id=session_id,
        agent_name=root_agent,
        agent_session_id=session_id,
        is_subagent=False,
        subagent_type=None,
        subagent_name=None,
        parent_execution_id=None,
        root_execution_id=root_id,
        depth=0,
        **root_agg,
        final_result=root_final,
        model=root_model,
    )


def _subagent_execution(
    sub_sid: str,
    sub_turns: list[TurnRow],
    tool_calls: list[ToolCallRow],
    skill_events: list[SkillEventRow],
    session_id: str,
    root_id: str,
) -> ExecutionRow:
    """单个子代理执行行（subagent_type 缺省时从名字推导）。"""
    sub_id = _gen_id()
    sub_agg = _aggregate(sub_turns, tool_calls, skill_events)
    sub_model = next((t.model for t in sub_turns if t.model), None)
    sub_agent = next((t.agent_name for t in sub_turns if t.agent_name), None)
    sub_name = next((t.subagent_name for t in sub_turns if t.subagent_name), None)
    sub_type = next((t.subagent_type for t in sub_turns if t.subagent_type), None)
    sub_final = sub_turns[-1].content_summary if sub_turns else None

    name_field = sub_name or sub_agent
    if not sub_type and name_field:
        m = re.match(r"^@(\w+)", name_field)
        sub_type = m.group(1) if m else name_field.lower()

    return ExecutionRow(
        id=sub_id,
        session_id=session_id,
        agent_name=sub_agent,
        agent_session_id=sub_sid,
        is_subagent=True,
        subagent_type=sub_type,
        subagent_name=name_field,
        parent_execution_id=root_id,
        root_execution_id=root_id,
        depth=1,
        **sub_agg,
        final_result=sub_final,
        model=sub_model,
    )


def split_executions(
    turns: list[TurnRow],
    tool_calls: list[ToolCallRow],
    skill_events: list[SkillEventRow],
    session_id: str,
) -> list[ExecutionRow]:
    root_id, root_row = _root_execution(turns, tool_calls, skill_events, session_id)
    executions = [root_row]

    # Subagent executions
    sub_sids: set[str] = set()
    for t in turns:
        if t.subagent_session_id:
            sub_sids.add(t.subagent_session_id)

    for sub_sid in sub_sids:
        sub_turns = [t for t in turns if t.subagent_session_id == sub_sid]
        if not sub_turns:
            continue
        executions.append(
            _subagent_execution(sub_sid, sub_turns, tool_calls, skill_events, session_id, root_id)
        )

    return executions
