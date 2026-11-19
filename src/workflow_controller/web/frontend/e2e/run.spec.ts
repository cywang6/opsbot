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

import { expect, test, type Page } from './fixtures'

const run = {
  run_id: 'e2e-run',
  kind: 'workflow',
  format: 'graph-yaml@1',
  label: 'E2E workflow',
  status: 'paused',
  pause_reason: 'user',
  work_dir: '/tmp/e2e-project',
  created_at: '2026-10-22T00:00:00Z',
  finished_at: null,
  error: null,
}

async function mockRun(page: Page) {
  const actions: string[] = []
  // Playwright dispatches page.route handlers in reverse registration order (newest
  // wins), so the catch-all for resume/export must be registered before the specific
  // /state and /events routes — otherwise it would shadow them with `{ok:true}` and
  // turn the dedicated mocks into dead code.
  await page.route('**/api/v1/runs/e2e-run/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/export') && route.request().method() === 'POST') {
      // 新契约：POST /export 启动后台导出，返回 task_id
      await route.fulfill({ json: { task_id: 'e2e-task' } })
      return
    }
    if (path.endsWith('/download')) {
      // 下载返回 zip 流；汇总走响应头
      await route.fulfill({
        headers: {
          'X-Export-Members': '1',
          'X-Export-Relations': '0',
          'X-Export-Sessions': '1',
          'X-Export-Complete': 'true',
        },
        body: 'PK',
      })
      return
    }
    if (path.endsWith('/cancel')) {
      await route.fulfill({ status: 200, json: { status: 'cancelled' } })
      return
    }
    if (path.includes('/export/')) {
      // 进度轮询：POST /export 后反复 GET /export/{task_id}
      await route.fulfill({ json: { status: 'done', done: 1, total: 1 } })
      return
    }
    const action = path.split('/').pop() || ''
    actions.push(action)
    await route.fulfill({ status: 200, json: { ok: true } })
  })
  await page.route('**/api/v1/runs/e2e-run', async (route) => {
    await route.fulfill({ json: { run, sessions: [] } })
  })
  await page.route('**/api/v1/runs/e2e-run/state', async (route) => {
    await route.fulfill({ json: { processes: [], metrics: { rounds: 1, queue_depth: 0, deferred: 0, in_flight: 0 }, driver: null } })
  })
  await page.route('**/api/v1/runs/e2e-run/events**', async (route) => {
    await route.fulfill({ json: { events: [], next_cursor: null, has_more: false } })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [] } })
  })
  return actions
}

test('paused Run can be resumed and exported', async ({ page }) => {
  const actions = await mockRun(page)
  await page.goto('/run/e2e-run', { waitUntil: 'domcontentloaded' })

  await expect(page.getByText('E2E workflow')).toBeVisible()
  await page.getByRole('button', { name: '恢复' }).click()
  await expect.poll(() => actions).toContain('resume')

  await page.getByRole('button', { name: '导出' }).click()
  await expect(page.getByText('已导出 1 个会话', { exact: true })).toBeVisible()
})

test('Run load failure exposes a retry action', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/v1/runs/retry-run', async (route) => {
    attempts += 1
    await route.fulfill({ status: 503, json: { detail: 'temporary failure' } })
  })
  await page.route('**/api/v1/runs/retry-run/state', async (route) => {
    await route.fulfill({ status: 503, json: { detail: 'temporary failure' } })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [] } })
  })

  await page.goto('/run/retry-run', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('加载失败，自动重试中')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: '立即重试' })).toBeVisible()
  expect(attempts).toBeGreaterThan(0)
})

