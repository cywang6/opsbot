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

"""context_bay_exporter unit tests.

Tests the minimal pipeline: RawInteraction → 7-table .db. Uses synthetic
data so no real opencode.db fixture is needed.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from workflow_controller.context_bay_exporter import export_session_to_context_bay_db
from workflow_controller.context_bay_exporter.execution_split import split_executions
from workflow_controller.context_bay_exporter.schema import create_tables
from workflow_controller.context_bay_exporter.turn_split import split_into_turns
from workflow_controller.transcript.types import RawInteraction, TokenUsage, ToolCallInfo


def _make_interaction(role="user", content="hello", **kw):
    """Build a minimal RawInteraction for testing."""
    return RawInteraction(
        role=role,
        content=content,
        timestamp="2026-07-28T10:00:00.000Z",
        time_info={"created": 1753696800000, "completed": 1753696801000},
        **kw,
    )


_OPENCODE_DDL = """
    CREATE TABLE session (
        id TEXT PRIMARY KEY, title TEXT, version TEXT,
        parent_id TEXT, time_created INTEGER,
        directory TEXT, summary_additions INTEGER,
        summary_deletions INTEGER, summary_files INTEGER
    );
    CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT,
        time_created INTEGER, data TEXT
    );
    CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT,
        time_created INTEGER, data TEXT
    );
