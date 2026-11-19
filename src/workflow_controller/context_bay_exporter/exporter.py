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

"""领域导出流程：转录会话 → cannbot-insight 7 表 SQLite .db。

最小流程：read_session → normalize → split_into_turns → split_executions
→ build_bridges → 聚合 → 写 7 表 .db。
"""

from __future__ import annotations

import secrets
import sqlite3
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from workflow_controller.transcript import claude_jsonl, opencode_db
from workflow_controller.transcript.types import RawInteraction, SessionMeta, TokenUsage

from .bridge_builder import build_bridges
from .bridge_builder import reset_id_counter as reset_bridge_ids
from .execution_split import reset_id_counter as reset_exec_ids
from .execution_split import split_executions
from .schema import create_tables
from .turn_split import reset_id_counter as reset_turn_ids
from .turn_split import split_into_turns
from .types import (
    ExecutionRow,
    ExecutionSkillRow,
    InteractionBridgeRow,
    SessionSkillRow,
    SkillEventRow,
    ToolCallRow,
    TurnRow,
)


def _to_iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _normalize(interactions: list[RawInteraction]) -> list[RawInteraction]:
    """Inline normalize: fill defaults, validate timestamps."""
    result = []
    for raw in interactions:
        role = raw.role or "unknown"
        ts = raw.timestamp
        if not ts or not _is_valid_iso(ts):
            ts = datetime.fromtimestamp(0, tz=UTC).isoformat()
        time_info = (
            raw.time_info if (raw.time_info and raw.time_info.get("created")) else {"created": 0}
        )
        usage = None
        if raw.usage:
            usage = TokenUsage(
                total=raw.usage.total or 0,
                input=raw.usage.input or 0,
                output=raw.usage.output or 0,
                reasoning=raw.usage.reasoning or 0,
                cache_read=raw.usage.cache_read or 0,
                cache_write=raw.usage.cache_write or 0,
                cost=raw.usage.cost or 0,
                input_messages_tokens=raw.usage.input_messages_tokens or 0,
            )
        result.append(
            RawInteraction(
                role=role,
                content=raw.content,
                timestamp=ts,
                time_info=time_info,
                agent=raw.agent,
                subagent_name=raw.subagent_name,
                subagent_session_id=raw.subagent_session_id,
                subagent_type=raw.subagent_type,
                tool_calls=raw.tool_calls,
                usage=usage,
                model=raw.model,
                model_id=raw.model_id,
                provider_id=raw.provider_id,
                latency=raw.latency,
                finish_reason=raw.finish_reason,
            )
        )
    return result