test('Graph run projection renders the contributed DAG panel', async ({ page }) => {
  await page.route('**/api/v1/runs/graph-run', async (route) => {
    await route.fulfill({ json: {
      run: { ...run, run_id: 'graph-run', label: 'Graph run', status: 'running', format: 'graph-yaml@1' },
      sessions: [],
    } })
  })
  await page.route('**/api/v1/runs/graph-run/state', async (route) => {
    await route.fulfill({ json: {
      processes: [],
      metrics: { rounds: 1, queue_depth: 0, deferred: 0, in_flight: 0 },
      driver: {
        schema_version: 2,
        workflow: 'E2E DAG',
        status: 'running',
        graph_id: 'graph-e2e',
        nodes: [{ id: 'root', label: 'Root', status: 'running', x: 20, y: 20 }],
        edges: [],
      },
    } })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [{ name: 'graph', enabled: true, manifest: [], run_panels: [
      { format: 'graph-yaml@1', component: 'graph.RunDagPanel', schema_version: 2 },
    ] }] } })
  })
  await page.route('**/api/v1/runs/graph-run/events**', async (route) => {
    await route.fulfill({ json: { events: [], next_cursor: null, has_more: false, limit: 1000 } })
  })

  await page.goto('/run/graph-run', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('E2E DAG', { exact: true })).toBeVisible()
  await expect(page.getByText('运行中', { exact: true }).first()).toBeVisible()
  // insight 渲染内核：投影节点 → 主图 SVG（代带 + 节点卡）
  await expect(page.locator('.dag-container svg.graph-dag')).toBeVisible()
  await expect(page.locator('.graph-dag text').filter({ hasText: 'root' })).toBeVisible()
})

