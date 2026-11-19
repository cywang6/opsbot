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

"""insight 7 表导出专用的表行数据结构。

字段名按 Python 规范用 snake_case；对应的 Insight 表 camelCase 列名在
exporter 的 INSERT/CREATE TABLE SQL 字符串字面量里对齐，改名勿动字符串。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class TurnRow:
    """Turn 表行：一条消息轮次。"""

    id: str
    session_id: str
    turn_index: int
    role: str
    content: str | None
    content_json: str | None = None
    content_summary: str | None = None
    input_messages_json: str | None = None
    input_messages_count: int = 0
    input_messages_tokens: int = 0
    context_window_pct: float | None = None
    agent_name: str | None = None
    subagent_name: str | None = None
    subagent_session_id: str | None = None
    subagent_type: str | None = None
    total_tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost: float = 0.0
    created_at_ts: str | None = None
    completed_at: str | None = None
    latency_ms: int = 0
    ttft_ms: int | None = None
    model: str | None = None
    model_id: str | None = None
    provider_id: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    finish_reason: str | None = None
    is_subagent: bool = False
    parent_execution_id: str | None = None


@dataclass
class ToolCallRow:
    """ToolCall 表行：一次工具调用。"""

    id: str
    turn_id: str
    tool_call_id: str
    tool_name: str
    args_json: str | None
    result_json: str | None
    state: str
    error_type: str | None = None
    error_message: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    duration_ms: int = 0
    dispatch_bridge_id: str | None = None
    is_skill_related: bool = False


@dataclass
class SkillEventRow:
    """SkillEvent 表行：一次技能加载/调用。"""

    id: str
    turn_id: str
    skill_name: str
    skill_version: int | None = None
    event_type: str = "use"
    success: bool = True
    error_message: str | None = None
    args_json: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    duration_ms: int = 0


@dataclass
class ExecutionRow:
    """Execution 表行：根执行或 subagent 执行聚合。"""

    id: str
    session_id: str
    agent_name: str | None = None
    agent_session_id: str | None = None
    is_subagent: bool = False
    subagent_type: str | None = None
    subagent_name: str | None = None
    parent_execution_id: str | None = None
    root_execution_id: str | None = None
    depth: int = 0
    tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    max_single_call_tokens: int = 0
    cost: float = 0.0
    latency_ms: int = 0
    created_at: str = ""
    tool_call_count: int = 0
    tool_call_error_count: int = 0
    llm_call_count: int = 0
    skill_load_count: int = 0
    skill_invoke_count: int = 0
    final_result: str | None = None
    model: str | None = None


@dataclass
class InteractionBridgeRow:
    """InteractionBridge 表行：subagent 派发与回应的桥接。"""

    id: str
    session_id: str
    dispatch_execution_id: str
    dispatch_turn_id: str | None = None
    dispatch_tool_call_id: str | None = None
    dispatch_content: str | None = None
    dispatch_timestamp: str | None = None
    response_execution_id: str | None = None
    response_turn_id: str | None = None
    response_content: str | None = None
    response_timestamp: str | None = None
    subagent_session_id: str | None = None
    subagent_type: str | None = None
    subagent_name: str | None = None
    status: str = "dispatched"
    subagent_tokens: int = 0
    subagent_latency_ms: int = 0


@dataclass
class ExecutionSkillRow:
    """ExecutionSkill 表行：执行与技能的关联。"""

    id: str
    execution_id: str
    skill_name: str
    skill_version: int | None = None
    is_primary: bool = False
    user: str | None = None
    created_at: str = ""


@dataclass
class SessionSkillRow:
    """SessionSkill 表行：会话级技能汇总。"""

    id: str
    session_id: str
    skill_name: str
    skill_version: int | None = None
    invocation_count: int = 0
    user: str | None = None
    created_at: str = ""
