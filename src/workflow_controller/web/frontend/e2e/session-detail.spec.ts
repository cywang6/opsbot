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

// Session Detail（/session/:id）mock 层用例 — 设计文档 §6.2 SD 系列。
// 每条用例注释标明必要性类别（§3.4）：①故障注入/错误路径 ②形态渲染/序列回放。
// 公共依赖面（session/config/plugins/events/breather/子路由默认应答）经
// support/mock-session 收敛；专用子路由在 mockSessionDeps 之后注册（newest wins）。
import { expect, test } from './fixtures'
import { mockSessionDeps, mockSessionPage, sessionPayload, sseBody } from './support/mock-session'

// 事件构造：历史事件按 session_id 过滤后才进 sessionEvents（SessionDetailView
// 的 hist.filter），mock 事件必须带 session_id；rowid 供 thinking 展开键使用。
let eventRowId = 0
function ev(
  sessionId: string,
  event_type: string,
  data: Record<string, unknown>,
  timestamp: string,
  iteration = 1,
) {
  eventRowId += 1
  return { rowid: eventRowId, id: eventRowId, session_id: sessionId, event_type, iteration, timestamp, data }
}

test('long assistant content is truncated inline with a full-text modal and expandable thinking', async ({ page }) => {
  // SD-02（②形态：>200 行长回复真链路构造慢；基础渲染由矩阵层每条用例天然覆盖）
  const sid = 'e2e-sd-long'
  const longText = Array.from({ length: 250 }, (_, i) => `L${i + 1}`).join('\n')
  await mockSessionPage(page, sessionPayload({ id: sid, name: 'SD long session' }), {
    events: [
      ev(sid, 'assistant_message', { content: [{ type: 'text', text: longText }] }, '2026-11-05T10:00:01Z'),
      // 单行 >200 字符：截断为预览行并挂 modal 全文
      ev(sid, 'assistant_message', { content: [{ type: 'text', text: 'A'.repeat(250) }] }, '2026-11-05T10:00:02Z'),
      ev(sid, 'assistant_message', { content: [{ type: 'thinking', thinking: '先分析约束，再动手实现' }] }, '2026-11-05T10:00:03Z'),
    ],
  })
  await expect(page.getByText('SD long session')).toBeVisible()

  // 单行字符护栏：200 字符 + 省略号后缀（全文挂 modal）
  await expect(page.getByText(`${'A'.repeat(200)} …`, { exact: true })).toBeVisible()

  // thinking 折叠块：▸ 折叠态 → 点击展开正文
  await page.getByText('Thinking ▸').click()
  await expect(page.getByText('Thinking ▾')).toBeVisible()
  await expect(page.getByText('先分析约束，再动手实现')).toBeVisible()

  // 行数护栏：只内联前 200 行（MAX_ASSISTANT_LINES），尾部收起为「… 全文」行
  const viewFull = page.getByText('… 共 250 行，点击查看全文')
  await viewFull.scrollIntoViewIfNeeded()
  await viewFull.click()
  await expect(page.getByText('完整内容')).toBeVisible()
  await expect(page.locator('.log-modal-pre')).toContainText('L250')
  await page.keyboard.press('Escape')
  await expect(page.getByText('完整内容')).toBeHidden()
})