test('Run panels follow the dark theme and scroll inside bounded containers', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const sessions = Array.from({ length: 60 }, (_, i) => ({
    session_id: `session-${String(i).padStart(3, '0')}`,
    role: 'executor',
    context: `node=node-${i}`,
    state: 'running',
    stop_reason: null,
    in_flight: false,
  }))
  const processes = Array.from({ length: 60 }, (_, i) => ({
    proc_id: `process-${i}`,
    context: `node=node-${i}`,
    returncode: null,
  }))
  const nodes = Array.from({ length: 30 }, (_, i) => ({
    id: `node-${i}`,
    status: i === 0 ? 'running' : 'pending',
    task_type: i === 0 ? 'generator' : 'bash',
    display_type: i === 0 ? 'agent' : 'bash',
    depends_on: i ? [`node-${i - 1}`] : [],
    subgraph_node_ids: i === 0 ? ['child'] : null,
    attempts: 1,
    gen: 0,
  }))
  const events = Array.from({ length: 400 }, (_, i) => ({
    id: i + 1,
    run_id: 'overflow-run',
    source: 'run_events',
    context: `node=node-${i % 30}`,
    timestamp: `2026-11-04T19:00:${String(i % 60).padStart(2, '0')}Z`,
    event_type: i === 0 ? 'node_history' : 'process_output',
    data: i === 0
      ? { node_id: 'node-0', gen: 0, attempt: 1, status: 'passed', output: 'historic output', started_at: '2026-11-04T19:00:00Z' }
      : { line: `output line ${i}` },
  }))

  await page.route('**/api/v1/runs/overflow-run', async (route) => {
    await route.fulfill({ json: {
      run: { ...run, run_id: 'overflow-run', label: 'Overflow run', status: 'running' },
      sessions,
    } })
  })
  await page.route('**/api/v1/runs/overflow-run/state', async (route) => {
    await route.fulfill({ json: {
      processes,
      metrics: { rounds: 1, queue_depth: 0, deferred: 0, in_flight: 60 },
      driver: {
        schema_version: 2,
        workflow: 'Overflow DAG',
        status: 'running',
        graph_id: 'overflow-graph',
        nodes,
        edges: [],
        subgraphs: [{
          parent_node: 'node-0',
          status: 'passed',
          nodes: [{ id: 'child', status: 'passed', task_type: 'bash', display_type: 'bash', depends_on: [], attempts: 1, gen: 0 }],
        }],
      },
    } })
  })
  await page.route('**/api/v1/runs/overflow-run/events**', async (route) => {
    await route.fulfill({ json: { events, next_cursor: '400', limit: 1000 } })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [{ name: 'graph', enabled: true, manifest: [], run_panels: [
      { format: 'graph-yaml@1', component: 'graph.RunDagPanel', schema_version: 2 },
    ] }] } })
  })

  await page.goto('/run/overflow-run', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Overflow DAG', { exact: true })).toBeVisible()
  await expect(page.locator('.run-events .vlog-line').first()).toBeVisible()
  await expect(page.locator('.dag-container')).toHaveCSS('background-color', 'rgb(22, 27, 34)')
  await expect(page.locator('.run-panel .n-card-content')).toHaveCSS('height', '600px')
  await expect(page.locator('.graph-dag text').filter({ hasText: 'node-0' }).first())
    .toHaveCSS('fill', 'rgb(240, 246, 252)')
  await expect(page.getByText('overflow-run', { exact: true })).toHaveCSS('color', 'rgb(139, 148, 158)')
  await expect(page.locator('.run-events .ev-run').first()).toHaveCSS('color', 'rgb(88, 166, 255)')
  await page.locator('.run-events .ev-run').last().hover()
  await expect(page.locator('.run-events .ev-run').last()).toHaveCSS('background-color', 'color(srgb 0.345098 0.65098 1 / 0.12)')
  await expect(page.locator('.run-members span[style*="--workflow-controller-text-muted"]').filter({ hasText: 'node=node-0' }).first())
    .toHaveCSS('color', 'rgb(139, 148, 158)')

  await page.getByText('子图 ▸', { exact: true }).click()
  // 子图弹窗（insight 内核 NModal 版）：玻璃容器 + 子图画布渲染子节点
  const dialog = page.locator('.subgraph-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.graph-dag text').filter({ hasText: 'child' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  // 节点点击 → 右侧运行历史侧栏（时间线 attempt 卡，不再走弹窗）
  await page.locator('.run-panel .graph-dag text').filter({ hasText: 'node-0' }).first().click()
  const detail = page.locator('.run-node-detail')
  await expect(detail).toBeVisible()
  await expect(detail.getByText('第 1 次', { exact: true })).toBeVisible()
  await page.locator('.run-node-detail .icon-btn').click()
  await expect(detail).toHaveCount(0)

  async function expectVerticalScroll(selector: string) {
    const container = page.locator(selector)
    const size = await container.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }))
    expect(size.clientHeight, selector).toBeGreaterThan(0)
    expect(size.scrollHeight, selector).toBeGreaterThan(size.clientHeight)
    await container.evaluate((el) => { el.scrollTop = 120 })
    expect(await container.evaluate((el) => el.scrollTop), selector).toBeGreaterThan(0)
  }

  await expectVerticalScroll('.run-members .n-data-table-base-table-body .n-scrollbar-container')
  await expectVerticalScroll('.run-processes .n-data-table-base-table-body .n-scrollbar-container')
  await expectVerticalScroll('.run-events .vlog')
  // 相机模型画布：容器不滚动（平移/缩放替代），内容仍被约束在面板边界内
  const dagBox = page.locator('.dag-container')
  const dagSize = await dagBox.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }))
  expect(dagSize.clientHeight).toBeGreaterThan(0)
  expect(dagSize.scrollHeight).toBe(dagSize.clientHeight)
  const documentHeight = await page.locator('html').evaluate((el) => el.scrollHeight)
  expect(documentHeight).toBeLessThan(2400)
  await page.screenshot({ path: testInfo.outputPath('run-detail-dark.png'), fullPage: true })

  await page.locator('html').evaluate((el) => {
    el.ownerDocument.defaultView?.localStorage.setItem('workflow-controller-appearance-theme', 'github-light')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Overflow DAG', { exact: true })).toBeVisible()
  await expect(page.locator('.dag-container')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('.graph-dag text').filter({ hasText: 'node-0' }).first())
    .toHaveCSS('fill', 'rgb(31, 35, 40)')
  await expect(page.getByText('overflow-run', { exact: true })).toHaveCSS('color', 'rgb(101, 109, 118)')
  await expect(page.locator('.run-events .ev-run').first()).toHaveCSS('color', 'rgb(9, 105, 218)')
  await page.locator('.run-events .ev-run').last().hover()
  await expect(page.locator('.run-events .ev-run').last()).toHaveCSS('background-color', 'color(srgb 0.0352941 0.411765 0.854902 / 0.12)')
  await page.screenshot({ path: testInfo.outputPath('run-detail-light.png'), fullPage: true })
})