def _is_valid_iso(ts: str) -> bool:
    import re

    return bool(re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", ts))


def _latest_end_time(turns: list[TurnRow]) -> datetime | None:
    """completed/created 时间戳中最晚的结束时间（无效值跳过）。"""
    end_time: datetime | None = None
    for t in turns:
        ts = t.completed_at or t.created_at_ts
        if not ts:
            continue
        try:
            d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            continue
        if not end_time or d > end_time:
            end_time = d
    return end_time


def _compute_session_aggregates(
    turns: list[TurnRow],
    tool_calls: list[ToolCallRow],
    skill_events: list[SkillEventRow],
) -> dict:
    total_tokens = sum(t.total_tokens for t in turns)
    total_input = sum(t.input_tokens for t in turns)
    total_output = sum(t.output_tokens for t in turns)
    total_reasoning = sum(t.reasoning_tokens for t in turns)
    total_cache_read = sum(t.cache_read_tokens for t in turns)
    total_cache_write = sum(t.cache_write_tokens for t in turns)
    total_cost = sum(t.cost for t in turns)
    total_latency = sum(t.latency_ms for t in turns if t.role == "assistant")
    llm_calls = sum(1 for t in turns if t.role == "assistant" and t.total_tokens > 0)

    start_time = (
        datetime.fromisoformat(turns[0].created_at_ts.replace("Z", "+00:00"))
        if turns and turns[0].created_at_ts
        else datetime.now(UTC)
    )
    end_time = _latest_end_time(turns)

    model = None
    for t in turns:
        if t.role == "assistant" and t.model:
            model = t.model
            break

    sub_ids = {t.subagent_session_id for t in turns if t.is_subagent and t.subagent_session_id}

    return {
        "totalTokens": total_tokens,
        "totalInputTokens": total_input,
        "totalOutputTokens": total_output,
        "totalReasoningTokens": total_reasoning,
        "totalCacheReadTokens": total_cache_read,
        "totalCacheWriteTokens": total_cache_write,
        "totalCost": total_cost,
        "totalLatencyMs": total_latency,
        "totalToolCallCount": len(tool_calls),
        "totalLlmCallCount": llm_calls,
        "totalSkillLoadCount": len(skill_events),
        "totalSubagentCount": len(sub_ids),
        "startTime": start_time,
        "endTime": end_time,
        "model": model,
    }


def _compute_execution_skills(
    executions: list[ExecutionRow],
    turns: list[TurnRow],
    skill_events: list[SkillEventRow],
) -> dict[str, list[ExecutionSkillRow]]:
    result: dict[str, list[ExecutionSkillRow]] = {}
    for ex in executions:
        if ex.is_subagent:
            ex_turns = [t for t in turns if t.subagent_session_id == ex.agent_session_id]
        else:
            ex_turns = [t for t in turns if not t.is_subagent]
        ex_turn_ids = {t.id for t in ex_turns}
        ex_ses = [se for se in skill_events if se.turn_id in ex_turn_ids]
        names: list[str] = []
        for se in ex_ses:
            if se.skill_name not in names:
                names.append(se.skill_name)
        skills: list[ExecutionSkillRow] = []
        for name in names:
            load_ev = next(
                (se for se in ex_ses if se.skill_name == name and se.event_type == "load"), None
            )
            skills.append(
                ExecutionSkillRow(
                    id=f"es{secrets.token_hex(6)}",
                    execution_id=ex.id,
                    skill_name=name,
                    skill_version=load_ev.skill_version if load_ev else None,
                    is_primary=False,
                    user=None,
                    created_at=datetime.now(UTC).isoformat(),
                )
            )
        result[ex.id] = skills
    return result


def _compute_skill_rows(
    executions: list[ExecutionRow],
    turns: list[TurnRow],
    skill_events: list[SkillEventRow],
    session_id: str,
) -> tuple[list[ExecutionSkillRow], list[SessionSkillRow]]:
    """Execution skills 展平 + session skills 汇总。"""
    exec_skills_map = _compute_execution_skills(executions, turns, skill_events)
    exec_skill_rows: list[ExecutionSkillRow] = []
    for rows in exec_skills_map.values():
        exec_skill_rows.extend(rows)

    unique_skill_names: list[str] = []
    for se in skill_events:
        if se.skill_name not in unique_skill_names:
            unique_skill_names.append(se.skill_name)
    session_skills: list[SessionSkillRow] = []
    for name in unique_skill_names:
        inv_count = sum(
            1 for se in skill_events if se.skill_name == name and se.event_type in ("invoke", "use")
        )
        load_ev = next(
            (se for se in skill_events if se.skill_name == name and se.event_type == "load"), None
        )
        session_skills.append(
            SessionSkillRow(
                id=f"ss{secrets.token_hex(6)}",
                session_id=session_id,
                skill_name=name,
                skill_version=load_ev.skill_version if load_ev else None,
                invocation_count=inv_count,
                created_at=datetime.now(UTC).isoformat(),
            )
        )
    return exec_skill_rows, session_skills


def _read_source_session(
    source_type: str,
    source_path: str,
    session_id: str,
) -> tuple[list[RawInteraction], SessionMeta, dict[str, str] | None, str]:
    """读源会话（含子代理）→ (interactions, meta, toolUseId 映射, framework)。"""
    if source_type == "opencode-db":
        adapter = opencode_db
    elif source_type == "claude-jsonl":
        adapter = claude_jsonl
    else:
        raise ValueError(f"Unknown source type: {source_type}")
    framework = "opencode" if source_type == "opencode-db" else "claude-code"
    session_meta = SessionMeta()
    tool_use_mappings: dict[str, str] | None = None

    # 1. Read source session
    if source_type == "opencode-db":
        import sqlite3 as _sql

        db = _sql.connect(f"file:{source_path}?mode=ro", uri=True)
        db.row_factory = _sql.Row
        try:
            raw_interactions = adapter.read_session(db, session_id)
            session_meta = adapter.read_session_meta(db, session_id)
            # Recursively read subagent sessions
            sub_ids = adapter.list_subagent_sessions(db, session_id)
            all_interactions = list(raw_interactions)
            for sub_id in sub_ids:
                sub_ints = adapter.read_session(db, sub_id)
                all_interactions.extend(sub_ints)
        finally:
            db.close()
    else:
        # claude-jsonl
        raw_interactions = adapter.read_session(source_path, session_id)
        all_interactions = list(raw_interactions)
        # Subagent files
        subs = adapter.list_subagent_sessions(source_path, session_id)
        for sub_id, sub_file in subs:
            sub_ints = adapter.read_session(sub_file, sub_id)
            for si in sub_ints:
                si.subagent_session_id = sub_id
            all_interactions.extend(sub_ints)
        tool_use_mappings = adapter.collect_tool_use_mappings(source_path, session_id)

    if not all_interactions:
        raise ValueError(f"No interactions found for session {session_id} in {source_path}")
    return all_interactions, session_meta, tool_use_mappings, framework


@dataclass
class _ContextBayPayload:
    """建库阶段共享状态：源会话读取、拆分与聚合的全部行集与元数据。

    各阶段函数（拆分 / 聚合 / 技能行 / 落库）读写同一对象，替代在阶段间
    传递多返回值大元组。
    """

    session_id: str
    source_path: str
    framework: str
    session_meta: SessionMeta
    all_interactions: list[RawInteraction]
    turns: list[TurnRow] = field(default_factory=list)
    tool_calls: list[ToolCallRow] = field(default_factory=list)
    skill_events: list[SkillEventRow] = field(default_factory=list)
    executions: list[ExecutionRow] = field(default_factory=list)
    root_exec_id: str | None = None
    bridges: list[InteractionBridgeRow] = field(default_factory=list)
    agg: dict[str, Any] = field(default_factory=dict)
    exec_skill_rows: list[ExecutionSkillRow] = field(default_factory=list)
    session_skills: list[SessionSkillRow] = field(default_factory=list)


def _split_rows(payload: _ContextBayPayload, tool_use_mappings: dict[str, str] | None) -> None:
    """normalize → turns/executions/bridges 拆分（id 计数器重置在内），结果写回 payload。"""
    normalized = _normalize(payload.all_interactions)

    reset_turn_ids()
    reset_exec_ids()
    reset_bridge_ids()
    turns, tool_calls, skill_events = split_into_turns(normalized, payload.session_id)

    executions = split_executions(turns, tool_calls, skill_events, payload.session_id)
    root_exec_id = next((e.id for e in executions if not e.is_subagent), None)

    bridges: list[InteractionBridgeRow] = []
    if root_exec_id:
        bridges = build_bridges(
            normalized, tool_calls, turns, payload.session_id, root_exec_id, tool_use_mappings
        )
    payload.turns = turns
    payload.tool_calls = tool_calls
    payload.skill_events = skill_events
    payload.executions = executions
    payload.root_exec_id = root_exec_id
    payload.bridges = bridges


def _resolve_output_path(output_path: str | None, session_id: str) -> str:
    """输出 .db 路径；未指定时按会话 id + 随机后缀生成临时路径。"""
    if output_path:
        return output_path
    rand = secrets.token_hex(4)
    filename = f"cannbot_db_session_{session_id}_{rand}.db"
    return str(Path(tempfile.gettempdir()) / filename)


#: Session 行 total* 聚合列（顺序对齐 INSERT 列清单中的同名列）。
_SESSION_AGG_KEYS: tuple[str, ...] = (
    "totalTokens",
    "totalInputTokens",
    "totalOutputTokens",
    "totalReasoningTokens",
    "totalCacheReadTokens",
    "totalCacheWriteTokens",
    "totalCost",
    "totalLatencyMs",
    "totalToolCallCount",
    "totalLlmCallCount",
    "totalSkillLoadCount",
    "totalSubagentCount",
)


def _session_row_values(payload: _ContextBayPayload) -> tuple[Any, ...]:
    """Session 行字段（label/query 取首条 user 消息截断），按字段组分段拼接。"""
    agg = payload.agg
    meta = payload.session_meta
    first_query = next((it.content for it in payload.all_interactions if it.role == "user"), None)
    label = first_query[:100] if first_query else None
    query = first_query[:200] if first_query else None
    identity = (
        payload.session_id,
        payload.session_id,
        label,
        query,
        payload.framework,
    )
    timing = (
        agg["model"],
        _to_iso(agg["startTime"]),
        _to_iso(agg["endTime"]),
    )
    totals = tuple(agg[k] for k in _SESSION_AGG_KEYS)
    lineage = (
        payload.root_exec_id,
        payload.source_path,
        meta.parent_id,
        meta.version,
        meta.directory,
    )
    summary = (
        meta.summary_additions,
        meta.summary_deletions,
        meta.summary_files,
    )
    stamps = (
        None,
        datetime.now(UTC).isoformat(),
        datetime.now(UTC).isoformat(),
    )
    return identity + timing + totals + lineage + summary + stamps


def _insert_session_row(conn: sqlite3.Connection, payload: _ContextBayPayload) -> None:
    """Session 行：session_id 作 PK，让子表外键自然对齐。"""
    conn.execute(
        """INSERT INTO "Session" (
                "id", "taskId", "label", "query", "framework", "model",
                "startTime", "endTime",
                "totalTokens", "totalInputTokens", "totalOutputTokens", "totalReasoningTokens",
                "totalCacheReadTokens", "totalCacheWriteTokens", "totalCost", "totalLatencyMs",
                "totalToolCallCount", "totalLlmCallCount", "totalSkillLoadCount", "totalSubagentCount",
                "rootExecutionId", "sourcePath", "parentId", "version", "directory",
                "summaryAdditions", "summaryDeletions", "summaryFiles",
                "user", "createdAt", "updatedAt"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        _session_row_values(payload),
    )


def _turn_values(t: TurnRow) -> tuple[Any, ...]:
    """Turn 行字段（isSubagent 转 0/1），按字段组分段拼接。"""
    content = (t.id, t.session_id, t.turn_index, t.role, t.content)
    messages = (
        t.content_json,
        t.content_summary,
        t.input_messages_json,
        t.input_messages_count,
        t.input_messages_tokens,
    )
    window = (t.context_window_pct, t.agent_name, t.subagent_name, t.subagent_session_id)
    tokens = (
        t.total_tokens,
        t.input_tokens,
        t.output_tokens,
        t.reasoning_tokens,
        t.cache_read_tokens,
    )
    timing = (t.cache_write_tokens, t.created_at_ts, t.completed_at, t.latency_ms, t.ttft_ms)
    model = (t.model, t.model_id, t.provider_id, t.temperature, t.max_tokens)
    flags = (
        t.finish_reason,
        1 if t.is_subagent else 0,
        t.parent_execution_id,
        datetime.now(UTC).isoformat(),
    )
    return content + messages + window + tokens + timing + model + flags


def _insert_turn_rows(conn: sqlite3.Connection, turns: list[TurnRow]) -> None:
    for t in turns:
        conn.execute(
            """INSERT INTO "Turn" (
                    "id", "sessionId", "turnIndex", "role", "content", "contentJson", "contentSummary",
                    "inputMessagesJson", "inputMessagesCount", "inputMessagesTokens", "contextWindowPct",
                    "agentName", "subagentName", "subagentSessionId",
                    "totalTokens", "inputTokens", "outputTokens", "reasoningTokens",
                    "cacheReadTokens", "cacheWriteTokens",
                    "createdAt_ts", "completedAt", "latencyMs", "ttftMs",
                    "model", "modelId", "providerId", "temperature", "maxTokens", "finishReason",
                    "isSubagent", "parentExecutionId", "createdAt"
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )""",
            _turn_values(t),
        )


def _insert_tool_call_rows(conn: sqlite3.Connection, tool_calls: list[ToolCallRow]) -> None:
    for tc in tool_calls:
        conn.execute(
            """INSERT INTO "ToolCall" (
                    "id", "turnId", "toolCallId", "toolName", "argsJson", "resultJson",
                    "state", "errorType", "errorMessage",
                    "startedAt", "completedAt", "durationMs", "dispatchBridgeId", "isSkillRelated", "createdAt"
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                tc.id,
                tc.turn_id,
                tc.tool_call_id,
                tc.tool_name,
                tc.args_json,
                tc.result_json,
                tc.state,
                tc.error_type,
                tc.error_message,
                tc.started_at,
                tc.completed_at,
                tc.duration_ms,
                tc.dispatch_bridge_id,
                1 if tc.is_skill_related else 0,
                datetime.now(UTC).isoformat(),
            ),
        )


def _insert_skill_event_rows(conn: sqlite3.Connection, skill_events: list[SkillEventRow]) -> None:
    for se in skill_events:
        conn.execute(
            """INSERT INTO "SkillEvent" (
                    "id", "turnId", "skillName", "skillVersion", "eventType", "success",
                    "errorMessage", "argsJson", "startedAt", "completedAt", "durationMs", "createdAt"
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                se.id,
                se.turn_id,
                se.skill_name,
                se.skill_version,
                se.event_type,
                1 if se.success else 0,
                se.error_message,
                se.args_json,
                se.started_at,
                se.completed_at,
                se.duration_ms,
                datetime.now(UTC).isoformat(),
            ),
        )


def _insert_execution_rows(conn: sqlite3.Connection, executions: list[ExecutionRow]) -> None:
    for e in executions:
        conn.execute(
            """INSERT INTO "Execution" (
                    "id", "sessionId", "agentName", "agentSessionId", "isSubagent",
                    "subagentType", "subagentName", "parentExecutionId", "rootExecutionId", "depth",
                    "tokens", "inputTokens", "outputTokens", "reasoningTokens",
                    "cacheReadInputTokens", "cacheCreationInputTokens", "maxSingleCallTokens",
                    "cost", "latencyMs", "toolCallCount", "toolCallErrorCount",
                    "llmCallCount", "skillLoadCount", "skillInvokeCount",
                    "finalResult", "model", "createdAt"
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                e.id,
                e.session_id,
                e.agent_name,
                e.agent_session_id,
                1 if e.is_subagent else 0,
                e.subagent_type,
                e.subagent_name,
                e.parent_execution_id,
                e.root_execution_id,
                e.depth,
                e.tokens,
                e.input_tokens,
                e.output_tokens,
                e.reasoning_tokens,
                e.cache_read_input_tokens,
                e.cache_creation_input_tokens,
                e.max_single_call_tokens,
                e.cost,
                e.latency_ms,
                e.tool_call_count,
                e.tool_call_error_count,
                e.llm_call_count,
                e.skill_load_count,
                e.skill_invoke_count,
                e.final_result,
                e.model,
                e.created_at,
            ),
        )


def _insert_execution_skill_rows(
    conn: sqlite3.Connection, exec_skill_rows: list[ExecutionSkillRow]
) -> None:
    for es in exec_skill_rows:
        conn.execute(
            """INSERT INTO "ExecutionSkill" (
                    "id", "executionId", "skillName", "skillVersion", "isPrimary", "user", "createdAt"
                ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                es.id,
                es.execution_id,
                es.skill_name,
                es.skill_version,
                1 if es.is_primary else 0,
                es.user,
                es.created_at,
            ),
        )


def _insert_session_skill_rows(
    conn: sqlite3.Connection, session_skills: list[SessionSkillRow]
) -> None:
    for ss in session_skills:
        conn.execute(
            """INSERT INTO "SessionSkill" (
                    "id", "sessionId", "skillName", "skillVersion", "invocationCount", "user", "createdAt"
                ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                ss.id,
                ss.session_id,
                ss.skill_name,
                ss.skill_version,
                ss.invocation_count,
                ss.user,
                ss.created_at,
            ),
        )


def _insert_bridge_rows(conn: sqlite3.Connection, bridges: list[InteractionBridgeRow]) -> None:
    for b in bridges:
        conn.execute(
            """INSERT INTO "InteractionBridge" (
                    "id", "sessionId", "dispatchExecutionId", "dispatchTurnId", "dispatchToolCallId",
                    "dispatchContent", "dispatchTimestamp",
                    "responseExecutionId", "responseTurnId", "responseContent", "responseTimestamp",
                    "subagentSessionId", "subagentType", "subagentName", "status",
                    "subagentTokens", "subagentLatencyMs", "createdAt", "updatedAt"
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                b.id,
                b.session_id,
                b.dispatch_execution_id,
                b.dispatch_turn_id,
                b.dispatch_tool_call_id,
                b.dispatch_content,
                b.dispatch_timestamp,
                b.response_execution_id,
                b.response_turn_id,
                b.response_content,
                b.response_timestamp,
                b.subagent_session_id,
                b.subagent_type,
                b.subagent_name,
                b.status,
                b.subagent_tokens,
                b.subagent_latency_ms,
                datetime.now(UTC).isoformat(),
                datetime.now(UTC).isoformat(),
            ),
        )


def _write_context_bay_db(output_path: str, payload: _ContextBayPayload) -> None:
    """写 7 表 .db（表序：Session→Turn→ToolCall→SkillEvent→Execution→Skill→Bridge）。"""
    if Path(output_path).exists():
        Path(output_path).unlink()
    conn = sqlite3.connect(output_path)
    try:
        create_tables(conn)
        _insert_session_row(conn, payload)
        _insert_turn_rows(conn, payload.turns)
        _insert_tool_call_rows(conn, payload.tool_calls)
        _insert_skill_event_rows(conn, payload.skill_events)
        _insert_execution_rows(conn, payload.executions)
        _insert_execution_skill_rows(conn, payload.exec_skill_rows)
        _insert_session_skill_rows(conn, payload.session_skills)
        _insert_bridge_rows(conn, payload.bridges)
        conn.commit()
    finally:
        conn.close()


def export_session_to_context_bay_db(
    source_type: str,
    source_path: str,
    session_id: str,
    output_path: str | None = None,
) -> str:
    """Read source session → produce 7-table cannbot-insight .db.

    Args:
        source_type: "opencode-db" or "claude-jsonl"
        source_path: path to opencode.db or .jsonl file
        session_id: sdk session id
        output_path: optional output .db path; auto-generated if None

    Returns: path to the produced .db file
    """
    all_interactions, session_meta, tool_use_mappings, framework = _read_source_session(
        source_type, source_path, session_id
    )
    payload = _ContextBayPayload(
        session_id=session_id,
        source_path=source_path,
        framework=framework,
        session_meta=session_meta,
        all_interactions=all_interactions,
    )
    _split_rows(payload, tool_use_mappings)
    payload.agg = _compute_session_aggregates(
        payload.turns, payload.tool_calls, payload.skill_events
    )
    payload.exec_skill_rows, payload.session_skills = _compute_skill_rows(
        payload.executions, payload.turns, payload.skill_events, payload.session_id
    )
    output_path = _resolve_output_path(output_path, session_id)
    _write_context_bay_db(output_path, payload)
    return output_path
