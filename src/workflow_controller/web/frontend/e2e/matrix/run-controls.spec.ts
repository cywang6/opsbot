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

import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { SessionDetailPO } from './pom/SessionDetailPO'
import { createProject, IS_LIVE, switchProject, uiTimeout } from './support/env'
import { startGraphRun } from './support/flows'

// 特性矩阵 e2e · Run 工作流域（设计文档 workflow-controller-e2e-testcase-development.md
// §6.3/§6.5/§6.7）：E3 回滚基线 + 成员表/成员级控制/成员定向注入/指标进程表
// /run 级组控/删除/事件流/DAG 面板真链路。长跑道用例用 graph-longrun 模板
// （graph-slow-write 场景前 10 轮每轮 2s 慢速推进，给 run 面交互留窗口）。
//
// 断言口径（§4）：用户可见状态迁移 + API 回读回证（/runs/{id}、
// /runs/{id}/state、/events?session_id=），状态等待一律 expect.poll，不 sleep。
//
// E2E_LIVE=1 时为 live 环境（无 shim），整文件跳过。
test.skip(IS_LIVE, 'E2E_LIVE=1 时为 live 环境（无 shim），shim 矩阵用例不运行')

/** 取 run 的成员 session 列表（API 投影，用于精确定位成员行）。 */
export async function runMembers(
  page: import('@playwright/test').Page, runId: string,
): Promise<Array<{ session_id: string; role: string; state: string; stop_reason: string | null }>> {
  const res = await page.request.get(`/api/v1/runs/${runId}`)
  expect(res.ok()).toBeTruthy()
  const data = await res.json()
  return data.sessions
}

/** 等 worker 成员出现并达到指定状态（graph run 的节点会话按需轮询）。 */
export async function awaitMember(
  page: import('@playwright/test').Page, runId: string,
  predicate: (m: { session_id: string; role: string; state: string }) => boolean,
  timeout = 60_000,
) {
  await expect.poll(async () => {
    const members = await runMembers(page, runId)
    return members.find(predicate)?.session_id ?? ''
  }, { timeout, intervals: [1_000] }).toBeTruthy()
  return (await runMembers(page, runId)).find(predicate)!.session_id
}

test('E3 claude_cli 工作流回滚：验收重试耗尽后回滚到祖先节点', async ({ page }) => {
  const project = await createProject('e3-rollback', { graph: true })
  await switchProject(page, project.dir)

  const runView = await startGraphRun(page, project)
  await runView.expectDagPanelVisible('e2e-rollback')
  // worker-a 前 2 次尝试验收失败（产物 attempt-1/2），重试耗尽触发回滚；
  // 回滚后代数重跑产出 attempt-3 通过验收，run 收敛到终态。
  await runView.expectRollbackHappened()
  await runView.expectCompleted()
})

// ── 本文件私有断言助手（poll 体只做 API 投影读取）──────────────────

/** 成员实时态（/runs/{id} sessions 投影；成员不在投影返回空串）。 */
async function memberState(page: Page, runId: string, sessionId: string): Promise<string> {
  const members = await runMembers(page, runId)
  return members.find(m => m.session_id === sessionId)?.state ?? ''
}

/** 成员暂停态判定：池内 state 始终为 idle（run 投影直透 facts.state），
 * 暂停语义 = idle + stop_reason user_pause（与 SessionInfo 同口径）。 */
async function memberPaused(page: Page, runId: string, sessionId: string): Promise<boolean> {
  const members = await runMembers(page, runId)
  const m = members.find(x => x.session_id === sessionId)
  return !!m && m.state === 'idle' && m.stop_reason === 'user_pause'
}

/** run 记录状态（poll 体；查无此 run 返回空串）。 */
async function runStatus(page: Page, runId: string): Promise<string> {
  const res = await page.request.get(`/api/v1/runs/${runId}`)
  if (!res.ok()) return ''
  return ((await res.json()).run as { status: string }).status
}

/** RunView 控制条按钮（头部卡内）。成员行内有同名 暂停/恢复/停止 按钮，
 * getByRole 全页定位会撞 strict mode，必须按卡 scope。 */
function controlBarButton(page: Page, label: string) {
  return page.locator('.run-page > .n-card').first()
    .getByRole('button', { name: label, exact: true })
}

