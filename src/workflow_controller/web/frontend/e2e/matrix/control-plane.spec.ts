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
import { createProject, IS_LIVE, switchProject } from './support/env'
import { startSession } from './support/flows'

// 特性矩阵 e2e · 控制面域（设计文档 workflow-controller-e2e-testcase-development.md
// §6.2/§6.7）：控制面四件套真链路（MX-11 暂停→改→继续闭环）、工具调用
// 渲染真链路（MX-12）、reviewer 回复模式切换（SD-09）、普通会话真实删除
// （SD-10 普通段）。断言原则：用户可见状态迁移 + API 回读回证。
//
// E2E_LIVE=1 时为 live 环境（无 shim），整文件跳过（live 层不镜像控制面
// 用例——真模型下长跑道窗口成本过高，见设计文档 §3.4 live 镜像原则）。
test.skip(IS_LIVE, 'E2E_LIVE=1 时为 live 环境（无 shim），shim 矩阵用例不运行')

test('MX-11 控制面真链路：暂停 → 注入 → 恢复 → 继续', async ({ page }) => {
  test.setTimeout(120_000)
  const project = await createProject('mx11-control-plane', { maxIterations: 30 })
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'handoff-keep-running', {
    project, reviewer: false, maxIterations: 30,
  })
  await detail.expectStatus('运行中')

  // 暂停：真实 user_pause。断言用户可见状态 + API 回读双重回证。
  // 暂停态的 SessionInfo 投影是 state=idle + stop_reason=user_pause
  // （前端 getLoopStatusDisplay 按该组合渲染「已暂停」）。
  await detail.pause()
  await detail.expectStatus('已暂停')
  await expect.poll(() => detail.sessionField('state'), { timeout: 15_000 }).toBe('idle')
  await expect.poll(() => detail.sessionField('stop_reason'), { timeout: 15_000 }).toBe('user_pause')

  // 改：暂停态经输入框发送 = 注入 + 自动恢复（send 一次请求完成两件事，
  // 与 X2 的等人分支 send 相区分——本条从 user_pause 断点续跑）。
  const injectedText = 'MX11 补充指令：请继续推进剩余轮次'
  await detail.send(injectedText)
  await detail.toast('消息已发送')

  // 继续：注入被消费——事件流出现 log_manual（inject_prompt 落账留痕），
  // 会话回到运行中，注入后的轮次继续推进。
  await detail.expectStatus('运行中')
  await expect.poll(async () => {
    const res = await page.request.get(
      `/api/v1/events?session_id=${detail.sessionId()}&limit=200`)
    if (!res.ok()) return false
    const data = await res.json()
    return (data.events || []).some(
      (e: { event_type: string; data?: { prompt?: string } }) =>
        e.event_type === 'log_manual' && (e.data?.prompt || '').includes(injectedText))
  }, { timeout: 30_000, intervals: [1_000] }).toBe(true)

  // 单独的「恢复」入口：再暂停一次后走头部恢复按钮（区别于 send 自动恢复）。
  await detail.pause()
  await detail.expectStatus('已暂停')
  await detail.resume()
  await detail.toast('已恢复')
  await detail.expectStatus('运行中')

  // 收尾：经 session stop 端点停掉长跑道会话，不留运行中会话污染后续用例。
  await page.request.post(`/api/v1/sessions/${detail.sessionId()}/stop`)
  await expect.poll(() => detail.sessionField('loop_status'), { timeout: 30_000 }).toBe('no')
})

test('MX-12 工具调用真链路：tool_use 配对渲染、失败标识与孤立结果', async ({ page }) => {
  const project = await createProject('mx12-tool-loop')
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'tool-loop', { project })
  await detail.expectStatus('已完成')

  const log = page.locator('.vlog')
  // 成功对 + 失败对的折叠块标题（`[时间] 工具名 ▸`）。
  const okTitle = log.locator('.tool-block-title').filter({ hasText: 'Bash' })
  const failTitle = log.locator('.tool-block-title').filter({ hasText: 'Read' })
  await expect(okTitle).toBeVisible({ timeout: 15_000 })
  await expect(failTitle).toBeVisible()
  // 失败块：折叠态即带 ✗ 前缀标红（title.failed；标题时间戳为完整日期）。
  await expect(failTitle).toHaveText(/^✗ \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] Read ▸$/)
  await expect(failTitle).toHaveClass(/failed/)

  // 展开成功块：命令行 + 配对结果（tool_use_id 配对回填）。
  await okTitle.click()
  await expect(log.locator('.tool-block-command').filter({ hasText: '$ echo workflow-controller-e2e-tool-ok' }))
    .toBeVisible()
  await expect(log.locator('.tool-block-result').filter({ hasText: 'workflow-controller-e2e-tool-ok' }))
    .toBeVisible()

  // 展开失败块：is_error 结果标红展示。
  await failTitle.click()
  await expect(
    log.locator('.tool-block-result.failed').filter({ hasText: 'File not found: /nonexistent/e2e-missing.txt' }),
  ).toBeVisible()

  // 孤立 tool_result（无配对 tool_use）：预览行按默认规则渲染，结果不从日志消失。
  await expect(log.getByText('← result').first()).toBeVisible()
  await expect(log.getByText('e2e-orphan-result-payload')).toBeVisible()

  // thinking 折叠块（tool-loop 场景携带）可展开。
  const thinking = log.getByText('Thinking ▸').first()
  await expect(thinking).toBeVisible()

  // Iteration 分隔线（事件流驱动的真实迭代投影）。
  await expect(log.getByText('━━ Iteration 1/3 ━━')).toBeVisible()
})