// RV-04 的导出 mock 骨架（设计文档 §7.2）：注册顺序遵循顶部注释——通配 catch-all
// 先注册，专用 /export* 路由后注册（newest wins），否则被 {ok:true} shadow。
async function mockExportRun(page: Page, opts: {
  poll: () => Record<string, unknown>
  onCancel?: () => void
}) {
  await page.route('**/api/v1/runs/wf-e2e-export/**', async (route) => {
    if (new URL(route.request().url()).pathname.includes('/export')) {
      throw new Error('export paths must be served by the dedicated routes below')
    }
    await route.fulfill({ status: 200, json: { ok: true } })
  })
  await page.route('**/api/v1/runs/wf-e2e-export', async (route) => {
    await route.fulfill({ json: { run: { ...run, run_id: 'wf-e2e-export', label: 'E2E export run' }, sessions: [] } })
  })
  await page.route('**/api/v1/runs/wf-e2e-export/state', async (route) => {
    await route.fulfill({ json: { processes: [], metrics: { rounds: 1, queue_depth: 0, deferred: 0, in_flight: 0 }, driver: null } })
  })
  await page.route('**/api/v1/runs/wf-e2e-export/events**', async (route) => {
    await route.fulfill({ json: { events: [], next_cursor: null, has_more: false } })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [] } })
  })
  await page.route('**/api/v1/runs/wf-e2e-export/export', async (route) => {
    await route.fulfill({ status: 200, json: { task_id: 't-1' } })
  })
  await page.route('**/api/v1/runs/wf-e2e-export/export/t-1', async (route) => {
    await route.fulfill({ json: opts.poll() })
  })
  await page.route('**/api/v1/runs/wf-e2e-export/export/t-1/cancel', async (route) => {
    opts.onCancel?.()
    await route.fulfill({ json: { status: 'cancelled' } })
  })
}

test('Run export can be cancelled while it is running', async ({ page }) => {
  // RV-04（①故障注入：取消需要让导出停在 running 态，真实后端不可确定性造）
  let cancelled = false
  await mockExportRun(page, {
    poll: () => (cancelled
      ? { status: 'cancelled' }
      : { status: 'running', done: 1, total: 3 }),
    onCancel: () => { cancelled = true },
  })

  await page.goto('/run/wf-e2e-export', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('E2E export run')).toBeVisible()

  await page.getByRole('button', { name: '导出' }).click()
  await expect(page.getByText('正在导出 1/3 个会话…')).toBeVisible()
  await page.getByRole('button', { name: '取消' }).click()
  await expect(page.getByText('已取消导出')).toBeVisible()
  // cancelled 是终态：弹层停留，由用户手动关闭
  await page.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByText('导出工作流包')).toBeHidden()
})

test('Run export failure surfaces the backend error until dismissed', async ({ page }) => {
  // RV-04（①故障注入：轮询 error 态透传后端格式化错误，弹层手动关闭）
  await mockExportRun(page, {
    poll: () => ({ status: 'error', error: '磁盘空间不足' }),
    onCancel: () => {},
  })

  await page.goto('/run/wf-e2e-export', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('E2E export run')).toBeVisible()

  await page.getByRole('button', { name: '导出' }).click()
  const modal = page.locator('.n-modal').filter({ hasText: '导出工作流包' })
  await expect(modal).toBeVisible()
  await expect(modal.getByText('磁盘空间不足')).toBeVisible()
  // error 是终态：弹层停留，由用户手动关闭
  await modal.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByText('导出工作流包')).toBeHidden()
})