/** 成员终态判定（正向清单）。run 收尾后成员会话从池内注销，投影 state
 * 退化为空串——空串即「不再在途」，视作终态。 */
const memberDone = (state: string) =>
  ['', 'idle', 'completed', 'stopped', 'failed'].includes(state)

// ── RV-01/SD-12/RV-02：成员表与成员级控制（graph-longrun 交互窗口）──

test('RV-01 成员表渲染与下钻：真实 graph run 的成员行/列与终态回读', async ({ page }) => {
  test.setTimeout(120_000)
  const project = await createProject('rv01-member-table', { graph: 'longrun' })
  await switchProject(page, project.dir)

  const runView = await startGraphRun(page, project, { maxIterations: 30 })
  const runId = runView.runId()
  // graph 成员会话名不固定，经 API session_id 定位（runMembers 先例）
  const workerId = await awaitMember(page, runId, m => m.state === 'running')

  // 成员 session 卡：表头列（角色/context/状态）+ 成员行（session_id + 角色）
  const membersCard = page.locator('.n-card').filter({ hasText: '成员 session' })
  await expect(membersCard).toBeVisible()
  await expect(membersCard.getByText('角色', { exact: true })).toBeVisible()
  await expect(membersCard.getByText('context', { exact: true })).toBeVisible()
  await expect(membersCard.getByText('状态', { exact: true })).toBeVisible()
  await runView.expectMember(workerId)
  await expect(runView.memberRow(workerId).getByText('executor', { exact: true }))
    .toBeVisible()

  // 行点击下钻 Session Detail，再回 run 面等终态
  await runView.openMember(workerId)
  await expect(page).toHaveURL(new RegExp(`/session/${workerId}$`))
  await page.goto(`/run/${runId}`)
  await runView.expectCompleted()

  // 终态回读回证：全员脱离 running/paused（API 投影与 UI 徽章互证）
  await expect.poll(async () => {
    const members = await runMembers(page, runId)
    return members.length > 0 && members.every(m => memberDone(m.state))
  }, { timeout: 30_000, intervals: [1_000] }).toBe(true)
})

test('SD-12 workflow 成员操作经 run 端点：Session Detail 暂停/恢复（真实）', async ({ page }) => {
  test.setTimeout(120_000)
  const project = await createProject('sd12-member-run-route', { graph: 'longrun' })
  await switchProject(page, project.dir)

  const runView = await startGraphRun(page, project, { maxIterations: 30 })
  const runId = runView.runId()
  const workerId = await awaitMember(page, runId, m => m.state === 'running')

  // 成员行下钻 Session Detail（workflow 成员的前端操作自动路由 run 面：
  // useSessions.pause/resume 带 runId → /runs/{rid}/sessions/{sid}/pause。
  // 直通 session 面会被后端 409 拒——状态经 run 面回读真实迁移即证明走对通道）
  await runView.openMember(workerId)
  const detail = new SessionDetailPO(page)
  await detail.expectStatus('运行中')

  // 暂停（title=暂停；run 归属确认前禁用，先等可用）
  const pauseButton = page.getByTitle('暂停')
  await expect(pauseButton).toBeEnabled({ timeout: uiTimeout(15_000) })
  await pauseButton.click()
  await detail.expectStatus('已暂停')
  await expect.poll(() => memberPaused(page, runId, workerId),
    { timeout: 20_000, intervals: [1_000] }).toBe(true)

  // 恢复（title=恢复会话；用户档断点成员 + run 运行中时可用）
  const resumeButton = page.getByTitle('恢复会话')
  await expect(resumeButton).toBeEnabled({ timeout: uiTimeout(15_000) })
  await resumeButton.click()
  await expect.poll(() => memberState(page, runId, workerId),
    { timeout: 20_000, intervals: [1_000] }).toBe('running')

  // 收尾：run 面停止，不留运行中成员污染后续用例
  const res = await page.request.post(`/api/v1/runs/${runId}/stop`)
  expect(res.ok()).toBeTruthy()
  await expect.poll(() => runStatus(page, runId),
    { timeout: 30_000, intervals: [1_000] }).toBe('stopped')
})