test('普通工具任务事件不会生成子代理', async ({ page }) => {
  const project = await createProject('regular-tool-task')
  await switchProject(page, project.dir)
  const detail = await startSession(page, 'tool-loop', { project, reviewer: false })
  await detail.expectStatus('已完成')

  const response = await page.request.get(`/api/v1/events?session_id=${detail.sessionId()}&limit=200`)
  expect(response.ok()).toBe(true)
  const { events } = await response.json()
  expect(events.filter((event: { event_type: string }) => event.event_type === 'subagent_start')).toEqual([])
  await expect(page.locator('.topo [data-agent-id="e2e-bash-task-not-agent"]')).toHaveCount(0)
})

test('SD-09 reviewer 回复模式切换闭环：auto 拦截 → manual 发送 → 回读一致', async ({ page }) => {
  test.setTimeout(120_000)
  const project = await createProject('sd09-reviewer-mode', { maxIterations: 30 })
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'handoff-keep-running', {
    project, reviewer: true, maxIterations: 30,
  })
  await detail.expectStatus('运行中')

  // auto 态发送被拦：reviewer enabled + auto 且无等人事件 → 输入框禁用，
  // placeholder 明示须切手动回复（doInject 的 toast 拦截是同一门控的第二道防线）。
  const blocked = page.getByPlaceholder('请切换到手动回复模式再发送消息')
  await expect(blocked).toBeVisible({ timeout: 15_000 })
  await expect(blocked).toBeDisabled()

  // 切到手动：真实 PUT /sessions/{id}/reviewer-mode，按钮态翻转 + 回读。
  await page.getByRole('button', { name: '回复: 自动' }).click()
  await detail.toast('手动回复模式')
  await expect(page.getByRole('button', { name: '回复: 手动' })).toBeVisible()
  await expect.poll(() => detail.sessionField('reviewer_mode')).toBe('manual')

  // manual 态发送成功：事件流出现人工输入记录（log_manual 回证）。
  const sentText = 'SD09 手动模式补充指令'
  await detail.send(sentText)
  await detail.toast('消息已发送')
  await expect.poll(async () => {
    const res = await page.request.get(
      `/api/v1/events?session_id=${detail.sessionId()}&limit=200`)
    if (!res.ok()) return false
    const data = await res.json()
    return (data.events || []).some(
      (e: { event_type: string; data?: { prompt?: string } }) =>
        e.event_type === 'log_manual' && (e.data?.prompt || '').includes(sentText))
  }, { timeout: 30_000, intervals: [1_000] }).toBe(true)

  // 切回 auto：按钮态与 API 回读一致。
  await page.getByRole('button', { name: '回复: 手动' }).click()
  await detail.toast('自动回复模式')
  await expect(page.getByRole('button', { name: '回复: 自动' })).toBeVisible()
  await expect.poll(() => detail.sessionField('reviewer_mode')).toBe('auto')

  await page.request.post(`/api/v1/sessions/${detail.sessionId()}/stop`)
  await expect.poll(() => detail.sessionField('loop_status'), { timeout: 30_000 }).toBe('no')
})

test('SD-10 普通会话删除：确认弹窗文案 + 真实删除回证', async ({ page }) => {
  const project = await createProject('sd10-delete-normal')
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'pass-first', { project })
  await detail.expectStatus('已完成')
  const sessionId = detail.sessionId()

  // 首页侧栏会话行删除入口 → 三态弹窗的普通态文案。Dashboard 运行列表
  // 在 c7a53a78 迁移到侧栏；新建项目内只有本会话一行，first() 无歧义。
  await page.goto('/')
  const row = page.locator('.project-session-row').first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.locator('.history-delete').click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('该会话及其事件记录将被删除。')).toBeVisible()
  await dialog.getByRole('button', { name: '确认删除' }).click()

  await expect(page.getByText('已删除会话').first()).toBeVisible({ timeout: 15_000 })
  // 真实删除回证：会话行消失 + API 投影 404 语义（error: session not found）。
  await expect(row).toHaveCount(0, { timeout: 15_000 })
  const res = await page.request.get(`/api/v1/sessions/${sessionId}`)
  expect(await res.json()).toMatchObject({ error: 'session not found' })
})
