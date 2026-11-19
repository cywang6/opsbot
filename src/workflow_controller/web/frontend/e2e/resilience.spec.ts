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

import { expect, test } from './fixtures'
import { mockSessionDeps, routeNth, sessionPayload, sseBody } from './support/mock-session'

test('Session shows reconnecting state when the SSE stream is unavailable', async ({ page }) => {
  const session = {
    id: 'e2e-sse-session', name: 'SSE session', role: 'worker', state: 'idle',
    loop_status: 'no', stop_reason: null, loop_hold: null, current_iteration: 1,
    max_iterations: 3, progress: 0, elapsed_seconds: 1, created_at_iso: '2026-10-22T00:00:00Z',
    error: null, last_activity: [], birth_handoff_doc: null, result: null,
    predecessor: null, successors: [], sdk_session_id: 'sdk-sse', project_dir: '/tmp/e2e', run_id: null,
  }
  await page.route('**/api/v1/sessions/e2e-sse-session', async (route) => {
    await route.fulfill({ json: session })
  })
  await page.route('**/api/v1/events/stream', async (route) => {
    await route.fulfill({ status: 503, body: 'stream unavailable' })
  })
  await page.route('**/api/v1/config', async (route) => {
    await route.fulfill({ json: { reviewer: { enabled: false, mode: 'auto' } } })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [] } })
  })
  await page.route('**/api/v1/events?*', async (route) => {
    await route.fulfill({ json: { events: [] } })
  })
  await page.route('**/api/breather/state?*', async (route) => {
    await route.fulfill({ json: {} })
  })
  await page.route('**/api/v1/plugins/breather/config', async (route) => {
    await route.fulfill({ json: { enabled: false } })
  })
  await page.route('**/api/v1/sessions/e2e-sse-session/**', async (route) => {
    await route.fulfill({ json: { hints: {}, agents: [], instructions: [] } })
  })

  await page.goto('/session/e2e-sse-session', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('SSE session')).toBeVisible()
  await expect(page.getByText('连接中')).toBeVisible({ timeout: 10_000 })
})

test('browser renders the insight error body when the upstream is unreachable', async ({ page }) => {
  // Browser-side mock of the proxy's 502 body: this verifies only that the Vue app
  // renders the unreachable-insight error body. The real reverse-proxy path
  // (app.py `_proxy_to_insight` → httpx.ConnectError → 502) is not exercised here,
  // because the E2E fixture keeps the fake insight reachable on 21025.
  await page.route('**/insight/unavailable', async (route) => {
    await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"cannbot-insight not reachable"}' })
  })
  const response = await page.goto('/insight/unavailable', { waitUntil: 'domcontentloaded' })
  expect(response?.status()).toBe(502)
  await expect(page.locator('body')).toContainText('cannbot-insight not reachable')
})

test('SSE reconnects after a transient failure and the connecting badge disappears', async ({ page }) => {
  // RS-01（①故障注入：/events/stream 首连 503 → 重连恢复）。
  // 恢复路由放行到真实 web 进程的长连流（只读端点）：mock body 是一次性响应，
  // 连接立即关闭会让 connected 高频抖动，断言「连接中消失」会抖动失败。
  const session = sessionPayload({ id: 'e2e-sse-recover', name: 'SSE recover session' })
  await mockSessionDeps(page, session)
  await page.route('**/api/v1/events/stream', routeNth(
    [(route) => route.fulfill({ status: 503, body: 'stream unavailable' })],
    (route) => route.continue(),
  ))

  await page.goto('/session/e2e-sse-recover', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('SSE recover session')).toBeVisible()
  await expect(page.getByText('连接中')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('连接中')).toBeHidden({ timeout: 10_000 })
})