test('RV-02 成员级控制与定向注入：行内暂停/恢复/注入/停止（真实）', async ({ page }) => {
  test.setTimeout(120_000)
  const project = await createProject('rv02-member-control', { graph: 'longrun' })
  await switchProject(page, project.dir)

  const runView = await startGraphRun(page, project, { maxIterations: 30 })
  const runId = runView.runId()
  const workerId = await awaitMember(page, runId, m => m.state === 'running')
  await runView.expectMember(workerId)

  // 行内「暂停」→ run 面回读成员迁移 paused（run 平面唯一写者通道）
  await runView.memberControl(workerId, '暂停')
  await expect.poll(() => memberPaused(page, runId, workerId),
    { timeout: 20_000, intervals: [1_000] }).toBe(true)

  // 行内「恢复」→ 慢速回合继续（回读 running）
  await runView.memberControl(workerId, '恢复')
  await expect.poll(() => memberState(page, runId, workerId),
    { timeout: 20_000, intervals: [1_000] }).toBe('running')

  // 「注入」→ 成员定向注入弹窗 → 提交 → log_manual 事件回证（注入留痕）
  await runView.openInject(workerId)
  const marker = 'RV02 定向注入内容'
  await runView.submitInject(marker)
  await expect(page.getByText('已注入成员').first())
    .toBeVisible({ timeout: uiTimeout(10_000) })
  await expect.poll(async () => {
    const res = await page.request.get(`/api/v1/events?session_id=${workerId}&limit=200`)
    if (!res.ok()) return false
    const data = await res.json()
    return (data.events || []).some(
      (e: { event_type: string; data?: { prompt?: string } }) =>
        e.event_type === 'log_manual' && (e.data?.prompt || '').includes(marker))
  }, { timeout: 30_000, intervals: [1_000] }).toBe(true)

  // 行内「停止」→ 成员终态；成员停止只落 graph 断点，再停 run 收尾防残留
  await runView.memberControl(workerId, '停止')
  await expect.poll(async () => memberDone(await memberState(page, runId, workerId)),
    { timeout: 30_000, intervals: [1_000] }).toBe(true)
  await page.request.post(`/api/v1/runs/${runId}/stop`)
  await expect.poll(() => runStatus(page, runId),
    { timeout: 30_000, intervals: [1_000] }).toBe('stopped')
})

// ── RV-05/MX-02/MX-03：run 通用面与组控 ───────────────────────────

test('RV-05 指标与 run 键进程表：运行中在途/退出区分与终态定格', async ({ page }) => {
  test.setTimeout(120_000)
  const project = await createProject('rv05-state-metrics', { graph: 'longrun' })
  await switchProject(page, project.dir)

  const runView = await startGraphRun(page, project, { maxIterations: 30 })
  const runId = runView.runId()
  await awaitMember(page, runId, m => m.state === 'running')

  // 运行窗口内：指标行（轮次/队列/挂起/在途）+ 进程表卡
  await expect(runView.metricsLine()).toBeVisible({ timeout: uiTimeout(15_000) })
  const processes = runView.processesCard()
  await expect(processes).toBeVisible({ timeout: uiTimeout(15_000) })
  // init 进程已退出：API 投影 returncode=0（null=在途），UI 渲染为 0
  await expect.poll(async () => {
    const res = await page.request.get(`/api/v1/runs/${runId}/state`)
    if (!res.ok()) return false
    const state = await res.json()
    return (state.processes || []).some(
      (p: { context?: string; returncode: number | null }) =>
        p.context === 'node=init' && p.returncode === 0)
  }, { timeout: 30_000, intervals: [1_000] }).toBe(true)
  const initRow = processes.locator('.n-data-table-tr')
    .filter({ hasText: 'node=init' }).first()
  await expect(initRow).toBeVisible()
  await expect(initRow.getByText('0', { exact: true })).toBeVisible()

  // 终态定格：run 收尾组杀 run 键进程并清空注册表（kill_processes 逐条弹出），
  // /state 的 processes 归空数组 → UI 进程卡随 v-if 消失；metrics 随 runtime
  // 摘除归 null → 指标行消失。「全部退出」的事实形态即注册表清空，不是
  // 条目留存 returncode 定格（运行窗口内已单独断言过退出码数值）。
  await runView.expectCompleted()
  await expect.poll(async () => {
    const res = await page.request.get(`/api/v1/runs/${runId}/state`)
    if (!res.ok()) return false
    const state = await res.json()
    return (state.processes || []).length === 0 && state.metrics === null
  }, { timeout: 30_000, intervals: [1_000] }).toBe(true)
  await expect(processes).toHaveCount(0)
  await expect(runView.metricsLine()).toHaveCount(0)
})