"""


def _make_opencode_db(db_path):
    """Build a synthetic opencode.db: one session, user/assistant messages, one part."""
    conn = sqlite3.connect(str(db_path))
    conn.executescript(_OPENCODE_DDL)
    conn.execute(
        "INSERT INTO session (id, title, version, parent_id, time_created) VALUES (?, ?, ?, ?, ?)",
        ("ses_test", "test session", "1.0", "", 1753696800000),
    )
    conn.execute(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
        (
            "msg1",
            "ses_test",
            1753696800000,
            json.dumps({"role": "user", "content": "hello world"}),
        ),
    )
    conn.execute(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
        (
            "msg2",
            "ses_test",
            1753696801000,
            json.dumps(
                {
                    "role": "assistant",
                    "agent": "primary",
                    "tokens": {"total": 100, "input": 50, "output": 50},
                    "cost": 0.01,
                    "modelID": "test-model",
                    "providerID": "test-provider",
                    "finish": "stop",
                    "time": {"created": 1753696801000, "completed": 1753696802000},
                }
            ),
        ),
    )
    conn.execute(
        "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
        ("part1", "msg2", 1753696801000, json.dumps({"type": "text", "text": "hi there"})),
    )
    conn.commit()
    conn.close()


class TestSchema:
    @staticmethod
    def test_create_tables_produces_7_tables(tmp_path):
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(str(db_path))
        create_tables(conn)
        tables = {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        conn.close()
        assert tables == {
            "Session",
            "Turn",
            "ToolCall",
            "SkillEvent",
            "Execution",
            "ExecutionSkill",
            "SessionSkill",
            "InteractionBridge",
        }

    @staticmethod
    def test_indexes_created(tmp_path):
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(str(db_path))
        create_tables(conn)
        indexes = {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'").fetchall()
        }
        conn.close()
        assert "Session_taskId_framework_key" in indexes
        assert "Turn_sessionId_turnIndex_idx" in indexes


class TestTurnSplit:
    @staticmethod
    def test_basic_split_user_assistant():
        interactions = [
            _make_interaction(role="user", content="hello"),
            _make_interaction(
                role="assistant",
                content="hi",
                usage=TokenUsage(total=100, input=50, output=50),
                model="test-model",
            ),
        ]
        turns, tcs, ses = split_into_turns(interactions, "ses_x")
        assert len(turns) == 2
        assert turns[0].role == "user"
        assert turns[1].role == "assistant"
        assert turns[1].total_tokens == 100
        assert turns[1].model == "test-model"
        assert len(tcs) == 0
        assert len(ses) == 0

    @staticmethod
    def test_tool_call_split():
        interactions = [
            _make_interaction(role="user", content="read file"),
            _make_interaction(
                role="assistant",
                content="ok",
                tool_calls=[
                    ToolCallInfo(
                        tool_call_id="tc1",
                        tool_name="Read",
                        args_json='{"file_path": "/tmp/test.py"}',
                        result_json="file contents",
                        state="ok",
                    )
                ],
            ),
        ]
        _turns, tcs, _ses = split_into_turns(interactions, "ses_x")
        assert len(tcs) == 1
        assert tcs[0].tool_name == "Read"
        assert tcs[0].is_skill_related is False

    @staticmethod
    def test_skill_tool_call():
        interactions = [
            _make_interaction(role="user", content="use skill"),
            _make_interaction(
                role="assistant",
                content="done",
                tool_calls=[
                    ToolCallInfo(
                        tool_call_id="tc1",
                        tool_name="skill/my-skill",
                        args_json='{"skill": "my-skill"}',
                        result_json="result",
                        state="ok",
                    )
                ],
            ),
        ]
        _turns, tcs, ses = split_into_turns(interactions, "ses_x")
        assert len(tcs) == 1
        assert tcs[0].is_skill_related is True
        assert len(ses) == 1
        assert ses[0].skill_name == "my-skill"
        assert ses[0].event_type == "use"  # skill/my-skill → "use" per insight canon

    @staticmethod
    def test_subagent_turn_marked():
        interactions = [
            _make_interaction(role="user", content="dispatch"),
            _make_interaction(
                role="assistant",
                content="subagent result",
                subagent_session_id="sub_1",
                subagent_name="tester",
            ),
        ]
        turns, _, _ = split_into_turns(interactions, "ses_x")
        assert turns[1].is_subagent is True
        assert turns[1].subagent_session_id == "sub_1"
        assert turns[1].subagent_name == "tester"


class TestExecutionSplit:
    @staticmethod
    def test_root_execution():
        interactions = [
            _make_interaction(role="user", content="hi"),
            _make_interaction(role="assistant", content="hello", usage=TokenUsage(total=100)),
        ]
        turns, tcs, ses = split_into_turns(interactions, "ses_x")
        executions = split_executions(turns, tcs, ses, "ses_x")
        assert len(executions) == 1
        assert not executions[0].is_subagent
        assert executions[0].tokens == 100
        assert executions[0].llm_call_count == 1

    @staticmethod
    def test_subagent_execution():
        interactions = [
            _make_interaction(role="user", content="hi"),
            _make_interaction(role="assistant", content="hello", usage=TokenUsage(total=50)),
            _make_interaction(
                role="assistant",
                content="sub result",
                subagent_session_id="sub_1",
                subagent_name="dev",
                usage=TokenUsage(total=30),
            ),
        ]
        turns, _, _ = split_into_turns(interactions, "ses_x")
        executions = split_executions(turns, [], [], "ses_x")
        assert len(executions) == 2
        root = next(e for e in executions if not e.is_subagent)
        sub = next(e for e in executions if e.is_subagent)
        assert sub.agent_session_id == "sub_1"
        assert sub.tokens == 30
        assert sub.parent_execution_id == root.id


class TestExporter:
    @staticmethod
    def test_export_produces_valid_7table_db(tmp_path):
        """End-to-end: synthetic interactions → 7-table .db."""
        db_path = tmp_path / "opencode.db"
        _make_opencode_db(db_path)

        # Export
        output = tmp_path / "output.db"
        result = export_session_to_context_bay_db(
            source_type="opencode-db",
            source_path=str(db_path),
            session_id="ses_test",
            output_path=str(output),
        )
        assert result == str(output)
        assert output.exists()

        # Verify 7 tables have data
        conn2 = sqlite3.connect(str(output))
        conn2.row_factory = sqlite3.Row
        tables = {
            r[0]
            for r in conn2.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        assert "Session" in tables
        assert "Turn" in tables
        assert "Execution" in tables

        session = conn2.execute(
            'SELECT * FROM "Session" WHERE taskId = ?', ("ses_test",)
        ).fetchone()
        assert session is not None
        assert session["framework"] == "opencode"
        assert session["totalTokens"] == 100

        turns = conn2.execute(
            'SELECT * FROM "Turn" WHERE sessionId = ? ORDER BY turnIndex',
            (session["id"],),
        ).fetchall()
        assert len(turns) == 2
        assert turns[0]["role"] == "user"
        assert turns[1]["role"] == "assistant"
        assert turns[1]["totalTokens"] == 100

        executions = conn2.execute(
            'SELECT * FROM "Execution" WHERE sessionId = ?', (session["id"],)
        ).fetchall()
        assert len(executions) == 1
        assert executions[0]["isSubagent"] == 0
        assert executions[0]["tokens"] == 100

        conn2.close()

    @staticmethod
    def test_export_filename_auto_generated(tmp_path):
        """Without output_path, filename follows cannbot_db_session_<id>_<rand>.db."""
        db_path = tmp_path / "opencode.db"
        conn = sqlite3.connect(str(db_path))
        conn.executescript("""
            CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, version TEXT,
                parent_id TEXT, time_created INTEGER, directory TEXT,
                summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
        """)
        conn.execute(
            "INSERT INTO session (id, title, parent_id, time_created) VALUES (?, ?, ?, ?)",
            ("ses_auto", "auto", "", 1753696800000),
        )
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
            ("m1", "ses_auto", 1753696800000, json.dumps({"role": "user", "content": "test"})),
        )
        conn.commit()
        conn.close()

        result = export_session_to_context_bay_db(
            source_type="opencode-db",
            source_path=str(db_path),
            session_id="ses_auto",
        )
        filename = Path(result).name
        assert filename.startswith("cannbot_db_session_ses_auto_")
        assert filename.endswith(".db")
        Path(result).unlink(missing_ok=True)  # cleanup