test('Run detail keeps stale data and auto-recovers when the state refresh fails', async ({ page }) => {
  // RS-02（①故障注入：/state 首两拉 500，详情已有 → 旧数据不撕空 + 提示条 +
  // 退避自动恢复；不弹 toast）。依赖轮询恢复，断言放宽到 10s。
  const runRow = {
    run_id: 'rs-run', kind: 'workflow', format: 'graph-yaml@1', label: 'RS refresh run',
    status: 'running', pause_reason: null, work_dir: '/tmp/e2e-project',
    created_at: '2026-11-05T00:00:00Z', finished_at: null, error: null,
  }
  // 注册顺序：通配 catch-all 先注册，专用 /state、/events 后注册（newest wins）
  await page.route('**/api/v1/runs/rs-run/**', async (route) => {
    await route.fulfill({ status: 200, json: { ok: true } })
  })
  await page.route('**/api/v1/runs/rs-run', async (route) => {
    await route.fulfill({ json: { run: runRow, sessions: [] } })
  })
  await page.route('**/api/v1/runs/rs-run/events**', async (route) => {
    await route.fulfill({ json: { events: [], next_cursor: null, has_more: false } })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [] } })
  })
  const stateError = { processes: [], metrics: { rounds: 2, queue_depth: 1, deferred: 0, in_flight: 1 }, driver: null }
  await page.route('**/api/v1/runs/rs-run/state', routeNth(
    [
      (route) => route.fulfill({ status: 500, json: { detail: 'state temporarily unavailable' } }),
      (route) => route.fulfill({ status: 500, json: { detail: 'state temporarily unavailable' } }),
    ],
    (route) => route.fulfill({ json: stateError }),
  ))

  await page.goto('/run/rs-run', { waitUntil: 'domcontentloaded' })
  // 已有详情保留旧数据（不撕空），进程表/指标失败以提示条呈现
  await expect(page.getByText('RS refresh run')).toBeVisible()
  await expect(page.getByText('运行状态（进程表/指标）加载失败，自动重试中'))
    .toBeVisible({ timeout: 10_000 })
  // 退避自动恢复后提示条消失、指标回到新数据
  await expect(page.getByText('运行状态（进程表/指标）加载失败，自动重试中'))
    .toBeHidden({ timeout: 10_000 })
  await expect(page.getByText('轮次 2 · 队列 1')).toBeVisible()
})

test('session delete failure surfaces the backend detail in the toast', async ({ page }) => {
  // RS-03（①故障注入：DELETE /sessions/{id} 500 {detail} → toast 透传 detail，
  // 而非空对象/纯 HTTP 码；失败不关确认弹窗）。删除入口在侧栏会话行（×）。
  const sid = 'e2e-rs-delete'
  const session = sessionPayload({ id: sid, name: 'RS delete session' })
  await mockSessionDeps(page, session)
  await page.route('**/api/v1/events/stream', (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: sseBody([
      ['config_update', { brand_name: 'Workflow Controller', project_dir: '/tmp/e2e-project', recent_dirs: ['/tmp/e2e-project'] }],
      ['session_update', [session]],
    ]),
  }))
  await page.route(`**/api/v1/sessions/${sid}`, async (route) => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ status: 500, json: { detail: '磁盘已满' } })
      return
    }
    await route.fulfill({ json: session })
  })

  await page.goto(`/session/${sid}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('RS delete session').first()).toBeVisible()
  await page.getByTitle('删除会话').click()
  await expect(page.getByText('该会话及其事件记录将被删除。')).toBeVisible()
  await page.getByRole('button', { name: '确认删除' }).click()

  // 后端 detail 原文透传；会话仍在账上，弹窗保留供重试/取消
  await expect(page.getByText('磁盘已满')).toBeVisible()
  await expect(page.getByText('该会话及其事件记录将被删除。')).toBeVisible()
})

test('Dashboard reload preserves the selected theme and current project', async ({ page }) => {
  // RS-04（②形态：localStorage 主题 + SSE 首帧项目恢复）
  const projectDir = '/tmp/rs-dashboard-project'
  await page.addInitScript(() => {
    (globalThis as any).localStorage.setItem('workflow-controller-appearance-theme', 'github-light')
  })
  await page.route('**/api/v1/events/stream', route => route.fulfill({
    contentType: 'text/event-stream',
    body: sseBody([
      ['config_update', { project_dir: projectDir, recent_dirs: [projectDir], brand_name: 'Workflow Controller' }],
      ['session_update', []],
    ]),
  }))
  await page.route('**/api/v1/config', route =>
    route.fulfill({ json: { reviewer: { enabled: false, mode: 'auto' } } }))
  await page.route('**/api/v1/auth/status', route =>
    route.fulfill({ json: { has_api_key: true } }))
  await page.route('**/api/v1/runs?*', route => route.fulfill({ json: { runs: [] } }))
  await page.route('**/api/v1/plugins', route => route.fulfill({ json: { plugins: [] } }))
  await page.route('**/api/v1/project-config*', route => route.fulfill({ json: {} }))

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-appearance-theme', 'github-light')
  await expect(page.locator(`.project-row.active[title="${projectDir}"]`)).toBeVisible()

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-appearance-theme', 'github-light')
  await expect(page.locator(`.project-row.active[title="${projectDir}"]`)).toBeVisible()
})