test('MX-02 run 级暂停/恢复真链路：pause_reason 呈现与恢复收敛（吸收 RV-09）', async ({ page }) => {
  test.setTimeout(150_000)
  const project = await createProject('mx02-run-pause-resume', { graph: 'longrun' })
  await switchProject(page, project.dir)

  const runView = await startGraphRun(page, project, { maxIterations: 30 })
  const runId = runView.runId()
  const workerId = await awaitMember(page, runId, m => m.state === 'running')

  // run 级暂停暂无 UI 入口（RunView 控制条无「暂停」按钮），走 API 面
  const pauseRes = await page.request.post(`/api/v1/runs/${runId}/pause`)
  expect(pauseRes.status()).toBe(202)
  expect(await pauseRes.json()).toMatchObject({ accepted: true })

  // UI：已暂停徽章 + pause_reason 标签（用户暂停）+ 控制条「恢复」
  await runView.expectStatus('已暂停')
  await runView.expectPauseReason('用户暂停')
  await expect(controlBarButton(page, '恢复'))
    .toBeVisible({ timeout: uiTimeout(15_000) })
  // 组控挂起在跑成员（run 面回读）
  await expect.poll(() => memberPaused(page, runId, workerId),
    { timeout: 30_000, intervals: [1_000] }).toBe(true)

  // 恢复 → 慢速回合续跑后收敛完成
  await controlBarButton(page, '恢复').click()
  await expect(page.getByText('run 操作已受理：resume').first())
    .toBeVisible({ timeout: uiTimeout(10_000) })
  await runView.expectStatus('已完成', uiTimeout(120_000))
})

test('MX-03 run 停止与重开续跑：stopped 断点 → 重启收敛完成', async ({ page }) => {
  test.setTimeout(150_000)
  const project = await createProject('mx03-run-stop-restart', { graph: 'longrun' })
  await switchProject(page, project.dir)

  const runView = await startGraphRun(page, project, { maxIterations: 30 })
  const runId = runView.runId()
  await awaitMember(page, runId, m => m.state === 'running')

  // 停止：终态控制无确认弹窗，受理 toast → 徽章 + API 回读双重回证
  await controlBarButton(page, '停止').click()
  await expect(page.getByText('run 操作已受理：stop').first())
    .toBeVisible({ timeout: uiTimeout(10_000) })
  await runView.expectStatus('已停止', uiTimeout(30_000))
  await expect.poll(() => runStatus(page, runId),
    { timeout: 30_000, intervals: [1_000] }).toBe('stopped')

  // 终态控制条换出「重启」；重开续跑（shim 回合计数按 cwd 延续）收敛完成
  await expect(controlBarButton(page, '重启'))
    .toBeVisible({ timeout: uiTimeout(15_000) })
  await controlBarButton(page, '重启').click()
  await expect(page.getByText('run 操作已受理：restart').first())
    .toBeVisible({ timeout: uiTimeout(10_000) })
  await runView.expectStatus('已完成', uiTimeout(120_000))
})

// ── RV-06/RV-07/PL-07：删除 / 事件流 / DAG 面板（E3 快速回滚模板）──