test('node history folds duplicate attempts by generation and keeps the latest output', async ({ page }) => {
  // RV-08（②形态：同 node 多 (gen,attempt) 历史回放）——insight 内核：逐代
  // 带列 + attempt 时间线；同 (gen,attempt) 的事件流折叠保留末次输出
  const runId = 'history-run'
  const historyEvent = (id: number, gen: number, attempt: number, output: string) => ({
    id, run_id: runId, source: 'run_events', context: 'node=worker',
    timestamp: `2026-11-05T10:00:0${id}Z`, event_type: 'node_history',
    data: { node_id: 'worker', gen, attempt, status: 'passed', output, started_at: '2026-11-05T10:00:00Z' },
  })
  await page.route(`**/api/v1/runs/${runId}`, route => route.fulfill({ json: {
    run: { ...run, run_id: runId, label: 'History run', status: 'completed' }, sessions: [],
  } }))
  await page.route(`**/api/v1/runs/${runId}/state`, route => route.fulfill({ json: {
    processes: [], metrics: null,
    driver: {
      schema_version: 2, workflow: 'History DAG', status: 'completed', graph_id: 'history-graph',
      nodes: [
        { id: 'worker', status: 'passed', task_type: 'bash', display_type: 'bash', depends_on: [], attempts: 2, gen: 0 },
        { id: 'worker', status: 'passed', task_type: 'bash', display_type: 'bash', depends_on: [], attempts: 1, gen: 1 },
      ],
      edges: [],
    },
  } }))
  await page.route(`**/api/v1/runs/${runId}/events**`, route => route.fulfill({ json: {
    events: [
      historyEvent(1, 0, 1, 'stale attempt output'),
      historyEvent(2, 0, 1, 'latest attempt output'),
      historyEvent(3, 0, 2, 'second attempt output'),
      historyEvent(4, 1, 1, 'next generation output'),
    ],
    next_cursor: null, limit: 1000,
  } }))
  await page.route('**/api/v1/plugins', route => route.fulfill({ json: { plugins: [
    { name: 'graph', enabled: true, manifest: [], run_panels: [
      { format: 'graph-yaml@1', component: 'graph.RunDagPanel', schema_version: 2 },
    ] },
  ] } }))

  await page.goto(`/run/${runId}`, { waitUntil: 'domcontentloaded' })
  // 两代并列（第 1 次运时代带 + 回滚 #1 代带）
  await expect(page.locator('.graph-dag text').filter({ hasText: '第 1 次运行' })).toBeVisible()
  await expect(page.locator('.graph-dag text').filter({ hasText: '回滚 #1' })).toBeVisible()

  // 点击第 1 次运时代的 worker → 侧栏时间线两次尝试
  await page.locator('.graph-dag text').filter({ hasText: 'worker' }).first().click()
  const detail = page.locator('.run-node-detail')
  await expect(detail).toBeVisible()
  await expect(detail.locator('.attempt-card')).toHaveCount(2)
  await expect(detail.getByText('第 2 次', { exact: true })).toBeVisible()
  // 同 (gen,attempt) 事件折叠：保留末次输出，旧输出不残留
  await expect(detail.getByText('latest attempt output', { exact: true })).toBeVisible()
  await expect(detail.getByText('second attempt output', { exact: true })).toBeVisible()
  await expect(detail.getByText('stale attempt output')).toHaveCount(0)

  // 回滚 #1 代带的 worker → 下一代尝试（承接关系/单次尝试）
  await page.locator('.graph-dag text').filter({ hasText: 'worker' }).nth(1).click()
  await expect(detail.getByText('next generation output', { exact: true })).toBeVisible()
  await expect(detail.locator('.attempt-card')).toHaveCount(1)
})

test('invalid event cursors show inline retry and recover to the empty state', async ({ page }) => {
  // RV-10（①故障注入：422 非法游标 + 手动重试；不弹 toast）
  const runId = 'invalid-cursor-run'
  let failEvents = true
  let eventRequests = 0
  await page.route(`**/api/v1/runs/${runId}`, route => route.fulfill({ json: {
    run: { ...run, run_id: runId, label: 'Invalid cursor run', status: 'completed' }, sessions: [],
  } }))
  await page.route(`**/api/v1/runs/${runId}/state`, route => route.fulfill({ json: {
    processes: [], metrics: null, driver: null,
  } }))
  await page.route(`**/api/v1/runs/${runId}/events**`, async route => {
    eventRequests += 1
    if (failEvents) {
      await route.fulfill({ status: 422, json: { detail: 'invalid cursor' } })
      return
    }
    await route.fulfill({ json: { events: [], next_cursor: null, limit: 200 } })
  })
  await page.route('**/api/v1/plugins', route => route.fulfill({ json: { plugins: [] } }))

  await page.goto(`/run/${runId}`, { waitUntil: 'domcontentloaded' })
  const stream = page.locator('.run-event-stream')
  await expect(stream.getByText('事件流加载失败')).toBeVisible({ timeout: 10_000 })
  await expect(stream.getByRole('button', { name: '重试' })).toBeVisible()
  expect(eventRequests).toBeGreaterThan(1)

  failEvents = false
  await stream.getByRole('button', { name: '重试' }).click()
  await expect(stream.getByText('暂无事件')).toBeVisible()
  await expect(stream.getByText('事件流加载失败')).toHaveCount(0)
})