test('manual-mode banner clears once a manual reply lands', async ({ page }) => {
  // SD-04（②序列回放：question 分支真链路已由矩阵 X2 覆盖，只回放事件序列边界）
  const sid = 'e2e-session-actions'
  const waiting = ev(sid, 'log_auto', { decision: 'waiting_for_input', reason: 'manual_mode' }, '2026-11-04T00:00:01Z')
  await mockSessionPage(page, sessionPayload({ id: sid }), { events: [waiting] })

  await expect(page.getByText('📝 手动回复模式 — 在下方输入框输入指令继续')).toBeVisible()

  // 补一条更晚的 log_manual（模拟人工回复）：横幅消失、placeholder 复原
  await page.route('**/api/v1/events?*', (route) => route.fulfill({ json: { events: [
    waiting,
    ev(sid, 'log_manual', {}, '2026-11-04T00:00:05Z'),
  ] } }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByText('📝 手动回复模式 — 在下方输入框输入指令继续')).toBeHidden()
  await expect(page.getByPlaceholder('输入消息并按 Enter 发送...')).toBeVisible()
})

test('context usage bar renders the three payload shapes', async ({ page }) => {
  // SD-05（②形态：三形态一次测完，真链路只能逐个慢造）
  const sid = 'e2e-sd-context'
  await mockSessionDeps(page, sessionPayload({ id: sid, context_window: 100000 }))
  await page.route('**/api/v1/events?*', (route) => route.fulfill({ json: { events: [
    ev(sid, 'context_usage', {
      context_usage: {
        input_tokens: 60000, output_tokens: 10000,
        cache_read_input_tokens: 10000, cache_creation_input_tokens: 5000,
      },
    }, '2026-11-05T10:00:02Z'),
  ] } }))
  await page.goto(`/session/${sid}`, { waitUntil: 'domcontentloaded' })

  // ① 有效读数：五段条（零宽段不渲染，此处五段均非零）+ 窗口口径百分比
  await expect(page.locator('.context-breakdown-bar')).toHaveAttribute('aria-label', '上下文已使用 85%')
  await expect(page.locator('.context-breakdown-bar span')).toHaveCount(5)
  for (const label of ['Input', 'Output', 'Cache read', 'Cache write', 'Free space']) {
    await expect(page.locator('.context-breakdown-row').filter({ hasText: label })).toBeVisible()
  }
  await expect(page.locator('.context-breakdown-total')).toHaveText('85.0K / 100.0K')

  // ② 无任何读数：未知态文案，不出现 0% 分段条
  await page.route(`**/api/v1/sessions/${sid}`, (route) =>
    route.fulfill({ json: sessionPayload({ id: sid, context_window: null }) }))
  await page.route('**/api/v1/events?*', (route) => route.fulfill({ json: { events: [] } }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByText('上下文用量未知 — 等待模型上报')).toBeVisible()
  await expect(page.locator('.context-breakdown')).toHaveCount(0)

  // ③ 超窗：⚠ 标记 + 百分比封顶 100%（Free space 归零后只剩 Input 段）
  await page.route(`**/api/v1/sessions/${sid}`, (route) =>
    route.fulfill({ json: sessionPayload({ id: sid, context_window: 100000 }) }))
  await page.route('**/api/v1/events?*', (route) => route.fulfill({ json: { events: [
    ev(sid, 'context_usage', {
      context_usage: { input_tokens: 120000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }, '2026-11-05T10:00:03Z'),
  ] } }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('.context-over')).toHaveText('⚠ 超窗')
  await expect(page.locator('.context-breakdown-bar')).toHaveAttribute('aria-label', '上下文已使用 100%')
})

test('subagent topology tree archives orphaned agents at the iteration boundary', async ({ page }) => {
  // SD-06（②形态：shim 无子代理事件，嵌套/归档形态只能回放）
  const sid = 'e2e-sd-topo'
  await mockSessionPage(page, sessionPayload({ id: sid, name: 'SD topo session' }), {
    config: { reviewer: { enabled: true, timeout_seconds: 60, mode: 'auto' } },
    events: [
      ev(sid, 'subagent_start', { agent_id: 'sa-1', agent_type: 'reviewer' }, '2026-11-05T10:00:01Z'),
      // 嵌套子代理：parent_agent_id 指向 sa-1（dispatch 边改挂到父节点下）
      ev(sid, 'subagent_start', { agent_id: 'sa-2', agent_type: 'general-purpose', parent_agent_id: 'sa-1' }, '2026-11-05T10:00:02Z'),
      ev(sid, 'subagent_stop', { agent_id: 'sa-1', agent_type: 'reviewer', total_tokens: 1200, content: '审查完成' }, '2026-11-05T10:00:03Z'),
      // reviewer 节点由 log_auto 的 stop hook 决策事件驱动（let_exit → completed）
      ev(sid, 'log_auto', { hook: 'stop_hook_llm', decision: 'let_exit' }, '2026-11-05T10:00:04Z'),
      // 归档边界：iteration_end 后仍 running 的 sa-2 被归档为 stopped
      ev(sid, 'iteration_end', {}, '2026-11-05T10:00:05Z'),
    ],
  })

  const topoCard = page.locator('.agent-topology-card')
  await expect(topoCard).toBeVisible()
  await expect(topoCard.getByText('2 子代理')).toBeVisible()
  await expect(topoCard.getByText('1 已停止')).toBeVisible()

  // 树：Reviewer / Main Agent / 两级子代理；状态经节点 title 断言
  await expect(page.locator('.topo [data-agent-id="reviewer"] .topo-node-title'))
    .toHaveAttribute('title', 'Reviewer (completed)')
  await expect(page.locator('.topo [data-agent-id="main"] .topo-node-title'))
    .toHaveAttribute('title', 'Main Agent (idle)')
  await expect(page.locator('.topo [data-agent-id="sa-1"]')).toHaveAttribute('data-depth', '1')
  await expect(page.locator('.topo [data-agent-id="sa-1"] .topo-node-title'))
    .toHaveAttribute('title', 'reviewer (completed)')
  // sa-2 无 stop 事件：嵌套挂载在 sa-1 下（depth 2）且被归档为 stopped
  await expect(page.locator('.topo [data-agent-id="sa-2"]')).toHaveAttribute('data-depth', '2')
  await expect(page.locator('.topo [data-agent-id="sa-2"] .topo-node-title'))
    .toHaveAttribute('title', 'general-purpose (stopped)')
})

test('workflow member resume button explains each rejection reason', async ({ page }) => {
  // SD-11（②状态组合回放：多分支状态矩阵真链路造态慢）
  const sid = 'e2e-sd-resume'
  const main = sessionPayload({ id: sid, run_id: 'e2e-run-11', project_dir: '/tmp/e2e-project' })
  const runRow = (status: string) => ({
    run: {
      run_id: 'e2e-run-11', kind: 'workflow', format: 'graph-yaml@1', label: 'E2E resume run',
      status, pause_reason: null, work_dir: '/tmp/e2e-project',
      created_at: '2026-11-05T00:00:00Z', finished_at: null, error: null,
    },
    sessions: [],
  })
  const mockStream = async (list: unknown[]) => {
    await page.route('**/api/v1/events/stream', (route) => route.fulfill({
      contentType: 'text/event-stream',
      body: sseBody([['session_update', list]]),
    }))
  }
  const mockRun = async (status: string | 'missing') => {
    await page.route('**/api/v1/runs/e2e-run-11', (route) => {
      if (status === 'missing') return route.fulfill({ status: 404, json: { detail: 'run 不在记录' } })
      return route.fulfill({ json: runRow(status) })
    })
  }

  await mockSessionDeps(page, main)
  await mockStream([main])
  await mockRun('paused')
  await page.goto(`/session/${sid}`, { waitUntil: 'domcontentloaded' })

  // run paused：成员恢复被拒，指向 run 面恢复
  const paused = page.getByTitle('所属 Run 已暂停，请先恢复整个 Run')
  await expect(paused).toBeVisible()
  await expect(paused).toBeDisabled()

  // run 终态：重启续跑入口在 Run 页
  await mockRun('completed')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTitle('所属 Run 已结束，请到 Run 页重启续跑')).toBeDisabled()

  // run 运行中 + 同目录已有另一 run 的运行中会话：双写者冲突拒绝
  await mockRun('running')
  await mockStream([main, sessionPayload({
    id: 'e2e-sd-other', name: '同目录运行中会话', state: 'running', stop_reason: null,
    run_id: null, project_dir: '/tmp/e2e-project',
  })])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTitle('同目录已有运行中的会话，无法恢复')).toBeDisabled()

  // run 行 404（已删）：无 run 面可指路，直通 session 面可用
  await mockRun('missing')
  await mockStream([main])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTitle('恢复会话')).toBeEnabled()
})

test('failed send refills the prompt input instead of dropping it', async ({ page }) => {
  // SD-13（①故障注入：send 500 → 输入回填不丢失 + 错误 toast）
  const sid = 'e2e-sd-send'
  await mockSessionDeps(page, sessionPayload({ id: sid, name: 'SD send session' }))
  await page.route(`**/api/v1/sessions/${sid}/send`, (route) =>
    route.fulfill({ status: 500, json: { detail: '后端过载' } }))
  await page.goto(`/session/${sid}`, { waitUntil: 'domcontentloaded' })

  const input = page.getByPlaceholder('输入消息并按 Enter 发送...')
  await expect(input).toBeVisible()
  await input.fill('请继续推进任务')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByText('错误: Error: 后端过载')).toBeVisible()
  await expect(input).toHaveValue('请继续推进任务')
})