test('RV-06 删除 run：确认弹窗 → 级联删除 → 返回首页与 not-found', async ({ page }) => {
  test.setTimeout(90_000)
  const project = await createProject('rv06-delete-run', { graph: true })
  await switchProject(page, project.dir)

  const runView = await startGraphRun(page, project)
  const runId = runView.runId()
  await runView.expectCompleted()

  // 删除入口 → useConfirm 弹窗（标题「确认删除」，positiveText=删除）
  await controlBarButton(page, '删除').click()
  const dialog = page.locator('.n-dialog').filter({ hasText: '确认删除' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('此操作不可恢复')).toBeVisible()
  await dialog.getByRole('button', { name: '删除' }).click()

  await expect(page.getByText('已删除 run').first())
    .toBeVisible({ timeout: uiTimeout(10_000) })
  await page.waitForURL('/')

  // API 回读：404（幂等级联删除的事实回证）
  const res = await page.request.get(`/api/v1/runs/${runId}`)
  expect(res.status()).toBe(404)

  // 重进 /run/{id}：not-found 文案 + 返回入口
  await page.goto(`/run/${runId}`)
  await expect(page.getByText(/run 不在.+可能已删除/)).toBeVisible()
  await expect(page.getByRole('button', { name: '返回' })).toBeVisible()
})

test('RV-07 事件流增量与全文弹窗：事件行渲染 + 点击弹窗看全文 JSON', async ({ page }) => {
  test.setTimeout(90_000)
  const project = await createProject('rv07-event-stream', { graph: true })
  await switchProject(page, project.dir)

  const runView = await startGraphRun(page, project)
  await runView.expectCompleted()

  // 事件流卡：cursor 排空拉取落到 VirtualLog（run 键事件行 node_state 等）
  const eventsCard = page.locator('.n-card').filter({ hasText: '事件流' })
  const log = eventsCard.locator('.vlog')
  await expect(log.locator('.vlog-clickable').first())
    .toBeVisible({ timeout: uiTimeout(15_000) })
  await expect(log.getByText('node_state').first()).toBeVisible()

  // 点击事件行 → 事件详情弹窗展示全文 JSON
  await log.locator('.vlog-clickable').first().click()
  const modal = page.getByRole('dialog').filter({ hasText: '事件详情' })
  await expect(modal).toBeVisible()
  await expect(modal.locator('.event-json')).toContainText('"event_type"')
})

test('PL-07 RunDagPanel 节点着色与节点历史：回滚代着色 + bash 节点历史弹窗', async ({ page }) => {
  test.setTimeout(90_000)
  const project = await createProject('pl07-dag-panel', { graph: true })
  await switchProject(page, project.dir)

  const runView = await startGraphRun(page, project)
  await runView.expectDagPanelVisible('e2e-rollback')
  await runView.expectRollbackHappened()
  await runView.expectCompleted()

  // 代际带标签：第 1 次运行（gen 0）+ 回滚 #1（重置代）并存
  const dag = page.locator('.dag-container')
  await expect(dag.getByText('第 1 次运行').first())
    .toBeVisible({ timeout: uiTimeout(15_000) })
  await expect(dag.getByText('回滚 #1').first()).toBeVisible()

  // 节点着色（insight 内核状态语义色经 CSS 令牌落进洗染 rect 的计算样式；
  // D6 起 statusColor 为 var() 引用、亮暗双档，断言用 computed fill 并双档兼容）：
  // gen 0 worker-a 失败红 / 重置代 worker-a 通过绿——同一节点两种代际状态
  const RED_FILLS = ['rgb(207, 34, 46)', 'rgb(248, 81, 73)']    // 亮档 #cf222e / 暗档 #f85149
  const GREEN_FILLS = ['rgb(26, 127, 55)', 'rgb(63, 185, 80)']  // 亮档 #1a7f37 / 暗档 #3fb950
  const workerNodes = dag.locator('g.run-node').filter({ hasText: 'worker-a' })
  const workerWashes = workerNodes.locator('rect.run-node-wash')
  await expect(workerWashes.first()).toBeVisible({ timeout: uiTimeout(15_000) })
  const washFills = await workerWashes.evaluateAll(ws => ws.map(w => w.ownerDocument.defaultView!.getComputedStyle(w).fill))
  expect(washFills.some(f => RED_FILLS.includes(f)), `失败红：${washFills.join(', ')}`).toBe(true)
  expect(washFills.some(f => GREEN_FILLS.includes(f)), `通过绿：${washFills.join(', ')}`).toBe(true)
  const initNodes = dag.locator('g.run-node').filter({ hasText: 'init' })
  const initFill = await initNodes.locator('rect.run-node-wash').first()
    .evaluate(w => w.ownerDocument.defaultView!.getComputedStyle(w).fill)
  expect(GREEN_FILLS).toContain(initFill)

  // 点 bash 节点（init）→ 运行历史侧栏：attempt 时间线 + 执行/验收成员行 + 脚本验收
  await dag.locator('.graph-dag text').filter({ hasText: 'init' }).first().click()
  const detail = page.locator('.run-node-detail')
  await expect(detail).toBeVisible()
  await expect(detail.getByText('第 1 次', { exact: true })).toBeVisible()
  await expect(detail.getByText(/执行：/).first()).toBeVisible()
  await expect(detail.getByText(/验收：/).first()).toBeVisible()
  await expect(detail.getByText('脚本 · 通过', { exact: true })).toBeVisible()
})

test('PL-08 运行期模型切换：update_model 回读 + 终态禁止读修复', async ({ page }) => {
  test.setTimeout(150_000)
  const project = await createProject('pl08-update-model', { graph: 'longrun' })
  await switchProject(page, project.dir)

  // arrange：隔离 auth 中增加第二个本地 provider，使 DAG 模型下拉有真实切换目标。
  // 索引动态解析（追加条目落在 keys.length）：boot 还种有其他 runtime 的
  // 种子条目（O 系列的 opencode provider），不得假设初始清单长度。
  const keysRes = await page.request.get('/api/v1/auth/keys')
  expect(keysRes.ok()).toBeTruthy()
  const keys = ((await keysRes.json()).keys || []) as Array<Record<string, unknown>>
  const first = keys[0]
  const secondIndex = keys.length
  const saveRes = await page.request.post('/api/v1/auth/keys', { data: { keys: [
    ...keys.map(k => ({ key: k.key, model: k.model, base_url: k.base_url, runtime: k.runtime })),
    { key: 'sk-e2e-second', model: 'e2e-shim-model-2', base_url: first.base_url, runtime: 'claude_cli' },
  ] } })
  expect(saveRes.ok()).toBeTruthy()

  const runView = await startGraphRun(page, project, { maxIterations: 30 })
  const runId = runView.runId()
  await awaitMember(page, runId, m => m.state === 'running')
  const driverOps: string[] = []
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().endsWith(`/runs/${runId}/driver/op`)) {
      driverOps.push(String(JSON.parse(req.postData() || '{}').op || ''))
    }
  })

  const updateResponse = page.waitForResponse(res =>
    res.request().method() === 'POST'
    && res.url().endsWith(`/runs/${runId}/driver/op`)
    && JSON.parse(res.request().postData() || '{}').op === 'update_model')
  await page.locator('.dag-panel-header .n-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: 'e2e-shim-model-2' }).click()
  const update = await updateResponse
  expect(update.status()).toBe(200)
  expect(await update.json()).toMatchObject({ updated: true, provider_index: secondIndex })
  await expect.poll(async () => {
    const res = await page.request.get(`/api/v1/runs/${runId}/state`)
    if (!res.ok()) return {}
    const driver = (await res.json()).driver || {}
    return { provider_index: driver.provider_index, model: driver.model }
  }, { timeout: 30_000, intervals: [1_000] })
    .toMatchObject({ provider_index: secondIndex, model: 'e2e-shim-model-2' })

  // 终态重载：terminal prop 禁止 reconcile_projection（运行时已摘除，调用必 503）。
  await runView.expectCompleted()
  driverOps.length = 0
  await page.reload({ waitUntil: 'domcontentloaded' })
  await runView.expectDagPanelVisible('e2e-longrun')
  expect(driverOps.filter(op => op === 'reconcile_projection')).toEqual([])
})

test('MX-07 graph 子图与验收节点：子图 DAG 弹窗 + verifier 成员行', async ({ page }) => {
  test.setTimeout(120_000)
  const project = await createProject('mx07-subgraph-verifier', { graph: 'subgraph' })
  await switchProject(page, project.dir)

  const runView = await startGraphRun(page, project)
  const runId = runView.runId()
  await runView.expectCompleted()
  await expect.poll(async () =>
    (await runMembers(page, runId)).some(m => m.role === 'verifier'),
  { timeout: 30_000, intervals: [1_000] }).toBe(true)
  await expect(page.locator('.run-members').getByText('verifier', { exact: true }).first())
    .toBeVisible()

  await page.getByText('子图 ▸', { exact: true }).click()
  // 子图弹窗（insight 内核 NModal 版）：标题锚定生成器 + 子图画布渲染子节点
  const dialog = page.locator('.subgraph-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.filter({ hasText: 'gen-static' })).toBeVisible()
  // 节点标签为全 id（gen-static:sub-worker），v5 起长名两行 tspan 承载——
  // textContent 仍为完整名，前缀锚定不变且更强
  await expect(dialog.locator('.graph-dag text').filter({ hasText: 'gen-static:sub' }))
    .toBeVisible()
})
