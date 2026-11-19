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

"""InteractionBridge builder — links dispatch tool calls to subagent responses.

Port of insight's bridge-builder.ts.
"""

from __future__ import annotations

import json
import re
import secrets
import time
from datetime import datetime
from typing import TYPE_CHECKING, Any

from .types import InteractionBridgeRow, ToolCallRow, TurnRow

if TYPE_CHECKING:
    from workflow_controller.transcript.types import RawInteraction

_id_counter = 0
TIMEOUT_MS = 30 * 60 * 1000


def _gen_id() -> str:
    global _id_counter
    _id_counter += 1
    return f"c{int(time.time()):x}{secrets.token_hex(4)}{_id_counter:x}"


def reset_id_counter() -> None:
    global _id_counter
    _id_counter = 0


def _parse_task_args(args_json: str | None, tool_name: str = "") -> dict:
    if not args_json:
        return {}
    try:
        args = json.loads(args_json)
        if tool_name == "Agent":
            return {
                "subagent_session_id": args.get("subagent_session_id"),
                "subagent_name": args.get("name") or args.get("subagent_name"),
                "subagent_type": args.get("subagent_type") or args.get("mode"),
                "summary": args.get("description"),
                "description": args.get("description"),
                "prompt": args.get("prompt"),
            }
        return args
    except Exception:
        return {}


def _extract_sid_from_result(result_json: str | None) -> str | None:
    if not result_json:
        return None
    m = re.search(r"task_id:\s*(\S+)", result_json)
    return m.group(1) if m else None


def _is_subagent_error(turn: TurnRow) -> bool:
    return turn.finish_reason in ("error", "failed")


def _to_ms(ts: str | None) -> float:
    if not ts:
        return 0
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return 0


def _match_dispatch_sid(
    dtc: ToolCallRow,
    args: dict[str, Any],
    tool_use_id_to_subagent_sid: dict[str, str] | None,
    sub_interactions: dict[str, list[RawInteraction]],
    used_sids: set[str],
) -> str | None:
    """按 args → toolUseId 映射 → result 文本 → 最近时间四段匹配子代理会话 id。"""
    matched_sid = args.get("subagent_session_id")

    if not matched_sid and dtc.tool_name == "Agent" and tool_use_id_to_subagent_sid:
        matched_sid = tool_use_id_to_subagent_sid.get(dtc.tool_call_id)

    if not matched_sid:
        matched_sid = _extract_sid_from_result(dtc.result_json)

    if not matched_sid:
        # Closest by time
        dispatch_time = _to_ms(dtc.started_at)
        closest_sid = None
        closest_diff = float("inf")
        for sid, subs in sub_interactions.items():
            if sid in used_sids:
                continue
            first_time = subs[0].time_info.get("created", 0) if subs[0].time_info else 0
            diff = abs(first_time - dispatch_time)
            if diff < closest_diff:
                closest_diff = diff
                closest_sid = sid
        if closest_sid and closest_diff < TIMEOUT_MS:
            matched_sid = closest_sid
    return matched_sid


def _dispatch_content(args: dict[str, Any]) -> str | None:
    return args.get("summary") or args.get("description") or args.get("prompt")


def _append_completed_bridge(
    bridges: list[InteractionBridgeRow],
    session_id: str,
    root_execution_id: str,
    dtc: ToolCallRow,
    args: dict[str, Any],
    matched_sid: str,
    sts: list[TurnRow],
) -> None:
    """有回执的派发：按子代理 turn 组装 completed/failed 桥接行。"""
    last = sts[-1]
    subagent_name = args.get("subagent_name")
    sub_tokens = sum(t.total_tokens for t in sts)
    first_sub_time = _to_ms(sts[0].created_at_ts)
    last_sub_time = _to_ms(last.completed_at)
    dispatch_time_ms = _to_ms(dtc.started_at)
    sub_latency = (
        max(0, int(last_sub_time - min(dispatch_time_ms, first_sub_time)))
        if last_sub_time and first_sub_time
        else 0
    )
    has_error = any(_is_subagent_error(t) for t in sts)
    status = "failed" if has_error else "completed"
    bridges.append(
        InteractionBridgeRow(
            id=_gen_id(),
            session_id=session_id,
            dispatch_execution_id=root_execution_id,
            dispatch_turn_id=dtc.turn_id,
            dispatch_tool_call_id=dtc.id,
            dispatch_content=_dispatch_content(args),
            dispatch_timestamp=dtc.started_at,
            response_execution_id=None,
            response_turn_id=last.id,
            response_content=last.content,
            response_timestamp=last.completed_at,
            subagent_session_id=matched_sid,
            subagent_type=args.get("subagent_type"),
            subagent_name=subagent_name or last.subagent_name,
            status=status,
            subagent_tokens=sub_tokens,
            subagent_latency_ms=sub_latency,
        )
    )


def _append_open_bridge(
    bridges: list[InteractionBridgeRow],
    session_id: str,
    root_execution_id: str,
    dtc: ToolCallRow,
    args: dict[str, Any],
    subagent_sid: str | None,
) -> None:
    """无回执派发的桥接行：按耗时判 timeout/dispatched。"""
    elapsed = time.time() * 1000 - _to_ms(dtc.started_at)
    bridges.append(
        InteractionBridgeRow(
            id=_gen_id(),
            session_id=session_id,
            dispatch_execution_id=root_execution_id,
            dispatch_turn_id=dtc.turn_id,
            dispatch_tool_call_id=dtc.id,
            dispatch_content=_dispatch_content(args),
            dispatch_timestamp=dtc.started_at,
            subagent_session_id=subagent_sid,
            subagent_type=args.get("subagent_type"),
            subagent_name=args.get("subagent_name"),
            status="timeout" if elapsed > TIMEOUT_MS else "dispatched",
        )
    )


def build_bridges(
    interactions: list[RawInteraction],
    tool_calls: list[ToolCallRow],
    turns: list[TurnRow],
    session_id: str,
    root_execution_id: str,
    tool_use_id_to_subagent_sid: dict[str, str] | None = None,
) -> list[InteractionBridgeRow]:
    bridges: list[InteractionBridgeRow] = []

    dispatch_tcs = [tc for tc in tool_calls if tc.tool_name in ("task", "Agent")]

    # Map subagent_session_id → interactions
    sub_interactions: dict[str, list[RawInteraction]] = {}
    for it in interactions:
        sid = it.subagent_session_id
        if sid:
            sub_interactions.setdefault(sid, []).append(it)

    # Map subagent_session_id → turns
    sub_turns: dict[str, list[TurnRow]] = {}
    for t in turns:
        if t.subagent_session_id:
            sub_turns.setdefault(t.subagent_session_id, []).append(t)

    used_sids: set[str] = set()

    for dtc in dispatch_tcs:
        args = _parse_task_args(dtc.args_json, dtc.tool_name)
        matched_sid = _match_dispatch_sid(
            dtc, args, tool_use_id_to_subagent_sid, sub_interactions, used_sids
        )

        if matched_sid:
            used_sids.add(matched_sid)
            sts = sub_turns.get(matched_sid, [])
            if sts:
                _append_completed_bridge(
                    bridges, session_id, root_execution_id, dtc, args, matched_sid, sts
                )
            else:
                _append_open_bridge(bridges, session_id, root_execution_id, dtc, args, matched_sid)
        else:
            _append_open_bridge(bridges, session_id, root_execution_id, dtc, args, None)

    return bridges
