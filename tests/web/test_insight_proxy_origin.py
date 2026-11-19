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

"""Insight 反代跨端口浏览器来源校验。"""

import httpx
import pytest
from fastapi import FastAPI

from workflow_controller.web.insight import mount_insight_proxy


def _recording_proxy_setup(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[list[httpx.Request], FastAPI, type[httpx.AsyncClient]]:
    """挂载 insight 反代 app，并把 httpx.AsyncClient 换成记录上游请求的 MockTransport。

    返回 (forwarded, app, browser_cls)：browser_cls 是未被打补丁的原 AsyncClient，
    供测试扮演浏览器访问反代。
    """
    app = FastAPI()
    app.state.insight_port = 21025
    mount_insight_proxy(app)

    forwarded: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        forwarded.append(request)
        return httpx.Response(200, text="ok")

    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(upstream)
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original_client(transport=transport, **kwargs),
    )
    return forwarded, app, original_client


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("browser_headers", "expected_status", "expected_origin", "expected_referer"),
    [
        (
            {"referer": "http://127.0.0.1:9528/insight/session/abc?tab=events"},
            200,
            None,
            "http://127.0.0.1:21025/insight/session/abc?tab=events",
        ),
        (
            {"origin": "http://127.0.0.1:9528"},
            200,
            "http://127.0.0.1:21025",
            None,
        ),
        (
            {"referer": "http://127.0.0.1:9999/other"},
            403,
            None,
            None,
        ),
        (
            {"origin": "http://127.0.0.1:9528", "referer": "http://127.0.0.1:9999/other"},
            403,
            None,
            None,
        ),
        ({"origin": "null"}, 403, None, None),
        ({"host": "evil.example", "referer": "http://evil.example/other"}, 403, None, None),
        ({"host": "evil.example"}, 403, None, None),
        ({}, 200, None, None),
    ],
)
async def test_insight_proxy_browser_origin(
    monkeypatch,
    browser_headers,
    expected_status,
    expected_origin,
    expected_referer,
) -> None:
    forwarded, app, browser_cls = _recording_proxy_setup(monkeypatch)

    async with browser_cls(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:9528",
    ) as browser:
        response = await browser.get("/api/observe/data", headers=browser_headers)

    assert response.status_code == expected_status
    if expected_status == 403:
        assert forwarded == []
    else:
        assert len(forwarded) == 1
        assert forwarded[0].headers["host"] == "127.0.0.1:21025"
        assert forwarded[0].headers.get("origin") == expected_origin
        assert forwarded[0].headers.get("referer") == expected_referer


@pytest.mark.asyncio
async def test_insight_proxy_allowed_hosts_env(monkeypatch) -> None:
    monkeypatch.setenv(
        "WORKFLOW_CONTROLLER_INSIGHT_PROXY_HOSTS", "workflow-controller.example.com, 192.168.1.10"
    )

    forwarded, app, browser_cls = _recording_proxy_setup(monkeypatch)

    async with browser_cls(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:9528",
    ) as browser:
        ok = await browser.get(
            "/api/observe/data", headers={"host": "workflow-controller.example.com"}
        )
        rejected = await browser.get("/api/observe/data", headers={"host": "evil.example"})

    assert ok.status_code == 200
    assert len(forwarded) == 1
    assert rejected.status_code == 403
    assert len(forwarded) == 1