test('watchdog alert badge counts fault events and opens the alert popover', async ({ page }) => {
  // SD-14（②形态：真实告警需 subagent 超时等慢条件；告警来自事件流 fault.* 事件，
  // payload 为 Alert.to_dict()（watchdog/state.py），非独立 REST 端点）
  const sid = 'e2e-sd-watchdog'
  await mockSessionPage(page, sessionPayload({ id: sid, name: 'SD watchdog session' }), {
    events: [
      ev(sid, 'fault.subagent_timeout', {
        alert_id: 'alert-1', rule: 'subagent_timeout', severity: 'error', session_id: sid,
        message: '子代理 reviewer 运行超时', agent_id: 'sa-1', agent_type: 'reviewer',
        started_at: '2026-11-05T09:00:00', elapsed_seconds: 900, threshold_seconds: 600,
        timestamp: '2026-11-05T09:15:00',
      }, '2026-11-05T09:15:00Z'),
      ev(sid, 'fault.file_stall', {
        alert_id: 'alert-2', rule: 'file_stall', severity: 'warning', session_id: sid,
        message: '追踪文件连续未变化', file_path: 'logs/log.md', stall_count: 3,
        timestamp: '2026-11-05T09:16:00',
      }, '2026-11-05T09:16:00Z'),
    ],
  })
  await expect(page.getByText('SD watchdog session')).toBeVisible()

  // 头部徽标：title 计数 + 红色计数 span
  const badge = page.getByTitle('2 条告警')
  await expect(badge).toBeVisible()
  await expect(badge.getByText('2', { exact: true })).toBeVisible()

  // 弹层：共 N 条 + 规则卡（subagent_timeout 已运行/阈值、file_stall 连续未变化）+ 上传入口
  await badge.click()
  await expect(page.getByText('共 2 条告警')).toBeVisible()
  await expect(page.getByText('subagent_timeout', { exact: true })).toBeVisible()
  await expect(page.getByText('file_stall', { exact: true })).toBeVisible()
  await expect(page.getByText('15m', { exact: true })).toBeVisible()
  await expect(page.getByText('10m', { exact: true })).toBeVisible()
  await expect(page.getByText('3 次', { exact: true })).toBeVisible()
  await expect(page.getByText('logs/log.md')).toBeVisible()
  await expect(page.getByRole('button', { name: '上传现场到 Context Bay' })).toBeVisible()
})

