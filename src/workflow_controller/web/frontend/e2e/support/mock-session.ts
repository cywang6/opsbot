// Copyright (c) 2026 Workflow Controller Contributors
//
// Licensed under the MIT License (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://opensource.org/licenses/MIT
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { Page, Route } from '@playwright/test'

// mock 层 Session 详情页公共依赖面（设计文档 §8.1 / §4.4）。
//
// 进 `/session/:id` 需同时 mock：GET /sessions/{id}、/config、/plugins、
// /events?*、/api/breather/state?*、/api/v1/plugins/breather/config、
// /sessions/{id}/**（subagent-hint/agents/instructions/watchdog 告警等子
// 路由默认应答）。本 helper 收敛为单一实现：默认值满足「空白加载」，
// 可选参数覆盖关键字段；专用子路由（pause/send/watchdog-alerts/…）经
// extraRoutes 后注册——Playwright 按注册逆序派发（newest wins），后注册
// 的专用路由天然 shadow 默认路由。
//
// 提醒：前端 Session 页新增依赖端点时，本清单会漏 mock 导致用例超时——
// 合入前端新端点的 PR 须跑一次空白 Session 用例验证依赖清单（§12）。

export interface SessionPayload {
  [key: string]: unknown
}

/** Session 列表/详情共用形状（SessionInfo.__dict__，api/session_api.py）。 */
export function sessionPayload(overrides: SessionPayload = {}): SessionPayload {
  return {
    id: 'e2e-session-actions',
    name: 'E2E action session',
    role: 'worker',
    state: 'idle',
    loop_status: 'no',
    stop_reason: 'user_pause',
    loop_hold: null,
    current_iteration: 1,
    max_iterations: 3,
    progress: 0,
    elapsed_seconds: 2,
    created_at_iso: '2026-10-22T00:00:00Z',
    error: null,
    last_activity: [],
    birth_handoff_doc: null,
    result: null,
    predecessor: null,
    successors: [],
    sdk_session_id: 'sdk-e2e-session-actions',
    model: 'e2e-shim-model',
    project_dir: '/tmp/e2e-project',
    run_id: null,
    plugin_metadata: {},
    reviewer_mode: 'auto',
    provider_index: null,
    reviewer_provider_index: null,
    context_threshold_pct: null,
    subagent_context_threshold_pct: null,
    context_window: null,
    ...overrides,
  }
}

/** 一次性 SSE mock body：[[event, data], ...] → text/event-stream。 */
export function sseBody(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

/** 按调用次数切换应答的路由 helper（RS-01「503 → 恢复」类序列回放）。 */
export function routeNth(
  handlers: Array<(route: Route) => Promise<void> | void>,
  fallback: (route: Route) => Promise<void> | void,
): (route: Route) => Promise<void> {
  let calls = 0
  return async (route: Route) => {
    const handler = calls < handlers.length ? handlers[calls] : fallback
    calls += 1
    await handler(route)
  }
}

export interface MockSessionPageOptions {
  /** GET /events?* 首次应答（默认空事件列表）。 */
  events?: unknown[]
  /** GET /config 应答（GET-only 拦截，PUT/POST 继续）；默认 reviewer 关闭。 */
  config?: Record<string, unknown>
  /** GET /plugins 应答（默认无插件）。 */
  plugins?: unknown[]
  /** GET /api/breather/state?* 应答。 */
  breatherState?: Record<string, unknown>
  /** GET /api/v1/plugins/breather/config 应答（默认禁用）。 */
  breatherConfig?: Record<string, unknown>
  /** GET /api/v1/events/stream（SSE）应答事件（默认空 session_update）。
   * 不 mock 会放真实后端的 session_update/config_update 进页面：侧栏渲染
   * 出真实会话/项目行，触发 strict violation（如 getByTitle('删除会话')
   * 命中多个）。专用序列回放按 newest wins 在本 helper 之后注册覆盖。 */
  streamEvents?: Array<[string, unknown]>
}

/**
 * mock 一个 Session 详情页的全部后端依赖（不导航）。
 *
 * 需要覆盖专用子路由（pause/send/watchdog 告警…）或补充 Session 页外
 * 依赖（如 workflow 成员的 /runs/{rid}）的用例：先调本函数，再自行
 * `page.route` 注册——newest wins，后注册的专用路由 shadow 默认——最后
 * `page.goto('/session/:id')`。
 */
export async function mockSessionDeps(
  page: Page,
  session: SessionPayload,
  options: MockSessionPageOptions = {},
): Promise<void> {
  const id = String(session.id)
  const config = {
    project_dir: '/tmp/e2e-project',
    reviewer: { enabled: false, timeout_seconds: 60, mode: 'auto' },
    ...(options.config ?? {}),
  }
  await page.route(`**/api/v1/sessions/${id}`, (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: session })
    }
    return route.continue()
  })
  // 默认 catch-all 先注册（newest wins：专用子路由在调用方后注册即可覆盖）。
  await page.route(`**/api/v1/sessions/${id}/**`, (route) =>
    route.fulfill({ json: { hints: {}, agents: [], instructions: [] } }))
  await page.route('**/api/v1/config', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: config })
    }
    return route.continue()
  })
  await page.route('**/api/v1/plugins', (route) =>
    route.fulfill({ json: { plugins: options.plugins ?? [] } }))
  await page.route('**/api/v1/events?*', (route) =>
    route.fulfill({ json: { events: options.events ?? [] } }))
  await page.route('**/api/breather/state?*', (route) =>
    route.fulfill({ json: options.breatherState ?? {} }))
  await page.route('**/api/v1/plugins/breather/config', (route) =>
    route.fulfill({ json: options.breatherConfig ?? { enabled: false } }))
  await page.route('**/api/v1/events/stream', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: sseBody(options.streamEvents ?? [['session_update', []]]),
    }))
}

/** 一站式：mock 依赖并导航到 `/session/:id`（返回前不等待渲染）。 */
export async function mockSessionPage(
  page: Page,
  session: SessionPayload,
  options: MockSessionPageOptions = {},
): Promise<void> {
  await mockSessionDeps(page, session, options)
  await page.goto(`/session/${String(session.id)}`, { waitUntil: 'domcontentloaded' })
}
