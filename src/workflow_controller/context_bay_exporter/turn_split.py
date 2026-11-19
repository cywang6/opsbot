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

"""Turn/ToolCall/SkillEvent splitter.

Port of insight's turn-split.ts. Splits RawInteraction[] into Turn rows +
ToolCall rows + SkillEvent rows. Minimal: contextWindowPct=None, no /compact
boundary handling (inputMessagesTokens uses total directly).
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import time
from datetime import UTC
from typing import TYPE_CHECKING

from .types import SkillEventRow, ToolCallRow, TurnRow

if TYPE_CHECKING:
    from workflow_controller.transcript.types import RawInteraction, ToolCallInfo

logger = logging.getLogger(__name__)

_id_counter = 0


def _gen_id() -> str:
    global _id_counter
    _id_counter += 1
    return f"c{int(time.time()):x}{secrets.token_hex(4)}{_id_counter:x}"


def reset_id_counter() -> None:
    global _id_counter
    _id_counter = 0


def _trunc200(text: str | None) -> str | None:
    if not text:
        return None
    return text[:200] if len(text) > 200 else text


def _is_skill_tool(tool_name: str) -> bool:
    lower = tool_name.lower()
    return lower.startswith("skill/") or lower == "skill" or lower == "load_skill"


def _skill_event_type(tool_name: str) -> str:
    lower = tool_name.lower()
    if lower in ("skill/load_skill", "load_skill"):
        return "load"
    if lower in ("skill/invoke", "skill"):
        return "invoke"
    return "use"


def _extract_skill_name(tool_name: str, args_json: str | None) -> str:
    if not args_json:
        return re.sub(r"^skill/", "", tool_name, flags=re.IGNORECASE)
    try:
        args = json.loads(args_json)
        return (
            args.get("skill")
            or args.get("skill_name")
            or args.get("name")
            or re.sub(r"^skill/", "", tool_name, flags=re.IGNORECASE)
        )
    except Exception:
        return re.sub(r"^skill/", "", tool_name, flags=re.IGNORECASE)


def _extract_skill_version(args_json: str | None) -> int | None:
    if not args_json:
        return None
    try:
        args = json.loads(args_json)
        if isinstance(args.get("version"), int):
            return args["version"]
    except Exception:
        logger.debug("skill version 提取失败，按未标注处理")
    return None


def _is_agent_skill_dispatch(tool_name: str, args_json: str | None) -> bool:
    lower = tool_name.lower()
    if lower not in ("agent", "task"):
        return False
    if not args_json:
        return False
    try:
        args = json.loads(args_json)
        st = args.get("subagent_type") or args.get("subagent_name")
        if not st:
            return False
        return st not in ("general-purpose", "general")
    except Exception:
        return False


def _extract_dispatch_skill_name(args_json: str | None) -> str:
    if not args_json:
        return "unknown-dispatch"
    try:
        args = json.loads(args_json)
        st = args.get("subagent_type") or args.get("subagent_name")
        if st:
            return st
        if args.get("description"):
            return str(args["description"])[:40]
    except Exception:
        logger.debug("dispatch skill 名提取失败，按未知处理")
    return "unknown-dispatch"


def _extract_error_msg(result_json: str | None) -> str | None:
    if not result_json:
        return None
    if "<tool_use_error>" in result_json:
        return _trunc200(result_json)
    if "Exit code" in result_json:
        return _trunc200("Command failed: " + result_json)
    return None


def _classify_error(state: str, err_msg: str | None) -> str | None:
    if state in ("ok", "completed"):
        return "tool_error" if err_msg else None
    if not err_msg:
        return "unknown"
    msg = err_msg.lower()
    if "timeout" in msg or "timed out" in msg:
        return "timeout"
    if "permission" in msg or "denied" in msg or "forbidden" in msg:
        return "permission"
    if "format" in msg or "invalid" in msg or "parse" in msg:
        return "format"
    return "server_error"


def _count_input_messages(
    interactions: list[RawInteraction], i: int, my_sub_sid: str | None
) -> int:
    """同上下文先前消息计数（minimal 版：只跳过 compaction-boundary）。"""
    count = 0
    for j in range(i):
        prev = interactions[j]
        prev_role = "assistant" if prev.role == "subagent" else prev.role
        if prev.agent == "compaction-boundary":
            continue
        if my_sub_sid:
            if prev.subagent_session_id == my_sub_sid and prev_role in (
                "user",
                "assistant",
                "system",
            ):
                count += 1
        else:
            if not prev.subagent_session_id and prev_role in (
                "user",
                "assistant",
                "system",
            ):
                count += 1
    return count


def _turn_timing(it: RawInteraction) -> tuple[str, str | None, int]:
    """(created_ts, completed_at, latency_ms)；created 缺省回落行时间戳。"""
    from datetime import datetime

    time_info = it.time_info or {"created": 0}
    created_ts = (
        datetime.fromtimestamp(time_info["created"] / 1000, tz=UTC).isoformat()
        if time_info.get("created")
        else it.timestamp
    )
    completed_at = None
    if time_info.get("completed"):
        completed_at = datetime.fromtimestamp(time_info["completed"] / 1000, tz=UTC).isoformat()
    latency_ms = 0
    if time_info.get("completed") and time_info.get("created"):
        latency_ms = int(time_info["completed"] - time_info["created"])
    elif it.latency is not None:
        latency_ms = int(it.latency)
    return created_ts, completed_at, latency_ms


def _build_turn_row(
    it: RawInteraction,
    session_id: str,
    index: int,
    input_msgs: tuple[int, int],
) -> TurnRow:
    """单条 interaction → Turn 行（token/时间/子代理字段在此归一）。"""
    usage = it.usage
    role = "assistant" if it.role == "subagent" else it.role
    created_ts, completed_at, latency_ms = _turn_timing(it)
    return TurnRow(
        id=_gen_id(),
        session_id=session_id,
        turn_index=index,
        role=role,
        content=it.content,
        content_json=None,
        content_summary=_trunc200(it.content),
        input_messages_json=None,
        input_messages_count=input_msgs[0],
        input_messages_tokens=input_msgs[1],
        context_window_pct=None,
        agent_name=it.agent or it.subagent_name,
        subagent_name=it.subagent_name,
        subagent_session_id=it.subagent_session_id,
        subagent_type=it.subagent_type,
        total_tokens=usage.total if usage else 0,
        input_tokens=usage.input if usage else 0,
        output_tokens=usage.output if usage else 0,
        reasoning_tokens=usage.reasoning if usage else 0,
        cache_read_tokens=usage.cache_read if usage else 0,
        cache_write_tokens=usage.cache_write if usage else 0,
        cost=usage.cost if usage else 0,
        created_at_ts=created_ts,
        completed_at=completed_at,
        latency_ms=latency_ms,
        ttft_ms=None,
        model=it.model,
        model_id=it.model_id,
        provider_id=it.provider_id,
        temperature=None,
        max_tokens=None,
        finish_reason=it.finish_reason,
        is_subagent=bool(it.subagent_session_id),
        parent_execution_id=None,
    )


def _skill_event_row(tc: ToolCallInfo, turn: TurnRow, err_msg: str | None) -> SkillEventRow:
    """skill 相关 tool call → SkillEvent 行（dispatch 类事件在此判别）。"""
    is_dispatch = _is_agent_skill_dispatch(tc.tool_name, tc.args_json)
    event_type = "dispatch" if is_dispatch else _skill_event_type(tc.tool_name)
    skill_name = (
        _extract_dispatch_skill_name(tc.args_json)
        if is_dispatch
        else _extract_skill_name(tc.tool_name, tc.args_json)
    )
    skill_ver = None if is_dispatch else _extract_skill_version(tc.args_json)
    success = tc.state in ("ok", "completed") and not err_msg
    return SkillEventRow(
        id=_gen_id(),
        turn_id=turn.id,
        skill_name=skill_name,
        skill_version=skill_ver,
        event_type=event_type,
        success=success,
        error_message=None if success else (err_msg or tc.state),
        args_json=tc.args_json,
        started_at=turn.created_at_ts,
        completed_at=turn.completed_at or turn.created_at_ts,
        duration_ms=0,
    )


def _split_tool_calls(
    it: RawInteraction,
    turn: TurnRow,
) -> tuple[list[ToolCallRow], list[SkillEventRow]]:
    """单条 interaction → ToolCall 行与 SkillEvent 行（顺序与源 tool_calls 一致）。"""
    tc_rows: list[ToolCallRow] = []
    se_rows: list[SkillEventRow] = []
    for tc in it.tool_calls or []:
        tc_id = _gen_id()
        is_skill = _is_skill_tool(tc.tool_name) or _is_agent_skill_dispatch(
            tc.tool_name, tc.args_json
        )
        err_msg = _extract_error_msg(tc.result_json)
        tc_rows.append(
            ToolCallRow(
                id=tc_id,
                turn_id=turn.id,
                tool_call_id=tc.tool_call_id,
                tool_name=tc.tool_name,
                args_json=tc.args_json,
                result_json=tc.result_json,
                state=tc.state,
                error_type=_classify_error(tc.state, err_msg),
                error_message=err_msg,
                started_at=turn.created_at_ts,
                completed_at=turn.completed_at or turn.created_at_ts,
                duration_ms=0,
                dispatch_bridge_id=None,
                is_skill_related=is_skill,
            )
        )
        if is_skill:
            se_rows.append(_skill_event_row(tc, turn, err_msg))
    return tc_rows, se_rows


def split_into_turns(
    interactions: list[RawInteraction],
    session_id: str,
) -> tuple[list[TurnRow], list[ToolCallRow], list[SkillEventRow]]:
    turns: list[TurnRow] = []
    tool_calls: list[ToolCallRow] = []
    skill_events: list[SkillEventRow] = []

    for i, it in enumerate(interactions):
        role = "assistant" if it.role == "subagent" else it.role
        usage = it.usage
        total_tokens = usage.total if usage else 0

        # Minimal: input_messages_count = count prior turns in same context
        input_msgs_count = 0
        input_msgs_tokens = 0
        if role == "assistant":
            input_msgs_count = _count_input_messages(interactions, i, it.subagent_session_id)
            # Minimal: use total tokens as input msgs tokens (skip compact handling)
            adapter_input = usage.input_messages_tokens if usage else 0
            input_msgs_tokens = total_tokens if total_tokens > 0 else adapter_input

        turn = _build_turn_row(it, session_id, i, (input_msgs_count, input_msgs_tokens))
        turns.append(turn)
        new_tcs, new_ses = _split_tool_calls(it, turn)
        tool_calls.extend(new_tcs)
        skill_events.extend(new_ses)

    return turns, tool_calls, skill_events