test('missing session renders the not-found empty state', async ({ page }) => {
  // SD-16（①错误路径：GET /sessions/{id} 404 → 会话未找到终态，区别于 loading）
  const sid = 'e2e-sd-missing'
  await mockSessionDeps(page, sessionPayload({ id: sid }))
  // newest wins：覆盖 mockSessionDeps 的 GET 默认应答，返回 404
  await page.route(`**/api/v1/sessions/${sid}`, (route) =>
    route.fulfill({ status: 404, json: { detail: 'session not found' } }))
  await page.goto(`/session/${sid}`, { waitUntil: 'domcontentloaded' })

  await expect(page.getByText('会话未找到')).toBeVisible()
  await expect(page.getByRole('button', { name: '返回仪表盘' })).toBeVisible()
})

test('session sidebar collapses and remembers its resized width across reloads', async ({ page }) => {
  // SD-15（②形态：纯 UI 折叠、拖拽与 localStorage 持久化）
  await page.setViewportSize({ width: 1440, height: 900 })
  const sid = 'e2e-sd-sidebar'
  await mockSessionPage(page, sessionPayload({ id: sid, name: 'SD sidebar session' }))
  const sidebar = page.locator('.session-sidebar-card')
  const output = page.locator('.session-output-card')
  await expect(sidebar).toBeVisible()
  const outputWidth = (await output.boundingBox())!.width

  await page.getByTitle('折叠侧栏').click()
  await expect(sidebar).toBeHidden()
  await expect(page.getByTitle('展开侧栏')).toBeVisible()
  expect((await output.boundingBox())!.width).toBeGreaterThan(outputWidth)
  await page.getByTitle('展开侧栏').click()
  await expect(sidebar).toBeVisible()

  const resizer = page.getByRole('separator', { name: '调整右侧面板宽度' })
  await expect(resizer).toHaveAttribute('aria-valuenow', '340')
  const box = await resizer.boundingBox()
  const startX = box!.x + box!.width / 2
  await page.mouse.move(startX, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(startX - 60, box!.y + box!.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect(resizer).toHaveAttribute('aria-valuenow', '400')
  await expect.poll(() => page.evaluate(() =>
    (globalThis as any).localStorage.getItem('workflow-controller-session-sidebar-width'))).toBe('400')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('separator', { name: '调整右侧面板宽度' }))
    .toHaveAttribute('aria-valuenow', '400')
  await expect(sidebar).toHaveCSS('width', '400px')
})

test('subagent hints can be registered and cleared through the session panel', async ({ page }) => {
  // SD-17（②形态：请求形状 + 面板状态；真链路无额外用户可见增量）
  const sid = 'e2e-sd-hints'
  let hints: Record<string, string[]> = {}
  let postBody: Record<string, unknown> = {}
  let deleteUrl = ''
  await mockSessionDeps(page, sessionPayload({ id: sid, name: 'SD hint session' }))
  await page.route(`**/api/v1/sessions/${sid}/agents`, route =>
    route.fulfill({ json: { agents: ['reviewer'] } }))
  await page.route(`**/api/v1/sessions/${sid}/subagent-hint`, async route => {
    if (route.request().method() === 'POST') {
      postBody = JSON.parse(route.request().postData() || '{}')
      hints = { reviewer: [String(postBody.hint)] }
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.fulfill({ json: { hints } })
  })
  await page.route(`**/api/v1/sessions/${sid}/subagent-hint/*`, async route => {
    if (route.request().method() === 'DELETE') {
      deleteUrl = route.request().url()
      hints = {}
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.fallback()
  })

  await page.goto(`/session/${sid}`, { waitUntil: 'domcontentloaded' })
  await page.getByText('子代理控制', { exact: true }).click()
  const card = page.locator('.n-card:not(.session-sidebar-card)')
    .filter({ hasText: '子代理补充指令（可选）' })
  await card.locator('.n-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: 'reviewer' }).click()
  await card.getByPlaceholder('补充指令：如根因 + 修复结论').fill('超时根因已定位，下一轮缩短评审范围')
  await card.getByRole('button', { name: '登记' }).click()

  await expect.poll(() => postBody).toMatchObject({
    subagent_type: 'reviewer', hint: '超时根因已定位，下一轮缩短评审范围',
  })
  await expect(card.getByText('reviewer #1')).toBeVisible()
  await expect(card.getByText('超时根因已定位，下一轮缩短评审范围')).toBeVisible()

  await card.getByRole('button', { name: '清除' }).click()
  await expect.poll(() => deleteUrl).toContain(`/sessions/${sid}/subagent-hint/reviewer?index=0`)
  await expect(card.getByText('尚未登记补充指令')).toBeVisible()
})

test('terminal stop reason and session error are visible in the detail header', async ({ page }) => {
  // SD-18（②形态：终态文案渲染；真实终态迁移由 E/X 系列覆盖）
  const sid = 'e2e-sd-terminal'
  const error = 'worker exited: checkpoint stream was interrupted'
  await mockSessionPage(page, sessionPayload({
    id: sid, name: 'SD terminal session', state: 'idle', loop_status: 'no',
    stop_reason: 'handoff_triggered', error,
  }))

  await expect(page.locator('.n-tag').filter({ hasText: '已交接' })).toBeVisible()
  await expect(page.locator('.session-detail-shell').getByText(error, { exact: true }))
    .toBeVisible()
})
