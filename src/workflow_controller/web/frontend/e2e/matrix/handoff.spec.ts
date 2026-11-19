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

// 特性矩阵 e2e · 交接域（设计文档 workflow-controller-e2e-testcase-development.md
// §2.4/§6.2/§6.7/§7.3）：E4 强制交接基线 + MX-01 阈值自动交接 + SD-07 会话链导航
// + SD-08 交接操作三按钮反馈。断言原则：用户可见状态 + /api/breather/state
// 回读回证。非强制「交接」按钮曾因 showHandoff=!breatherEnabled 与 tab
// 显隐互斥而恒不可达（11e21c04 重构遗留），已随本批修复恢复 UI 点击路径。
//
// E2E_LIVE=1 时为 live 环境（无 shim），整文件跳过（MX-01 的 live 镜像
// 评估结论见设计文档 §6.7——暂不镜像，见 docs 修订记录）。
test.skip(IS_LIVE, 'E2E_LIVE=1 时为 live 环境（无 shim），shim 矩阵用例不运行')

test('E4 claude_cli 强制交接：handoff agent 产出文档后接续 worker 完成', async ({ page }) => {
  // 交接链路环节多（停旧 worker → handoff agent → 接续 worker），放宽
  // 单测超时；worker 每轮 1.5s × 30 轮预算，保证交互期间会话持续运行。
  test.setTimeout(120_000)
  const project = await createProject('e4-handoff', { handoff: true })
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'handoff-keep-running', {
    project, reviewer: true, maxIterations: 30,
  })
  await detail.expectStatus('运行中')

  // worker 持续迭代中强制交接：边界处停旧 worker → handoff agent 写
  // 交接文档 → 起接续 worker 读文档后完成。
  await detail.openHandoffTab()
  await detail.forceHandoff()

  // 旧 worker 被 breather 停止并恢复为可复用空闲态（stop_reason 不落
  // handoff_triggered，「已交接」标签只出现在 run 成员行的该语义下）。
  await detail.expectStatus('空闲')
  await detail.expectLastHandoffSucceeded()
  // 交接链下钻：接续 worker 读交接文档后继续任务直至完成。
  await detail.openHandoffChain()
  await detail.expectStatus('已完成')
})

test('MX-01 breather 阈值自动交接：高用量读数驱动交接链自动完成', async ({ page }) => {
  // handoff-auto 场景每轮上报 input 900K / 窗口 1M（breather config.yaml
  // 的 context_window）= 90% > 70% 阈值：第 1 轮 loop 边界 breather 自动
  // 触发交接，全程不点「强制」（§7.3）。链路环节多（停旧 worker →
  // handoff agent → 接续 worker），且各环节都是 shim 快速回合，可能在
  // 打开 tab 前就整体完成——断言只锚定终态。
  test.setTimeout(150_000)
  const project = await createProject('mx01-auto-handoff', { handoff: true })
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'handoff-auto', {
    project,
    reviewer: true, maxIterations: 5,
  })
  await detail.openHandoffTab()

  // 「最近一次交接」收敛为成功：自动交接真实发生（非强制的阈值路径）。
  await detail.expectLastHandoffSucceeded(90_000)
  // 旧 worker 被 breather 停止并恢复为可复用空闲态（与 E4 强制路径同终态）。
  await detail.expectStatus('空闲')
  // API 回读回证：交接收敛后 breather 状态无在途标记。
  await expect.poll(async () => {
    const res = await page.request.get(`/api/breather/state?session_id=${detail.sessionId()}`)
    if (!res.ok()) return 'request-failed'
    const d = await res.json()
    return `${d.pending}/${d.force_pending}/${d.finalizing}`
  }, { timeout: 30_000, intervals: [1_000] }).toBe('false/false/false')

  // 交接链下钻：接续 worker 读交接文档后继续任务直至完成。
  await detail.openHandoffChain()
  await detail.expectStatus('已完成')
})

