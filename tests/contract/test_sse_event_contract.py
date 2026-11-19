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

"""SSE 事件约定测试 — 事件名与payload字段和 manifest 清单互锁。"""

from __future__ import annotations

import json
from types import SimpleNamespace

import anyio

from workflow_controller.api.event_api import EventInfo
from workflow_controller.api.pipeline_api import PipelineSnapshot
from workflow_controller.api.usage_api import UsageSnapshot
from workflow_controller.web.routes.sse_routes import event_stream

from tests.contract.manifest import event_payload_fields, sse_event_names


class _FakeEventApi:
    """回放一条事件表行、一条 run 键事件行，其余段空转。"""

    def __init__(self) -> None:
        self.replay = EventInfo(
            rowid=1,
            session_id="s1",
            event_type="user_message",
            iteration=1,
            timestamp="2026-10-30T10:00:00",
            data={"text": "hi"},
            run_id=None,
            context=None,
        )

    @staticmethod
    def snapshot_cursor() -> str:
        return "1"

    @staticmethod
    def get_since_cursor(cursor: str) -> tuple[str, list]:
        return (cursor, [])

    @staticmethod
    def snapshot_run_event_cursor() -> str:
        return "3"

    @staticmethod
    def get_run_events_since_cursor(cursor: str) -> tuple[str, list[dict]]:
        return (
            "6",
            [
                {
                    "id": 6,
                    "run_id": "run-1",
                    "context": "node=b",
                    "timestamp": "2026-10-30T10:00:01",
                    "event_type": "process_output",
                    "data": {"line": "hi"},
                }
            ],
        )

    def get_recent_at_cursor(self, cursor: str, limit: int) -> list[EventInfo]:
        return [self.replay]


class _FakeSseRequest:
    """驱动一轮完整节拍后置位停机：单流收齐全部事件名（含告别帧）。"""

    def __init__(self) -> None:
        api = SimpleNamespace(
            event=_FakeEventApi(),
            session=SimpleNamespace(
                list_sessions=lambda: [SimpleNamespace(id="s1", name="w1")],
                running_loop_sessions=lambda: [{"id": "s1", "name": "w1"}],
            ),
            pipeline=SimpleNamespace(all_snapshots=lambda: {"s1": PipelineSnapshot()}),
            usage=SimpleNamespace(snapshot=lambda: UsageSnapshot(turns=1)),
            config=SimpleNamespace(
                get_config_dict=lambda: {"brand_name": "Workflow Controller", "runtime": "opencode"}
            ),
            auth=SimpleNamespace(key_status=lambda: {"mode": "API", "providers": []}),
            plugin=SimpleNamespace(get_handoff_states=lambda: {"s1": {"pending": True}}),
        )
        self.app = SimpleNamespace(
            state=SimpleNamespace(
                api=api,
                config_section_providers={
                    "context_bay": SimpleNamespace(
                        read_config_section=lambda: {"repo_url": "https://example.com/r.git"}
                    )
                },
            )
        )
        self.shutdown = anyio.Event()
        self._rounds = 0

    async def is_disconnected(self) -> bool:
        self._rounds += 1
        if self._rounds == 2:
            self.shutdown.set()
        return self._rounds > 2


async def _collect_stream() -> dict[str, list]:
    """驱动一条 SSE 流并按事件名归组解码后的payload。"""
    request = _FakeSseRequest()
    grouped: dict[str, list] = {}
    async for ev in event_stream(request, request.shutdown):
        grouped.setdefault(ev["event"], []).append(json.loads(ev["data"]))
    return grouped


async def test_sse_event_names_match_manifest() -> None:
    """实际推送的事件名集合必须与清单登记一致。"""
    assert set(await _collect_stream()) == set(sse_event_names())


async def test_sse_payload_top_level_keys_stay_pinned() -> None:
    """各事件的payload顶层结构钉住；claude_event 两种行字段与清单登记一致。"""
    events = await _collect_stream()
    info_fields = set(event_payload_fields("event_info"))

    # 事件表回放行与 run 键行都按 EventInfo 字段面推送
    assert [set(payload) for payload in events["claude_event"]] == [info_fields, info_fields]
    assert isinstance(events["session_update"][0], list)
    assert events["config_update"] == [
        {
            "brand_name": "Workflow Controller",
            "runtime": "opencode",
            "context_bay": {"repo_url": "https://example.com/r.git"},
        },
    ]

    # pipeline_update 是 session_id → 快照的映射：快照字段钉住
    pipeline_fields = set(PipelineSnapshot().__dict__)
    assert all(
        set(entry) == {"s1"} and set(entry["s1"]) == pipeline_fields
        for entry in events["pipeline_update"]
    )

    expected_keys = {
        "usage_update": set(UsageSnapshot().__dict__),
        "auth_update": {"mode", "providers"},
        "handoff_update": {"states"},
        "loop_update": {"running_sessions", "watching_session_id", "watching_session_name"},
        "server_reload": set(),
    }
    for name, keys in expected_keys.items():
        assert events[name], name
        assert all(set(payload) == keys for payload in events[name]), name