test('SD-07 会话链 tab 导航：前序/后续会话卡跳转与最近一次交接成功态', async ({ page }) => {
  // E4 相同的强制交接跑道（独立项目）。交接完成后经「会话交接」tab 的
  // 前序/后续会话卡在链上往返跳转——卡片行点击是 openSession(/session/:id)，
  // 数据源为服务端 handoff 关系账（重进页面回读回证）。
  test.setTimeout(150_000)
  const project = await createProject('sd07-chain', { handoff: true })
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'handoff-keep-running', {
    project, reviewer: true, maxIterations: 30,
  })
  await detail.expectStatus('运行中')
  await detail.openHandoffTab()
  await detail.forceHandoff()
  await detail.expectStatus('空闲')
  await detail.expectLastHandoffSucceeded()

  // 重进链头 origin：最近一次交接呈成功态；后续会话卡的第一行是 handoff
  // agent 会话（{id}-handoff-1）；链头无前序会话卡（以后续卡可见为加载
  // 完成前提，避免空载时的空通过）。
  const originId = detail.sessionId()
  await page.goto(`/session/${originId}`)
  await detail.openHandoffTab()
  await detail.expectLastHandoffSucceeded()

  const successorCard = page.locator('.n-card:not(.session-sidebar-card)').filter({ hasText: '后续会话' })
  await expect(successorCard).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.n-card:not(.session-sidebar-card)').filter({ hasText: '前序会话' })).toHaveCount(0)
  await successorCard.getByText('-handoff-1', { exact: false }).click()
  await expect.poll(() => detail.sessionId(), { timeout: 15_000 }).not.toBe(originId)

  // handoff agent 页：前序会话卡跳回链头（行内「←」即 openSession(origin)）。
  await detail.openHandoffTab()
  const predecessorCard = page.locator('.n-card:not(.session-sidebar-card)').filter({ hasText: '前序会话' })
  await expect(predecessorCard).toBeVisible()
  await predecessorCard.getByText('←', { exact: true }).click()
  await expect.poll(() => detail.sessionId(), { timeout: 15_000 }).toBe(originId)

  // 再沿链下钻到接续 worker（agent 的后续会话行 {id}-continue-1），断言链尾完成。
  await detail.openHandoffTab()
  await successorCard.getByText('-handoff-1', { exact: false }).click()
  await expect.poll(() => detail.sessionId(), { timeout: 15_000 }).not.toBe(originId)
  await detail.openHandoffTab()
  await successorCard.getByText('-continue-1', { exact: false }).click()
  await detail.expectStatus('已完成')
})

test('SD-08 交接操作反馈：阈值判定两分支与重置交接回读', async ({ page }) => {
  // 三按钮反馈（§6.2）：低用量（pass-first：input 128/1M = 0%）与用量
  // 未知（usage-unknown：usage 字段非法，探测子进程沿 state.json 同样
  // 上报无效读数）两个阈值判定分支 + 重置交接闭环。「交接已触发」分支
  // 已由 E4 覆盖。
  test.setTimeout(90_000)
  const lowProject = await createProject('sd08-low-usage')
  await switchProject(page, lowProject.dir)
  const low = await startSession(page, 'pass-first', { project: lowProject })
  const lowId = low.sessionId()
  await low.expectStatus('已完成')
  await low.openHandoffTab()

  // 交接操作卡（worker 角色 + breather 启用态）：「交接」与「强制」按钮
  // 均可达（showHandoff 的 !breatherEnabled 死条件已修复——按钮随 会话交接
  // tab 渲染，手动阈值检查入口恢复）。
  const actionsCard = page.locator('.n-card:not(.session-sidebar-card)').filter({ hasText: '交接操作' })
  await expect(actionsCard).toBeVisible({ timeout: 15_000 })
  const handoffButton = page.getByTitle('检查上下文用量，超过阈值时触发交接')
  await expect(handoffButton).toBeVisible()

  // 低用量分支：真实点击「交接」→ 阈值判定不满足 → toast 如实报告读数
  //（pass-first 会话 usage 128 / 窗口 1M → 0% ≤ 70%）。
  await handoffButton.click()
  await low.toast('未触发交接 — 上下文 0% ≤ 阈值')

  // 用量未知分支：usage-unknown 场景的已记录读数与探测子进程均无效 →
  // toast「上下文用量未知，暂无法判断是否达到交接阈值」。
  const unknownProject = await createProject('sd08-usage-unknown')
  await switchProject(page, unknownProject.dir)
  const unknown = await startSession(page, 'usage-unknown', { project: unknownProject })
  await unknown.expectStatus('已完成')
  await unknown.openHandoffTab()
  await page.getByTitle('检查上下文用量，超过阈值时触发交接').click()
  await unknown.toast('上下文用量未知，暂无法判断是否达到交接阈值')

  // 重置交接：idle 会话上点「强制」→ 无 loop 边界收尾，确定性停在待决
  // （交接状态卡呈「待处理」）→「重置交接」按钮出现 → toast + 状态回读归零。
  await page.goto(`/session/${lowId}`)
  await low.openHandoffTab()
  await low.forceHandoff()
  await low.toast('交接已触发（强制）')
  await expect(
    page.locator('.n-card:not(.session-sidebar-card)').filter({ hasText: '交接状态' }).getByText('待处理', { exact: true }),
  ).toBeVisible({ timeout: 15_000 })

  await page.getByTitle('取消强制交接').click()
  await low.toast('交接状态已重置')
  await expect.poll(async () => {
    const res = await page.request.get(`/api/breather/state?session_id=${lowId}`)
    if (!res.ok()) return 'request-failed'
    const d = await res.json()
    return `${d.force_pending}/${d.pending}`
  }, { timeout: 15_000, intervals: [1_000] }).toBe('false/false')
})
